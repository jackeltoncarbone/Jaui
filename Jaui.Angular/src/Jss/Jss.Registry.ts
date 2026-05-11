import { Injectable, InjectionToken, signal } from '@angular/core';
import {
  ParseJss,
  type ParsedJss,
  type Stylesheet,
  type Ruleset,
  type AnimationDefinition,
} from 'jaui';

/**
 * Holds the JSS rulesets + var table in scope for a part of the component
 * tree.
 *
 * `<jaui>` provides one at the root. `<jyle>` blocks inside any
 * subtree extend the registry with their parsed content, scoped to their
 * own descendants via DI hierarchy. `<jiv class="X">` walks up the DI tree,
 * finds the nearest registry, and resolves "X" against it.
 *
 * Two tiers:
 *   • Globals — registered once at app boot via RegisterGlobal(). These
 *     are the design-system base classes (JwiftGlass, typography presets,
 *     color tokens) that ANY scoped sheet can extend via `MyThing : Base`.
 *     Held separately so the parser can fall through to them when a base
 *     isn't declared in the local sheet.
 *   • Scoped — registered via MergeSource() from a `<jyle>` projection.
 *     Per-component / per-page rules. These can extend each other (same
 *     sheet, current behavior) AND can extend any global.
 *
 * Registries are mutable bags — a `<jyle>` parses its text content once on
 * mount and merges into the local registry. Re-rendering a `<jyle>` with
 * new content replaces the rules under its own keys (last-wins). Top-level
 * `@Name: value` declarations in the source merge into the var table the
 * same way and are consumed by the Length resolver at property-resolution
 * time.
 *
 * `Version()` is a signal bumped on every `Merge` / `MergeSource`. Consumers
 * (Jiv component) read it inside an `effect(() => ...)` so Angular's
 * reactivity re-runs class resolution when rules change — which is what
 * makes live `.jss` hot-edits apply without a page reload.
 */
@Injectable()
export class JssRegistry {
  /** Class name → routed Ruleset. Lookup is O(1). */
  private _rules = new Map<string, Ruleset>();

  /** Globals tier — base classes the parser can fall through to when a
   *  scoped sheet's `: Base` lookup misses in the local sheet. Stored as
   *  a Stylesheet (not a Map) so it can be passed straight to ParseJss. */
  private _globals: Stylesheet = {};

  /** Var name → unresolved value string. The Length resolver substitutes
   *  `@Name` references against this table at property-resolution time. */
  private _vars = new Map<string, string>();

  /** Animation name → fully-resolved definition. Aggregated from every
   *  parsed sheet (scoped and global). Jiv attaches a reference to this
   *  map so its animation driver can resolve `@Animation Pulse` named
   *  applications declared on its class. */
  private _animations = new Map<string, AnimationDefinition>();

  /** Memoized ParseJss results, keyed by source string. Same `.jss`
   *  module imported repeatedly (re-mounting a page, HMR re-evaluating a
   *  component, multiple `<jaui>` roots) reuses the parsed result instead
   *  of re-walking 16KB+ of source character-by-character. Cleared on
   *  every RegisterGlobal call because parse output depends on the
   *  globals tier — when a new global is added, an extends chain that
   *  previously fell through to runtime defaults could now resolve to the
   *  fresh global. */
  private _parseCache = new Map<string, ParsedJss>();

  private _version = signal(0);

  /** Monotonic version — increments on every merge. Angular effects that
   *  read this will re-run on changes; this is how live JSS edits flow
   *  through to already-mounted `<jiv>` instances. */
  readonly Version = this._version.asReadonly();

  /** The raw var table — handed to the engine so `Length.Resolve` can
   *  substitute `@Name` references during property resolution. */
  get Vars(): Map<string, string> {
    return this._vars;
  }

  /** Animation definition table (name → resolved definition). Handed to
   *  Jiv at construction so its animation driver can resolve named
   *  `@Animation Pulse` applications. */
  get Animations(): ReadonlyMap<string, AnimationDefinition> {
    return this._animations;
  }

  /** Add (or replace) a parsed sheet's contents (+ its var declarations)
   *  in this registry. */
  Merge = (parsed: ParsedJss | Stylesheet): void => {
    // Accept either a full ParsedJss or a bare Stylesheet for back-compat
    // with any direct callers (tests, etc.) still passing pre-var output.
    const isParsed = parsed !== null && typeof parsed === 'object' && 'Sheet' in parsed && 'Vars' in parsed;
    const sheet: Stylesheet = isParsed ? (parsed as ParsedJss).Sheet : (parsed as Stylesheet);
    const vars: Record<string, string> = isParsed ? (parsed as ParsedJss).Vars : {};
    const anims: Record<string, AnimationDefinition> = isParsed && 'Animations' in (parsed as ParsedJss)
      ? (parsed as ParsedJss).Animations
      : {};
    for (const [name, ruleset] of Object.entries(sheet)) {
      this._rules.set(name, ruleset);
    }
    for (const [name, value] of Object.entries(vars)) {
      this._vars.set(name, value);
    }
    for (const [name, def] of Object.entries(anims)) {
      this._animations.set(name, def);
    }
    this._version.update((v) => v + 1);
  };

  /** Add raw JSS source — convenience for `<jyle>` projections. The
   *  globals tier is passed through to the parser so any `: Base`
   *  reference in the source can resolve to a registered global when
   *  it isn't declared in the same sheet. Parse result is cached by
   *  source string identity so re-mounts (or HMR re-runs) skip the
   *  scanner. */
  MergeSource = (source: string): void => {
    if (!source.trim()) return;
    let parsed = this._parseCache.get(source);
    if (!parsed) {
      parsed = ParseJss(source, this._globals);
      this._parseCache.set(source, parsed);
    }
    this.Merge(parsed);
  };

  /** Register a sheet of design-system base classes that ANY later
   *  MergeSource (scoped sheet) can extend via `MyThing : Base`. Call
   *  once per global sheet at app bootstrap (or wherever the design
   *  system gets initialized). Globals are also added to the lookup
   *  map so consumers can use them as direct classes too — e.g.
   *  `class="JwiftGlass MyThing"`. Idempotent on identical content,
   *  but re-registration replaces same-named rules (last-wins). */
  RegisterGlobal = (source: string): void => {
    if (!source.trim()) return;
    // Parse against the existing globals so a global sheet can extend
    // earlier globals (e.g. JwiftSolidGlass : JwiftGlass {...}).
    const parsed = ParseJss(source, this._globals);
    for (const [name, ruleset] of Object.entries(parsed.Sheet)) {
      this._globals[name] = ruleset;
    }
    // Globals shifted — any cached scoped-sheet parse from before this
    // moment may have resolved `: Base` extends to the OLD global state
    // (or fallen through to defaults), so drop the cache. RegisterGlobal
    // typically runs once at app boot, so the clear is rare in practice.
    this._parseCache.clear();
    this.Merge(parsed);
  };

  /** Resolve one or more space-separated class names to a merged Ruleset.
   *  Later classes win on field conflicts (CSS-like). Returns null if no
   *  classes match. */
  Resolve = (classNames: string | null | undefined): Ruleset | null => {
    if (!classNames) return null;
    const out: Ruleset = {};
    let matched = false;
    for (const name of classNames.split(/\s+/).filter(Boolean)) {
      const r = this._rules.get(name);
      if (!r) continue;
      matched = true;
      if (r.Style)         out.Style         = { ...out.Style,         ...r.Style };
      if (r.Layout)        out.Layout        = { ...out.Layout,        ...r.Layout };
      if (r.ChildLayout)   out.ChildLayout   = { ...out.ChildLayout,   ...r.ChildLayout };
      if (r.TextStyle)     out.TextStyle     = { ...out.TextStyle,     ...r.TextStyle };
      if (r.HoverStyle)        out.HoverStyle        = { ...out.HoverStyle,        ...r.HoverStyle };
      if (r.ActiveStyle)       out.ActiveStyle       = { ...out.ActiveStyle,       ...r.ActiveStyle };
      if (r.FocusStyle)        out.FocusStyle        = { ...out.FocusStyle,        ...r.FocusStyle };
      if (r.DisabledStyle)     out.DisabledStyle     = { ...out.DisabledStyle,     ...r.DisabledStyle };
      if (r.HoverTextStyle)    out.HoverTextStyle    = { ...out.HoverTextStyle,    ...r.HoverTextStyle };
      if (r.ActiveTextStyle)   out.ActiveTextStyle   = { ...out.ActiveTextStyle,   ...r.ActiveTextStyle };
      if (r.FocusTextStyle)    out.FocusTextStyle    = { ...out.FocusTextStyle,    ...r.FocusTextStyle };
      if (r.DisabledTextStyle) out.DisabledTextStyle = { ...out.DisabledTextStyle, ...r.DisabledTextStyle };
      if (r.Springs)           out.Springs           = { ...out.Springs,           ...r.Springs };
      if (r.Animations)        out.Animations        = [...(out.Animations ?? []),  ...r.Animations];
    }
    return matched ? out : null;
  };
}

/** DI token for the nearest stylesheet registry. */
export const JSS_REGISTRY = new InjectionToken<JssRegistry>('JSS_REGISTRY');

/** Convenience helper for the `text` loader path:
 *
 *   import jssText from './Home.jss';
 *   const Styles = CompileJss(jssText);
 */
export const CompileJss = (source: string): ParsedJss => ParseJss(source);
