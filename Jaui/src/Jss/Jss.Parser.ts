import { SlotFor } from './Jss.Routes';
import { TERNARY_SENTINEL } from '../Core/Length';
import { AssignStyleWithFilterMerge, MergeFilterValue, FILTER_PROPS } from '../Core/Filter.Parse';
import type { JivStyle } from '../Jiv/Jiv.Types';
import type { LayoutConfig, ChildLayout } from '../Layout/Layout.Types';
import type { TextStyle } from '../Text/Text.Types';
import {
  type SpringConfig,
  type AnimationDefinition,
  type AnimationApplication,
  type AnimationStop,
  type LoopMode,
  TransitionToSpring,
} from '../Animation/Animation.Types';

/**
 * JSS v1 parser — turns `Name { prop: value ... }` rulesets into a
 * pre-routed style map ready to spread into a Jiv.
 *
 * Selectors are bare class names (no leading dot, no # ids, no tag
 * selectors). Identifier-style only: `Toolbar { ... }`, `BackButton { ... }`.
 *
 * Grammar (v1, deliberately minimal — states / nesting / variables /
 * springs / @when come in v2):
 *
 *   Stylesheet  = Ruleset*
 *   Ruleset     = Ident Extends? '{' Declaration* '}'
 *   Extends     = ':' Ident (',' Ident)*
 *   Declaration = Ident ':' Value Terminator
 *   Value       = chars until Terminator, with braces balanced
 *   Terminator  = Newline | ';' | EOF | '}'
 *   Comments    = '//' … newline, or '/* … *​/'
 *
 * Extends flattens at parse time: `Toolbar : LiquidGlass { … }` inlines all
 * fields from `LiquidGlass` first, then overlays Toolbar's own declarations.
 * Multiple bases merge left-to-right (later wins). Extends is NOT runtime
 * stacking — it's a build-time flatten, so the consumer sees one ruleset.
 *
 * Base lookup order: same-sheet first (fast path, what most consumers
 * want), then the optional `globals` argument (design-system base classes
 * registered via JssRegistry.RegisterGlobal). Forward references within a
 * sheet are still an error — declare bases above the consumer, or hoist
 * them into the globals tier.
 *
 * Output per class: `{ Style?, Layout?, ChildLayout?, TextStyle? }` where
 * each property lands in its correct slot according to Jss.Routes. The
 * author never has to annotate slots — writing `Padding: 0.5pt` routes
 * to Layout automatically.
 *
 * Intended to be called at build time by the Vite plugin so the runtime
 * sees already-routed objects and spends zero time parsing JSS.
 */

/** Boolean-expression AST for compound pseudo-selectors authored as
 *  `Name:(expr) { ... }` and for `@If (expr) { ... }` responsive blocks.
 *  `expr` is built from atoms — state names (`Hover`) and viewport
 *  comparisons (`Width > 900`) — combined with `&&`, `||`, `!`, and parens.
 *  JSON-serializable by design — the worker bridge ships these across the
 *  main-thread/worker boundary alongside Style. Evaluation is
 *  `(expr, PredicateContext) => boolean`, implemented in Jss.Predicate. */
export type CompareOp = '>' | '>=' | '<' | '<=' | '==' | '!=';

/** What a size comparison measures against. Absent on a `Compare` node ⇒
 *  Viewport (the common case, keeps viewport ASTs minimal):
 *    Viewport            — the canvas/window (CSS px).
 *    Self                — the element's own resolved box.
 *    Parent              — the element's direct parent's resolved box.
 *    Ancestor(Class)     — nearest ancestor carrying `Class`, its resolved box. */
export type SizeScope =
  | { Kind: 'Self' }
  | { Kind: 'Parent' }
  | { Kind: 'Ancestor'; Class: string };

export type PredicateExpr =
  | { Kind: 'State'; Name: string }
  /** Runtime style var (`@Open`, `@Mode == 'NoSidePanel'`) — set by the author via the element's `[vars]`
   *  input, read live by the evaluator. Bare `@Name` is truthy-tested; `@Name ==/!= value` compares. This
   *  is the author-driven conditional (distinct from interaction States like Hover). The `@` prefix is
   *  consistent with JSS vars elsewhere. */
  | { Kind: 'Var'; Name: string; Op?: CompareOp; Value?: string | number }
  /** Size comparison vs a px threshold (number literal or `@Var` resolved at
   *  parse time). `Scope` absent ⇒ the viewport. */
  | { Kind: 'Compare'; Scope?: SizeScope; Metric: 'Width' | 'Height'; Op: CompareOp; Value: number }
  /** Ancestor/parent context — true when an ancestor (any, or the direct
   *  parent when `Direct`) carries `Class`; if `State` is set, that ancestor
   *  must also be in that state. Powers `Ancestor(X)`, `Parent(X)`,
   *  `Ancestor(X):Hover`, and contextual-nesting (`X Y { … }`). */
  | { Kind: 'Ancestor'; Class: string; Direct: boolean; State?: string }
  | { Kind: 'Not'; Expr: PredicateExpr }
  | { Kind: 'And'; Exprs: readonly PredicateExpr[] }
  | { Kind: 'Or';  Exprs: readonly PredicateExpr[] };

/** A `Name:(expr) { ... }` ruleset compiled into a predicate + the styles
 *  to merge when it matches. Source order is preserved (entries authored
 *  later in the sheet override earlier ones on conflicting properties via
 *  Object.assign at apply time, matching the cascade rule used elsewhere).
 *  TextStyle entries carry text-routed declarations (`Color: red` inside
 *  a `:(...)` block) so the runtime can layer them onto EffectiveTextStyle
 *  just like the legacy `*TextStyle` slots. */
export interface PredicateStyle {
  Predicate: PredicateExpr;
  Style?: Partial<JivStyle>;
  TextStyle?: Partial<TextStyle>;
  /** Layout / ChildLayout overrides — populated by `@If` blocks (responsive
   *  breakpoints), which may set ANY property. Pseudo-state blocks (`:Hover`)
   *  only ever carry Style/TextStyle, so these stay undefined there. The
   *  runtime merges them in EffectiveLayout / EffectiveChildLayout when the
   *  predicate matches, exactly as Style rides EffectiveStyle. */
  Layout?: Partial<LayoutConfig>;
  ChildLayout?: Partial<ChildLayout>;
}

export interface Ruleset {
  Style?: Partial<JivStyle>;
  Layout?: Partial<LayoutConfig>;
  ChildLayout?: Partial<ChildLayout>;
  TextStyle?: Partial<TextStyle>;
  /** Pseudo-selector entries. Both tight single-state syntax
   *  `Name:Hover { ... }` and compound predicates
   *  `Name:(Hover && !Disabled) { ... }` route here — the tight form
   *  compiles to a single-state predicate `{ Kind: 'State', Name: 'Hover' }`
   *  so the runtime has ONE evaluation path. Source order is preserved
   *  (last-wins within this tier). Inherited through `extends`
   *  (concatenated, base first). */
  PredicateStyles?: PredicateStyle[];
  /** Per-property spring overrides authored via `@Spring Property { … }`
   *  or `@Transition Property { … }` (which translates to a critically-
   *  damped spring). The style animator reads this map when it builds
   *  the Jiv's per-channel springs; missing properties fall back to the
   *  global defaults. Inherited through `extends` (per-property merge). */
  Springs?: Record<string, Partial<SpringConfig>>;
  /** Animations applied to this class via `@Animation Name` or declared
   *  inline as `@Animation Property { From, To, Duration, Loop }`. The
   *  style animator reads this list each frame to override property
   *  targets along the animation timeline. Source-order preserved so
   *  the cascade can apply last-wins within a tier. Inherited through
   *  `extends` (concatenated, base first). */
  Animations?: AnimationApplication[];
}

export type Stylesheet = Record<string, Ruleset>;

/** Author-declared variables. Values stay as unresolved strings (the
 *  Length parser resolves `@Name` references at property-resolution time
 *  against this table, so declaration order doesn't matter and chained
 *  vars like `@B: @A * 2` work naturally). */
export type VarTable = Record<string, string>;

/** Named animation definitions authored at the top level via
 *  `@Animation Name { ... }`. The runtime looks up applied animations
 *  by name against this table. Forward references are illegal, the
 *  definition must precede any application referencing it. */
export type AnimationTable = Record<string, AnimationDefinition>;

export interface ParsedJss {
  Sheet: Stylesheet;
  Vars: VarTable;
  Animations: AnimationTable;
}

/** Reserved identifiers — engine-provided built-ins that can't be
 *  redeclared as `@Name: …` vars. See `Presence.md`. */
const _RESERVED_IDENTS = new Set(['Presence', 'Entering', 'Exiting']);

// ─── Public API ─────────────────────────────────────────────────────────

/** Parse a JSS source string into a typed stylesheet + var table.
 *  Top-level `@Name: value` declarations populate `Vars`; everything
 *  else (`Name { ... }`) populates `Sheet`.
 *
 *  Optional `globals` map: any base class referenced via `Name : Base`
 *  that isn't declared in this sheet falls back to a lookup here.
 *  JssRegistry passes its globals tier through on every MergeSource so
 *  consumer sheets can extend design-system bases (JwiftGlass, etc.)
 *  without inlining them. */
export const ParseJss = (source: string, globals?: Stylesheet): ParsedJss => {
  const cleaned = _stripComments(source);
  const sheet: Stylesheet = {};
  const vars: VarTable = {};
  const animations: AnimationTable = {};
  const state: _ScanState = { src: cleaned, pos: 0 };
  _skipWs(state);
  while (state.pos < state.src.length) {
    if (state.src[state.pos] === '@') {
      _parseTopLevelAt(state, vars, animations, sheet, globals);
    } else {
      _parseRuleset(state, sheet, globals, vars);
    }
    _skipWs(state);
  }
  _resolveClassRefStops(animations, sheet, globals);
  return { Sheet: sheet, Vars: vars, Animations: animations };
};

// ─── Scanner ────────────────────────────────────────────────────────────

interface _ScanState { src: string; pos: number; }

const _stripComments = (s: string): string => {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const n = s[i + 1];
    if (c === '/' && n === '*') {
      const end = s.indexOf('*/', i + 2);
      if (end < 0) break;
      i = end + 2;
      continue;
    }
    if (c === '/' && n === '/') {
      const end = s.indexOf('\n', i + 2);
      i = end < 0 ? s.length : end;
      continue;
    }
    out += c;
    i++;
  }
  return out;
};

const _skipWs = (s: _ScanState): void => {
  while (s.pos < s.src.length && /\s/.test(s.src[s.pos])) s.pos++;
};

const _readIdent = (s: _ScanState): string => {
  const start = s.pos;
  while (s.pos < s.src.length && /[A-Za-z0-9_]/.test(s.src[s.pos])) s.pos++;
  if (start === s.pos) {
    throw new Error(`[Jaui] Expected identifier at position ${s.pos} in JSS`);
  }
  return s.src.slice(start, s.pos);
};

const _expect = (s: _ScanState, char: string): void => {
  if (s.src[s.pos] !== char) {
    throw new Error(`[Jaui] Expected "${char}" at position ${s.pos} in JSS, got "${s.src[s.pos] ?? 'EOF'}"`);
  }
  s.pos++;
};

// ─── Top-level @ directives ─────────────────────────────────────────────

/** Parse a top-level `@`-rule. Two shapes:
 *    `@Name: value`           - var declaration (any name except reserved).
 *    `@Animation Name { ... }` - named animation definition.
 *  The `@var` keyword was dropped; `@Name:` at top level is already
 *  unambiguous. Other unknown `@Keyword` forms are parse errors. */
const _parseTopLevelAt = (
  s: _ScanState,
  vars: VarTable,
  animations: AnimationTable,
  sheet: Stylesheet,
  globals?: Stylesheet,
): void => {
  _expect(s, '@');
  const name = _readIdent(s);
  _skipWs(s);

  if (name === 'Animation') {
    // Root form: `@Animation Pulse { ... }`.
    const animName = _readIdent(s);
    _skipWs(s);
    const def = _parseAnimationBlock(s, animName);
    if (animations[animName]) {
      throw new Error(`[Jaui] @Animation "${animName}" declared more than once at top level`);
    }
    animations[animName] = def;
    return;
  }

  if (name === 'If') {
    // Top-level responsive group: `@If (cond) { ClassA { … } ClassB { … } }`.
    _parseTopLevelIfWith(s, sheet, globals, vars, undefined);
    return;
  }

  if (s.src[s.pos] !== ':') {
    if (name === 'var') {
      throw new Error(`[Jaui] "@var" is no longer a keyword, declare variables as "@Name: value" directly (drop the "@var" prefix)`);
    }
    throw new Error(`[Jaui] Unexpected "@${name}" at top level, only "@Name: value" vars, "@Animation Name { ... }" definitions, and "@If (cond) { ... }" responsive groups are allowed here`);
  }

  if (_RESERVED_IDENTS.has(name)) {
    throw new Error(`[Jaui] Cannot declare "@${name}: …", "${name}" is a reserved built-in identifier provided by the engine per Jiv. Reference it without the "@" prefix in property values (e.g. "Opacity: ${name}").`);
  }

  s.pos++; // consume ':'
  _skipWs(s);
  const value = _readValue(s);
  vars[name] = value;
  // Sheet and globals threaded through for future top-level rules; not
  // used by var declarations themselves.
  void sheet; void globals;
};

// ─── Rulesets ───────────────────────────────────────────────────────────

const _parseRuleset = (
  s: _ScanState,
  out: Stylesheet,
  globals?: Stylesheet,
  vars?: VarTable,
  /** When set (this ruleset is inside a top-level `@If (cond) { … }`), the
   *  rule's declarations are emitted as a PredicateStyle guarded by `cond`
   *  instead of as base styles, and any inner pseudo/`@If` predicates are
   *  AND-merged with `cond`. */
  guardCond?: PredicateExpr,
): void => {
  // Selector — bare class name(s). A single name is the common case; a
  // space-separated chain (`Ancestor Target { … }`) is contextual nesting:
  // the leading names become Ancestor() guards on the trailing target.
  let className = _readIdent(s);

  // Tight `:State` / `:(expr)` pseudo (no whitespace). Three legal shapes:
  //   `Foo:Hover { ... }`           — single-state pseudo (compiles to a
  //                                   one-atom PredicateStyle below)
  //   `Foo:(Hover && !Disabled){…}` — compound predicate, PredicateStyles
  //   `Foo : Base1, Base2 { ... }`  — extends list (loose colon, has space)
  // Both pseudo forms must come BEFORE the extends check so `Foo:Hover`
  // isn't misread as `Foo extends Hover`. Both forms route to the same
  // PredicateStyles slot so there's ONE evaluation path at runtime.
  let predicate: PredicateExpr | null = null;
  if (s.src[s.pos] === ':') {
    const next = s.src[s.pos + 1];
    if (next === '(') {
      // Compound predicate — `:(expr)` with &&, ||, !, parens.
      s.pos++; // consume ':'
      predicate = _parseParenPredicate(s, className, vars);
    } else if (next && next !== ' ' && next !== '\t' && next !== '\n') {
      // Tight colon — single-state pseudo. Compiles to a one-atom
      // predicate `{ Kind: 'State', Name: stateName }` so the runtime
      // never needs special-cased Hover/Active/Focus/Disabled/GroupHover
      // slots. Any PascalCase identifier works — authors can declare
      // their own states (Loading, Recording, ...).
      s.pos++;
      const stateName = _readIdent(s);
      predicate = { Kind: 'State', Name: stateName };
    }
  }

  _skipWs(s);

  // Contextual nesting — `Ancestor… Target { … }`. After the first name and
  // any tight pseudo, a run of further bare identifiers means descendant
  // context: the trailing name is the target; the leading names (incl. the
  // first) become `Ancestor(Name)` guards AND-merged into this rule (and into
  // any enclosing top-level `@If` guard). Plain descendant semantics — each
  // ancestor must be somewhere above, order not enforced (v1).
  if (!predicate && /[A-Za-z_]/.test(s.src[s.pos] ?? '')) {
    const ancestors: string[] = [className];
    while (/[A-Za-z_]/.test(s.src[s.pos] ?? '')) {
      ancestors.push(_readIdent(s));
      _skipWs(s);
    }
    className = ancestors.pop()!; // trailing name is the target
    let chainGuard: PredicateExpr | undefined;
    for (const a of ancestors) {
      const g: PredicateExpr = { Kind: 'Ancestor', Class: a, Direct: false };
      chainGuard = chainGuard ? _and(chainGuard, g) : g;
    }
    if (chainGuard) guardCond = guardCond ? _and(guardCond, chainGuard) : chainGuard;
  }

  // Optional `: Base1, Base2` extends list (only valid on the base form —
  // not after a pseudo).
  const bases: string[] = [];
  if (!predicate && s.src[s.pos] === ':') {
    s.pos++;
    while (true) {
      _skipWs(s);
      bases.push(_readIdent(s));
      _skipWs(s);
      if (s.src[s.pos] !== ',') break;
      s.pos++;
    }
  }

  _expect(s, '{');

  const own: Ruleset = {};

  while (true) {
    _skipWs(s);
    if (s.src[s.pos] === '}') { s.pos++; break; }
    if (s.pos >= s.src.length) {
      const label = predicate ? ':(...)' : '';
      throw new Error(`[Jaui] Unterminated ruleset "${className}${label}" — missing "}"`);
    }
    if (s.src[s.pos] === '@') {
      _parseRulesetAt(s, own, className, vars);
    } else {
      _parseDeclaration(s, own, vars, className);
    }
  }

  // Pseudo-selector ruleset — both `Foo:Hover` and `Foo:(Hover && !Disabled)`
  // arrive here. Push a PredicateStyle entry onto the class's PredicateStyles
  // list in source order. Last-wins within the tier. Under a top-level `@If`
  // guard, the guard is AND-merged into the pseudo predicate and all four
  // slots are carried (the guarded block may set layout).
  if (predicate) {
    const target = (out[className] ??= {});
    target.PredicateStyles ??= [];
    if (guardCond) {
      const ps = _predicateStyleFromRuleset(_and(guardCond, predicate), own);
      if (ps) target.PredicateStyles.push(ps);
    } else {
      target.PredicateStyles.push({
        Predicate: predicate,
        Style: own.Style,
        TextStyle: own.TextStyle,
      });
    }
    return;
  }

  // Flatten extends: start from empty, merge each base in declared order,
  // then overlay own declarations. Later always wins. Base lookup tries
  // the local sheet first (fast path, what most consumers want), then
  // falls back to the globals tier for design-system bases registered
  // via JssRegistry.RegisterGlobal.
  let ruleset: Ruleset = own;
  if (bases.length > 0) {
    ruleset = {};
    for (const base of bases) {
      const baseRuleset = out[base] ?? globals?.[base];
      if (!baseRuleset) {
        throw new Error(
          `[Jaui] "${className}" extends unknown class "${base}" — declare it earlier in this sheet, or register it as a global with JssRegistry.RegisterGlobal()`,
        );
      }
      ruleset = _mergeRulesets(ruleset, baseRuleset);
    }
    ruleset = _mergeRulesets(ruleset, own);
  }

  // Guarded (inside a top-level `@If`): the rule's base slots become a single
  // PredicateStyle gated by the guard, and any inner pseudo/`@If` predicates
  // are AND-merged with the guard. Springs/Animations only tune, so they
  // merge unconditionally onto the class.
  if (guardCond) {
    const target = (out[className] ??= {});
    target.PredicateStyles ??= [];
    const base = _predicateStyleFromRuleset(guardCond, ruleset);
    if (base) target.PredicateStyles.push(base);
    if (ruleset.PredicateStyles) {
      for (const e of ruleset.PredicateStyles) {
        target.PredicateStyles.push({ ...e, Predicate: _and(guardCond, e.Predicate) });
      }
    }
    if (ruleset.Springs) target.Springs = { ...target.Springs, ...ruleset.Springs };
    if (ruleset.Animations) target.Animations = [...(target.Animations ?? []), ...ruleset.Animations];
    return;
  }

  // If this class appears multiple times in one sheet, merge (later
  // declarations win inside matching slots). Matches CSS cascade behavior.
  const existing = out[className];
  if (existing) {
    out[className] = _mergeRulesets(existing, ruleset);
  } else {
    out[className] = ruleset;
  }
};

/** Build a PredicateStyle from a ruleset's four content slots under a
 *  predicate. Returns null if the ruleset carries no content slots. */
const _predicateStyleFromRuleset = (predicate: PredicateExpr, r: Ruleset): PredicateStyle | null => {
  const ps: PredicateStyle = { Predicate: predicate };
  const has = (o?: object): boolean => !!o && Object.keys(o).length > 0;
  if (has(r.Style)) ps.Style = r.Style;
  if (has(r.TextStyle)) ps.TextStyle = r.TextStyle;
  if (has(r.Layout)) ps.Layout = r.Layout;
  if (has(r.ChildLayout)) ps.ChildLayout = r.ChildLayout;
  return (ps.Style || ps.TextStyle || ps.Layout || ps.ChildLayout) ? ps : null;
};

/** AND two predicate expressions, flattening nested Ands for a tidy tree. */
const _and = (a: PredicateExpr, b: PredicateExpr): PredicateExpr => {
  const exprs: PredicateExpr[] = [];
  const push = (e: PredicateExpr): void => { if (e.Kind === 'And') exprs.push(...e.Exprs); else exprs.push(e); };
  push(a); push(b);
  return { Kind: 'And', Exprs: exprs };
};

/** Inside-ruleset `@` directives. Three supported keywords:
 *    `@Spring Property { Stiffness, Damping, Mass }` - direct spring tune.
 *    `@Spring * { ... }`                    - universal default for every animatable property.
 *    `@Transition Property { Duration, Easing }` - CSS-style shorthand,
 *      translates to a critically-damped spring with matching settle.
 *    `@Animation Name[, Name2, ...]`        - apply named animations (no block, comma-separated).
 *    `@Animation Property { From, To, Duration, Loop }` - inline anonymous. */
const _parseRulesetAt = (s: _ScanState, ruleset: Ruleset, className: string, vars?: VarTable): void => {
  s.pos++; // skip '@'
  const directive = _readIdent(s);
  if (directive === 'If') {
    // Responsive breakpoint block: `@If (cond) { decls }`. Compiles to a
    // PredicateStyle on this ruleset carrying all four content slots.
    _parseBlockIfWith(s, ruleset, className, vars, undefined);
    return;
  }
  if (directive === 'Animation') {
    _parseRulesetAnimation(s, ruleset, className);
    return;
  }
  if (directive !== 'Spring' && directive !== 'Transition') {
    throw new Error(`[Jaui] "${className}" unknown @${directive}; supported: @Spring, @Transition, @Animation, @If.`);
  }
  _skipWs(s);
  // Property name — identifier OR `*` (universal default, @Spring only).
  let property: string;
  if (s.src[s.pos] === '*') {
    if (directive !== 'Spring') {
      throw new Error(`[Jaui] "${className}" @${directive} cannot target "*"; only @Spring supports the universal selector.`);
    }
    property = '*';
    s.pos++;
  } else {
    property = _readIdent(s);
  }
  _skipWs(s);
  _expect(s, '{');
  const raw: Record<string, string> = {};
  while (true) {
    _skipWs(s);
    if (s.src[s.pos] === '}') { s.pos++; break; }
    if (s.pos >= s.src.length) {
      throw new Error(`[Jaui] Unterminated @${directive} ${property} in "${className}", missing "}"`);
    }
    const k = _readIdent(s);
    _skipWs(s);
    _expect(s, ':');
    _skipWs(s);
    raw[k] = _readShortValue(s);
  }
  let spring: Partial<SpringConfig>;
  if (directive === 'Spring') {
    spring = {};
    for (const k of ['Stiffness', 'Damping', 'Mass'] as const) {
      const rv = raw[k];
      if (rv !== undefined) {
        const n = parseFloat(rv);
        if (Number.isNaN(n)) throw new Error(`[Jaui] @Spring ${property}.${k} must be a number, got "${rv}"`);
        spring[k] = n;
      }
    }
  } else {
    // @Transition: strip optional `ms` suffix, translate to a critically
    // damped spring with matching settle time.
    const dStr = raw['Duration'] ?? '';
    const dNum = parseFloat(dStr.replace(/ms$/, ''));
    if (Number.isNaN(dNum)) throw new Error(`[Jaui] @Transition ${property}.Duration must be a number (optionally ms-suffixed), got "${dStr}"`);
    const easing = raw['Easing'] as 'Linear' | 'EaseOut' | 'EaseInOut' | 'Spring' | undefined;
    spring = TransitionToSpring({ Duration: dNum, Easing: easing ?? 'EaseOut', Spring: null });
  }
  // Per-ruleset @Spring > @Transition precedence (spec): if an @Spring entry
  // already exists for this property in THIS ruleset, a later @Transition
  // must not stomp it. We track source kind in a side WeakMap so the
  // Ruleset shape stays clean for downstream consumers.
  ruleset.Springs ??= {};
  const sources = _ensureSpringSources(ruleset);
  const prevKind = sources[property];
  if (prevKind === 'Spring' && directive === 'Transition') return;
  ruleset.Springs[property] = { ...ruleset.Springs[property], ...spring };
  sources[property] = directive;
};

/** Tracks whether each Springs[prop] entry came from @Spring or @Transition.
 *  Used so a later @Transition on the same property within one ruleset
 *  can't stomp an earlier @Spring (spec: @Spring wins on conflict). Kept
 *  off the Ruleset shape so consumers don't see internal bookkeeping. */
const _springSources = new WeakMap<Ruleset, Record<string, 'Spring' | 'Transition'>>();
const _ensureSpringSources = (r: Ruleset): Record<string, 'Spring' | 'Transition'> => {
  let m = _springSources.get(r);
  if (!m) { m = {}; _springSources.set(r, m); }
  return m;
};

/** Like `_readValue` but additionally treats `,` (at paren depth 0) as a
 *  terminator. Used inside `@Spring` / `@Transition` / `@Animation` block
 *  bodies so authors can write keys on a single line:
 *    `@Transition Opacity { Duration: 180ms, Easing: EaseOut }`
 *  The base `_readValue` doesn't handle this because top-level declarations
 *  use `,` inside values like `rgba(0, 0, 0, 0.5)` — parens balance there,
 *  so the depth gate still lets commas inside paren groups through. */
const _readShortValue = (s: _ScanState): string => {
  const start = s.pos;
  let depth = 0;
  while (s.pos < s.src.length) {
    const c = s.src[s.pos];
    if (c === '(') { depth++; s.pos++; continue; }
    if (c === ')') { depth--; s.pos++; continue; }
    if (depth === 0) {
      if (c === '\n' || c === ';' || c === ',') { const v = s.src.slice(start, s.pos).trim(); s.pos++; return v; }
      if (c === '}') { return s.src.slice(start, s.pos).trim(); }
    }
    s.pos++;
  }
  return s.src.slice(start, s.pos).trim();
};

/** Parse `@Animation` inside a class. Three shapes distinguished by what
 *  follows the first identifier:
 *    `@Animation Pulse`                     - apply a single named animation.
 *    `@Animation Pulse, FadeIn`             - apply multiple named animations.
 *    `@Animation Opacity { From, To, ... }` - inline anonymous animation on a property.
 *  The comma form is only valid for named applications; an inline anonymous
 *  with a following comma is a parse error (the spec doesn't define how
 *  multiple inline blocks on one line would compose). */
const _parseRulesetAnimation = (s: _ScanState, ruleset: Ruleset, className: string): void => {
  _skipWs(s);
  const ident = _readIdent(s);
  _skipWs(s);
  ruleset.Animations ??= [];
  if (s.src[s.pos] === '{') {
    // Inline anonymous: `@Animation Opacity { From, To, Duration, Loop }`.
    // `ident` here is the target property name, not an animation name.
    // From/To values are raw property values (not class-refs) and get
    // wrapped under the target property's key in each stop's Values.
    const def = _parseAnimationBlock(s, `${className}.@Animation ${ident}`, ident);
    ruleset.Animations.push({ Kind: 'Inline', Property: ident, Definition: def });
    return;
  }
  // Named application (possibly multi). The identifier is the animation
  // name; lookup is deferred to resolve time so forward references within
  // a single sheet work.
  ruleset.Animations.push({ Kind: 'Named', Name: ident });
  while (s.src[s.pos] === ',') {
    s.pos++;
    _skipWs(s);
    const next = _readIdent(s);
    _skipWs(s);
    if (s.src[s.pos] === '{') {
      throw new Error(`[Jaui] "${className}" @Animation: comma-separated multi-apply only supports named animations; "${next} { ... }" is an inline form and must stand alone on its own @Animation line.`);
    }
    ruleset.Animations.push({ Kind: 'Named', Name: next });
  }
};

/** Parse the `{ Duration: ..., Loop: ..., From: ..., To: ..., 0%: ..., ... }`
 *  body of an animation definition. Used by both the root form (named def)
 *  and the in-class inline form. Stops with class-ref identifiers are
 *  kept as a single `__classRef__` marker on the stop's Values and
 *  resolved in a post-pass once all rulesets are known.
 *
 *  `inlineProperty` distinguishes the two forms:
 *    - undefined: named def at root. From/To values are class-refs or
 *      inline blocks; multi-property semantics apply.
 *    - string: inline anonymous on a class targeting that one property.
 *      From/To values are raw property values, wrapped under that key
 *      in each stop's Values.
 */
const _parseAnimationBlock = (
  s: _ScanState,
  contextLabel: string,
  inlineProperty?: string,
): AnimationDefinition => {
  _expect(s, '{');
  let duration = 0;
  let loop: LoopMode = 'Once';
  let ease: SpringConfig | 'Linear' | null = null;
  const stops: AnimationStop[] = [];
  let fromStop: AnimationStop | null = null;
  let toStop: AnimationStop | null = null;

  while (true) {
    _skipWs(s);
    if (s.src[s.pos] === '}') { s.pos++; break; }
    if (s.pos >= s.src.length) {
      throw new Error(`[Jaui] Unterminated ${contextLabel}, missing "}"`);
    }

    // Peek for a percent stop (`0%`, `100%`, `50%`). Otherwise it's an
    // identifier-keyed declaration (Duration, Loop, From, To, Ease).
    const percentMatch = _tryReadPercent(s);
    if (percentMatch !== null) {
      _skipWs(s);
      // Two value shapes:
      //   `0%: ClassName`        - colon then class-ref or raw value.
      //   `0% { Opacity: 0; ... }` - no colon, inline property block.
      if (s.src[s.pos] === ':') {
        s.pos++;
        _skipWs(s);
      }
      stops.push(_parseStop(s, percentMatch / 100, contextLabel, inlineProperty));
      _consumeTerminator(s);
      continue;
    }

    const key = _readIdent(s);
    _skipWs(s);
    _expect(s, ':');
    _skipWs(s);
    if (key === 'Duration') {
      const v = _readShortValue(s);
      // Accept `ms` or `s` (seconds). Bare numbers are interpreted as ms.
      let n: number;
      if (/s$/.test(v) && !/ms$/.test(v)) {
        n = parseFloat(v.replace(/s$/, '')) * 1000;
      } else {
        n = parseFloat(v.replace(/ms$/, ''));
      }
      if (Number.isNaN(n)) throw new Error(`[Jaui] ${contextLabel}.Duration must be a number (optionally s- or ms-suffixed), got "${v}"`);
      duration = n;
    } else if (key === 'Loop') {
      const v = _readShortValue(s);
      if (v !== 'Once' && v !== 'Repeat' && v !== 'Mirror') {
        throw new Error(`[Jaui] ${contextLabel}.Loop must be Once, Repeat, or Mirror; got "${v}"`);
      }
      loop = v;
    } else if (key === 'Ease') {
      ease = _parseEase(s, contextLabel);
    } else if (key === 'From') {
      fromStop = _parseStop(s, 0, contextLabel, inlineProperty);
      _consumeTerminator(s);
    } else if (key === 'To') {
      toStop = _parseStop(s, 1, contextLabel, inlineProperty);
      _consumeTerminator(s);
    } else {
      throw new Error(`[Jaui] ${contextLabel}: unexpected key "${key}". Expected Duration, Loop, Ease, From, To, or a percent stop.`);
    }
  }

  if (fromStop) stops.push(fromStop);
  if (toStop)   stops.push(toStop);
  // Sort by phase so the runtime can walk in order. Stable sort keeps
  // duplicates in source order so last-wins still holds.
  stops.sort((a, b) => a.Phase - b.Phase);

  if (stops.length < 2) {
    throw new Error(`[Jaui] ${contextLabel} needs at least two stops (From/To or 0%/100%); got ${stops.length}.`);
  }
  if (duration <= 0) {
    throw new Error(`[Jaui] ${contextLabel}.Duration must be > 0, got ${duration}.`);
  }

  return {
    // Name is filled in by the caller (root form has it, inline doesn't need it).
    Name: '',
    Duration: duration,
    Loop: loop,
    Ease: ease,
    Stops: stops,
  };
};

/** Parse one stop body. Three forms accepted, picked by surrounding
 *  context and the next token:
 *    `0%: PulseDim`         class-ref shorthand (named anim, no inlineProperty).
 *    `0% { Opacity: 0, ...}` inline property block (named anim, multi-prop).
 *    `0%: 0.5`              raw value for the targeted property (inline anim).
 *  `inlineProperty` set means we're inside an inline anonymous animation
 *  on the named property, so a bare value should be wrapped as
 *  `{ [inlineProperty]: value }` rather than read as a class-ref. */
const _parseStop = (
  s: _ScanState,
  phase: number,
  contextLabel: string,
  inlineProperty: string | undefined,
): AnimationStop => {
  _skipWs(s);
  if (s.src[s.pos] === '{') {
    // Inline property block. Parsed as a tiny ruleset body, but we keep
    // values as raw strings keyed by property name (the runtime applies
    // them as a Style/Layout/etc patch on top of EffectiveStyle).
    s.pos++; // consume '{'
    const values: Record<string, string> = {};
    while (true) {
      _skipWs(s);
      if (s.src[s.pos] === '}') { s.pos++; break; }
      if (s.pos >= s.src.length) {
        throw new Error(`[Jaui] Unterminated stop block in ${contextLabel}, missing "}"`);
      }
      const k = _readIdent(s);
      _skipWs(s);
      _expect(s, ':');
      _skipWs(s);
      values[k] = _readValue(s);
    }
    return { Phase: phase, Values: values };
  }
  if (inlineProperty !== undefined) {
    // Inline anonymous animation: stop value is the raw value for the
    // single targeted property. _readValue handles numbers, units,
    // colors, and other value forms uniformly.
    const v = _readValue(s);
    return { Phase: phase, Values: { [inlineProperty]: v } };
  }
  // Class-ref shorthand inside a named animation. Mark for post-parse
  // resolution; the resolver flattens the referenced ruleset's
  // Style / Layout / TextStyle / ChildLayout bags into the stop's Values.
  const cls = _readIdent(s);
  return { Phase: phase, Values: { __classRef__: cls } };
};

/** Read a `12.5%` token and return the numeric percent. Returns null when
 *  the next token isn't a percent (so the caller can fall through to an
 *  identifier key like `Duration` or `From`). */
const _tryReadPercent = (s: _ScanState): number | null => {
  const start = s.pos;
  while (s.pos < s.src.length && /[0-9.]/.test(s.src[s.pos])) s.pos++;
  if (s.pos > start && s.src[s.pos] === '%') {
    const n = parseFloat(s.src.slice(start, s.pos));
    s.pos++; // consume '%'
    return n;
  }
  // Not a percent; rewind for the identifier-key path.
  s.pos = start;
  return null;
};

/** Parse an `Ease: ...` value. Forms:
 *    `Ease: Linear`
 *    `Ease: Spring`                                     - spring with defaults
 *    `Ease: Spring(Stiffness: 60, Damping: 22, Mass: 1)` - tuned spring */
const _parseEase = (s: _ScanState, contextLabel: string): SpringConfig | 'Linear' | null => {
  const head = _readIdent(s);
  if (head === 'Linear') {
    // Consume any trailing value bits up to terminator so the outer loop
    // is positioned correctly.
    _readValueRemainder(s);
    return 'Linear';
  }
  if (head !== 'Spring') {
    throw new Error(`[Jaui] ${contextLabel}.Ease must be Linear or Spring(...), got "${head}"`);
  }
  _skipWs(s);
  if (s.src[s.pos] !== '(') {
    // `Spring` with no args, use defaults.
    _readValueRemainder(s);
    return { Stiffness: 170, Damping: 26, Mass: 1 };
  }
  s.pos++; // consume '('
  const raw: Record<string, string> = {};
  while (true) {
    _skipWs(s);
    if (s.src[s.pos] === ')') { s.pos++; break; }
    const k = _readIdent(s);
    _skipWs(s);
    _expect(s, ':');
    _skipWs(s);
    // Read until ',' or ')' or terminator.
    const start = s.pos;
    while (s.pos < s.src.length && s.src[s.pos] !== ',' && s.src[s.pos] !== ')' && s.src[s.pos] !== '\n') s.pos++;
    raw[k] = s.src.slice(start, s.pos).trim();
    _skipWs(s);
    if (s.src[s.pos] === ',') s.pos++;
  }
  _readValueRemainder(s);
  const stiffness = parseFloat(raw['Stiffness'] ?? '170');
  const damping = parseFloat(raw['Damping'] ?? '26');
  const mass = parseFloat(raw['Mass'] ?? '1');
  return { Stiffness: stiffness, Damping: damping, Mass: mass };
};

/** Consume any trailing whitespace / terminator after a value that didn't
 *  use the generic _readValue() consumption (Ease parser walks its own
 *  shape). Stops at newline, `;`, `,`, or the surrounding `}` — so authors
 *  can use any of `; , \n` as a separator between keys on one line. */
const _readValueRemainder = (s: _ScanState): void => {
  while (s.pos < s.src.length) {
    const c = s.src[s.pos];
    if (c === '\n' || c === ';' || c === ',') { s.pos++; return; }
    if (c === '}') return;
    if (!/\s/.test(c)) return;
    s.pos++;
  }
};

/** Consume an optional `;` / `,` / newline terminator after a stop value
 *  that was parsed by a path that doesn't itself consume the terminator
 *  (`_parseStop`, `_parseEase`). Whitespace is skipped both before and
 *  after the terminator so the next iteration of the @Animation block
 *  loop starts cleanly on either the next key or the closing `}`. */
const _consumeTerminator = (s: _ScanState): void => {
  while (s.pos < s.src.length) {
    const c = s.src[s.pos];
    if (c === ' ' || c === '\t') { s.pos++; continue; }
    if (c === ';' || c === '\n' || c === ',') { s.pos++; return; }
    return;
  }
};

/** Post-parse pass: any animation stop whose Values contains the
 *  `__classRef__` sentinel gets flattened by copying every property out
 *  of the referenced ruleset's Style / Layout / TextStyle / ChildLayout
 *  bags. Missing classes throw. Runs once per ParseJss after all
 *  rulesets are known so order-of-declaration within a sheet doesn't
 *  matter for stop refs. */
const _resolveClassRefStops = (
  animations: AnimationTable,
  sheet: Stylesheet,
  globals?: Stylesheet,
): void => {
  for (const name of Object.keys(animations)) {
    const def = animations[name];
    def.Name = name; // backfill the name slot
    for (const stop of def.Stops) {
      const ref = stop.Values['__classRef__'];
      if (ref === undefined) continue;
      const target = sheet[ref] ?? globals?.[ref];
      if (!target) {
        throw new Error(`[Jaui] @Animation "${name}" references unknown class "${ref}". Declare it earlier in the sheet, or register it as a global.`);
      }
      const flat: Record<string, string> = {};
      for (const bag of [target.Style, target.Layout, target.ChildLayout, target.TextStyle]) {
        if (!bag) continue;
        for (const k of Object.keys(bag)) {
          const v = (bag as Record<string, unknown>)[k];
          if (typeof v === 'string') flat[k] = v;
        }
      }
      stop.Values = flat;
    }
  }
  // Inline animations on rulesets also need class-ref resolution. The
  // post-pass walks every ruleset's Animations[] and resolves any inline
  // definitions the same way.
  for (const className of Object.keys(sheet)) {
    const r = sheet[className];
    if (!r.Animations) continue;
    for (const app of r.Animations) {
      if (app.Kind !== 'Inline') continue;
      for (const stop of app.Definition.Stops) {
        const ref = stop.Values['__classRef__'];
        if (ref === undefined) continue;
        const target = sheet[ref] ?? globals?.[ref];
        if (!target) {
          throw new Error(`[Jaui] @Animation inline on "${className}.${app.Property}" references unknown class "${ref}".`);
        }
        const flat: Record<string, string> = {};
        for (const bag of [target.Style, target.Layout, target.ChildLayout, target.TextStyle]) {
          if (!bag) continue;
          for (const k of Object.keys(bag)) {
            const v = (bag as Record<string, unknown>)[k];
            if (typeof v === 'string') flat[k] = v;
          }
        }
        stop.Values = flat;
      }
    }
  }
};

// ─── @If responsive blocks ──────────────────────────────────────────────
//
// `@If (cond) { … }`. Two contexts share one predicate grammar + the
// PredicateStyle pipeline:
//   • Block form, inside a ruleset (`_parseBlockIfWith`) — the block's
//     declarations become a PredicateStyle on that ruleset.
//   • Top-level form, wrapping whole class rulesets (`_parseTopLevelIfWith`)
//     — each contained rule is parsed guarded by the condition.
// Both nest; nested conditions AND-merge with the enclosing one.

/** Parse `@If (cond) { declarations | nested @If }` inside a ruleset. The
 *  `@If` directive ident has already been consumed by `_parseRulesetAt`. */
const _parseBlockIfWith = (
  s: _ScanState,
  ruleset: Ruleset,
  className: string,
  vars: VarTable | undefined,
  baseCond: PredicateExpr | undefined,
): void => {
  _skipWs(s);
  const ownCond = _parseParenPredicate(s, `${className} @If`, vars);
  const cond = baseCond ? _and(baseCond, ownCond) : ownCond;
  _skipWs(s);
  _expect(s, '{');
  const tmp: Ruleset = {};
  while (true) {
    _skipWs(s);
    if (s.src[s.pos] === '}') { s.pos++; break; }
    if (s.pos >= s.src.length) {
      throw new Error(`[Jaui] Unterminated @If block in "${className}", missing "}"`);
    }
    if (s.src[s.pos] === '@') {
      s.pos++;
      const d = _readIdent(s);
      if (d !== 'If') {
        throw new Error(`[Jaui] "${className}" @${d} is not allowed inside @If; only nested @If or declarations.`);
      }
      _parseBlockIfWith(s, ruleset, className, vars, cond);
      continue;
    }
    _parseDeclaration(s, tmp, vars, className);
  }
  const ps = _predicateStyleFromRuleset(cond, tmp);
  if (ps) {
    ruleset.PredicateStyles ??= [];
    ruleset.PredicateStyles.push(ps);
  }
};

/** Parse a top-level `@If (cond) { rulesets | nested @If }`. The `@If`
 *  directive ident has already been consumed by `_parseTopLevelAt`. */
const _parseTopLevelIfWith = (
  s: _ScanState,
  sheet: Stylesheet,
  globals: Stylesheet | undefined,
  vars: VarTable | undefined,
  baseCond: PredicateExpr | undefined,
): void => {
  _skipWs(s);
  const ownCond = _parseParenPredicate(s, '@If (top-level)', vars);
  const cond = baseCond ? _and(baseCond, ownCond) : ownCond;
  _skipWs(s);
  _expect(s, '{');
  while (true) {
    _skipWs(s);
    if (s.src[s.pos] === '}') { s.pos++; break; }
    if (s.pos >= s.src.length) {
      throw new Error('[Jaui] Unterminated top-level @If, missing "}"');
    }
    if (s.src[s.pos] === '@') {
      s.pos++;
      const d = _readIdent(s);
      if (d !== 'If') {
        throw new Error(`[Jaui] @${d} is not allowed inside a top-level @If; only nested @If or class rulesets.`);
      }
      _parseTopLevelIfWith(s, sheet, globals, vars, cond);
      continue;
    }
    _parseRuleset(s, sheet, globals, vars, cond);
  }
};

const _parseDeclaration = (s: _ScanState, ruleset: Ruleset, vars?: VarTable, className = ''): void => {
  const prop = _readIdent(s);
  _skipWs(s);
  _expect(s, ':');
  _skipWs(s);
  let value = _readValue(s);
  value = _maybeEncodeTernary(value, vars, className || prop);
  _assignToSlot(ruleset, prop, value);
};

// ─── Inline ternary values (`cond ? a : b`) ─────────────────────────────
// Compiled at parse time so the worker resolver never imports this parser:
// the condition becomes a PredicateExpr and the whole value is encoded as
// `TERNARY_SENTINEL + JSON({Cond, T, F})`. Branches are recursively encoded so
// chained `a ? x : b ? y : z` works. Core/Length.ResolveTernary decodes.

/** Split `cond ? a : b` at the top-level `?`/`:` (paren-aware, skipping the
 *  `?:` of nested ternaries). Returns null when there's no top-level ternary. */
const _trySplitTernary = (raw: string): { cond: string; t: string; f: string } | null => {
  let pd = 0, q = -1, colon = -1, tn = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '(' || c === '[') pd++;
    else if (c === ')' || c === ']') pd--;
    else if (pd === 0) {
      if (c === '?') { if (q < 0) q = i; else tn++; }
      else if (c === ':' && q >= 0) { if (tn === 0) { colon = i; break; } tn--; }
    }
  }
  if (q < 0 || colon < 0) return null;
  return { cond: raw.slice(0, q).trim(), t: raw.slice(q + 1, colon).trim(), f: raw.slice(colon + 1).trim() };
};

/** Parse a standalone (un-parenthesized) predicate condition string. */
const _parseCondString = (src: string, vars: VarTable | undefined, className: string): PredicateExpr => {
  const st: _ScanState = { src, pos: 0 };
  _skipWs(st);
  const expr = _parsePredOr(st, className, vars);
  _skipWs(st);
  if (st.pos < st.src.length) {
    throw new Error(`[Jaui] "${className}" — unexpected "${src.slice(st.pos)}" in ternary condition "${src}"`);
  }
  return expr;
};

const _maybeEncodeTernary = (raw: string, vars: VarTable | undefined, className: string): string => {
  const split = _trySplitTernary(raw);
  if (!split) return raw;
  const cond = _parseCondString(split.cond, vars, className);
  const t = _maybeEncodeTernary(split.t, vars, className);
  const f = _maybeEncodeTernary(split.f, vars, className);
  return TERNARY_SENTINEL + JSON.stringify({ Cond: cond, T: t, F: f });
};

/** Read a JSS value — everything up to a declaration terminator (newline,
 *  `;`, or the ruleset closing `}`). Balanced braces/parens allowed inside
 *  (e.g. `rgba(1, 2, 3, 0.5)` or `translate(1pt, 2pt)`). */
const _readValue = (s: _ScanState): string => {
  const start = s.pos;
  let depth = 0;
  while (s.pos < s.src.length) {
    const c = s.src[s.pos];
    if (c === '(') { depth++; s.pos++; continue; }
    if (c === ')') { depth--; s.pos++; continue; }
    if (depth === 0) {
      if (c === '\n' || c === ';') { const v = s.src.slice(start, s.pos).trim(); s.pos++; return v; }
      if (c === '}') { return s.src.slice(start, s.pos).trim(); }
    }
    s.pos++;
  }
  return s.src.slice(start, s.pos).trim();
};

// ─── Slot assignment ────────────────────────────────────────────────────

const _FILTER_KEY_SET: ReadonlySet<string> = new Set(FILTER_PROPS);

const _assignToSlot = (ruleset: Ruleset, prop: string, value: string): void => {
  const slot = SlotFor(prop);
  switch (slot) {
    case 'Style': {
      const st = (ruleset.Style ??= {});
      // Filter properties merge-by-function within a block too, so several
      // single-function lines (or a duplicate filter declaration) accumulate
      // instead of clobbering — `BackdropFilter: Blur(16pt)` then
      // `BackdropFilter: Brightness(1.25)` = both. Everything else last-wins.
      if (_FILTER_KEY_SET.has(prop)) {
        (st as Record<string, string>)[prop] = MergeFilterValue(
          (st as Record<string, string>)[prop], value,
        );
      } else {
        (st as Record<string, unknown>)[prop] = value;
      }
      break;
    }
    case 'Layout':      (ruleset.Layout      ??= {})[prop as keyof LayoutConfig] = value as never; break;
    case 'ChildLayout': (ruleset.ChildLayout ??= {})[prop as keyof ChildLayout] = value as never; break;
    case 'TextStyle':   (ruleset.TextStyle   ??= {})[prop as keyof TextStyle]   = value as never; break;
  }
};

const _mergeStyleSlot = (
  a: Partial<JivStyle> | undefined,
  b: Partial<JivStyle> | undefined,
): Partial<JivStyle> => {
  const out: Partial<JivStyle> = { ...a };
  // Filter properties merge-by-function across extends (a subclass that
  // re-specifies one function keeps the base's others); the rest replace.
  if (b) AssignStyleWithFilterMerge(out as Record<string, unknown>, b as Record<string, unknown>);
  return out;
};

const _mergeRulesets = (a: Ruleset, b: Ruleset): Ruleset => ({
  Style:             _mergeStyleSlot(a.Style, b.Style),
  Layout:            { ...a.Layout,            ...b.Layout },
  ChildLayout:       { ...a.ChildLayout,       ...b.ChildLayout },
  TextStyle:         { ...a.TextStyle,         ...b.TextStyle },
  Springs:           { ...a.Springs,           ...b.Springs },
  // Animations concatenate (base first, then own). Source-order is
  // preserved so the cascade can apply last-wins within a tier.
  Animations: (a.Animations || b.Animations)
    ? [...(a.Animations ?? []), ...(b.Animations ?? [])]
    : undefined,
  // PredicateStyles concatenate the same way Animations do — base
  // entries come first, then own entries layered on top. Subclasses
  // can author their own pseudo rules (single-state OR compound)
  // without losing the base's, and last-source-order-wins resolves
  // conflicts within the tier.
  PredicateStyles: (a.PredicateStyles || b.PredicateStyles)
    ? [...(a.PredicateStyles ?? []), ...(b.PredicateStyles ?? [])]
    : undefined,
});

/**
 * Public field-merge of two rulesets: `b` layered ON TOP of `a` (Style/Layout/
 * ChildLayout/TextStyle/Springs field-merge with filter-aware Style merge,
 * Animations + PredicateStyles concatenate base-first). Identical to the internal
 * merge used for `: Base` extends and duplicate same-name rules within a sheet —
 * exported so the Angular registry can layer a re-registered class instead of
 * replacing it (live theme overlays). Pure; allocates a fresh ruleset.
 */
export const MergeRulesets = (a: Ruleset, b: Ruleset): Ruleset => _mergeRulesets(a, b);

// ─── Compound predicate parser ──────────────────────────────────────────
//
// Grammar for the parenthesized boolean expression in `Foo:(expr) { ... }`:
//
//   ParenExpr = '(' OrExpr ')'
//   OrExpr    = AndExpr ('||' AndExpr)*
//   AndExpr   = NotExpr ('&&' NotExpr)*
//   NotExpr   = '!'* Atom
//   Atom      = Ident | '(' OrExpr ')'
//
// Standard boolean precedence: `!` > `&&` > `||`. Atoms are PascalCase
// state names (Hover, Disabled, Loading, ...) — the parser doesn't
// validate against a closed list; the runtime evaluator looks each name
// up in the live state set on the Jiv, so unknown names simply never
// match. `(` opens a nested sub-expression for explicit grouping.
//
// All whitespace is skipped between tokens. The outer `:(...)` parens
// are consumed by the caller's open-paren detection + this function's
// closing `)` match.

const _parseParenPredicate = (s: _ScanState, className: string, vars?: VarTable): PredicateExpr => {
  _expect(s, '(');
  _skipWs(s);
  const expr = _parsePredOr(s, className, vars);
  _skipWs(s);
  if (s.src[s.pos] !== ')') {
    throw new Error(`[Jaui] "${className}:(...)" — expected ")" at position ${s.pos}, got "${s.src[s.pos] ?? 'EOF'}". Predicates must close their outer paren before "{".`);
  }
  s.pos++; // consume ')'
  return expr;
};

const _parsePredOr = (s: _ScanState, className: string, vars?: VarTable): PredicateExpr => {
  const left = _parsePredAnd(s, className, vars);
  const operands: PredicateExpr[] = [left];
  while (true) {
    _skipWs(s);
    if (s.src[s.pos] === '|' && s.src[s.pos + 1] === '|') {
      s.pos += 2;
      _skipWs(s);
      operands.push(_parsePredAnd(s, className, vars));
      continue;
    }
    break;
  }
  return operands.length === 1 ? operands[0] : { Kind: 'Or', Exprs: operands };
};

const _parsePredAnd = (s: _ScanState, className: string, vars?: VarTable): PredicateExpr => {
  const left = _parsePredNot(s, className, vars);
  const operands: PredicateExpr[] = [left];
  while (true) {
    _skipWs(s);
    if (s.src[s.pos] === '&' && s.src[s.pos + 1] === '&') {
      s.pos += 2;
      _skipWs(s);
      operands.push(_parsePredNot(s, className, vars));
      continue;
    }
    break;
  }
  return operands.length === 1 ? operands[0] : { Kind: 'And', Exprs: operands };
};

const _parsePredNot = (s: _ScanState, className: string, vars?: VarTable): PredicateExpr => {
  _skipWs(s);
  if (s.src[s.pos] === '!') {
    s.pos++;
    _skipWs(s);
    return { Kind: 'Not', Expr: _parsePredNot(s, className, vars) };
  }
  return _parsePredAtom(s, className, vars);
};

const _COMPARE_OPS: readonly CompareOp[] = ['>=', '<=', '==', '!=', '>', '<'];

/** Read a comparison operator (`>=`, `<=`, `==`, `!=`, `>`, `<`) or null. */
const _tryReadCompareOp = (s: _ScanState): CompareOp | null => {
  for (const op of _COMPARE_OPS) {
    if (s.src.startsWith(op, s.pos)) { s.pos += op.length; return op; }
  }
  return null;
};

/** Read a viewport-comparison threshold token — a number literal or a
 *  `@Var` reference. Stops at whitespace, ')', or a boolean operator. */
const _readThresholdToken = (s: _ScanState): string => {
  const start = s.pos;
  while (s.pos < s.src.length) {
    const c = s.src[s.pos];
    if (/\s/.test(c) || c === ')' || c === '&' || c === '|') break;
    s.pos++;
  }
  return s.src.slice(start, s.pos).trim();
};

/** Resolve a threshold token to a px number. Numeric literal (optional `px`)
 *  or a `@Var` chain that bottoms out in a number. Vars must be declared
 *  above the rule (forward references throw, like extends). */
const _resolveThreshold = (token: string, vars: VarTable | undefined, className: string): number => {
  let t = token;
  const seen = new Set<string>();
  while (t.startsWith('@')) {
    const nm = t.slice(1);
    if (seen.has(nm)) throw new Error(`[Jaui] "${className}" @If threshold has a variable cycle at "@${nm}"`);
    seen.add(nm);
    const v = vars?.[nm];
    if (v === undefined) {
      throw new Error(`[Jaui] "${className}" @If references unknown variable "@${nm}" — declare it above the rule.`);
    }
    t = v.trim();
  }
  const n = parseFloat(t.replace(/px$/, ''));
  if (Number.isNaN(n)) {
    throw new Error(`[Jaui] "${className}" @If threshold must resolve to a number (px), got "${token}"`);
  }
  return n;
};

/** Parse `Width|Height <op> <threshold>` (the tail after a scope) into a
 *  Compare node carrying `scope` (absent ⇒ viewport). */
const _parseCompareTail = (
  s: _ScanState, className: string, vars: VarTable | undefined, scope: SizeScope | undefined,
): PredicateExpr => {
  const axis = _readIdent(s);
  if (axis !== 'Width' && axis !== 'Height') {
    throw new Error(`[Jaui] "${className}" — expected Width or Height, got "${axis}".`);
  }
  _skipWs(s);
  const op = _tryReadCompareOp(s);
  if (!op) {
    throw new Error(`[Jaui] "${className}" — expected a comparison operator after ${axis}.`);
  }
  _skipWs(s);
  const value = _resolveThreshold(_readThresholdToken(s), vars, className);
  return scope ? { Kind: 'Compare', Scope: scope, Metric: axis, Op: op, Value: value }
               : { Kind: 'Compare', Metric: axis, Op: op, Value: value };
};

/** Parse a `(Class)` group then an optional `.Width`/`.Height` (→ scoped
 *  Compare) or `:State` (→ Ancestor with state) or nothing (→ bare Ancestor).
 *  `direct` distinguishes `Parent(X)` from `Ancestor(X)`. */
const _parseAncestorTail = (
  s: _ScanState, className: string, direct: boolean, vars?: VarTable,
): PredicateExpr => {
  _expect(s, '(');
  _skipWs(s);
  const cls = _readIdent(s);
  _skipWs(s);
  _expect(s, ')');
  if (s.src[s.pos] === '.') {
    s.pos++;
    return _parseCompareTail(s, className, vars, { Kind: 'Ancestor', Class: cls });
  }
  let state: string | undefined;
  if (s.src[s.pos] === ':') {
    s.pos++;
    state = _readIdent(s);
  }
  return state ? { Kind: 'Ancestor', Class: cls, Direct: direct, State: state }
               : { Kind: 'Ancestor', Class: cls, Direct: direct };
};

/** Read the right-hand side of a `@Var == value` comparison: a quoted string, a number, or a bare
 *  identifier (treated as a string). */
const _readVarComparand = (s: _ScanState, className: string): string | number => {
  _skipWs(s);
  const c = s.src[s.pos];
  if (c === '"' || c === "'") {
    s.pos++;
    const start = s.pos;
    while (s.pos < s.src.length && s.src[s.pos] !== c) s.pos++;
    if (s.src[s.pos] !== c) throw new Error(`[Jaui] "${className}" — unterminated string in @var comparison`);
    const str = s.src.slice(start, s.pos);
    s.pos++;
    return str;
  }
  if (/[-0-9.]/.test(c ?? '')) {
    const start = s.pos;
    while (/[-0-9.]/.test(s.src[s.pos] ?? '')) s.pos++;
    return Number(s.src.slice(start, s.pos));
  }
  return _readIdent(s);
};

const _parsePredAtom = (s: _ScanState, className: string, vars?: VarTable): PredicateExpr => {
  _skipWs(s);
  // Nested group — `(expr)` inside the outer predicate.
  if (s.src[s.pos] === '(') {
    s.pos++;
    _skipWs(s);
    const inner = _parsePredOr(s, className, vars);
    _skipWs(s);
    if (s.src[s.pos] !== ')') {
      throw new Error(`[Jaui] "${className}:(...)" — unbalanced parens in predicate at position ${s.pos}`);
    }
    s.pos++;
    return inner;
  }
  // Runtime style var atom: `@Name`, `@Name == 'value'`, `@Name != 'value'`. (A compile-time `@Var`
  // numeric constant only appears AFTER a comparison operator — `Width >= @TabletMin` — a different code
  // path, so there's no ambiguity.)
  if (s.src[s.pos] === '@') {
    s.pos++;
    const varName = _readIdent(s);
    const save = s.pos;
    _skipWs(s);
    const op = _tryReadCompareOp(s);
    if (op === '==' || op === '!=') {
      const value = _readVarComparand(s, className);
      return { Kind: 'Var', Name: varName, Op: op, Value: value };
    }
    s.pos = save;
    return { Kind: 'Var', Name: varName };
  }
  if (!/[A-Za-z_]/.test(s.src[s.pos] ?? '')) {
    throw new Error(`[Jaui] "${className}:(...)" — expected a state, @var, size comparison, or ancestor at position ${s.pos}, got "${s.src[s.pos] ?? 'EOF'}"`);
  }
  const name = _readIdent(s);

  // Scope-prefixed size comparisons: `Self.Width`, `Parent.Height`, `Viewport.Width`.
  if (name === 'Self' || name === 'Parent' || name === 'Viewport') {
    if (s.src[s.pos] === '.') {
      s.pos++;
      const scope: SizeScope | undefined =
        name === 'Self' ? { Kind: 'Self' } : name === 'Parent' ? { Kind: 'Parent' } : undefined;
      return _parseCompareTail(s, className, vars, scope);
    }
    // `Parent(Class)` — direct-parent context predicate.
    if (name === 'Parent' && s.src[s.pos] === '(') {
      return _parseAncestorTail(s, className, true, vars);
    }
    throw new Error(`[Jaui] "${className}" — "${name}" must be followed by ".Width"/".Height"${name === 'Parent' ? ' or "(Class)"' : ''}.`);
  }

  // `Ancestor(Class)`, `Ancestor(Class).Width`, `Ancestor(Class):State`.
  if (name === 'Ancestor') {
    if (s.src[s.pos] !== '(') {
      throw new Error(`[Jaui] "${className}" — Ancestor requires "(Class)".`);
    }
    return _parseAncestorTail(s, className, false, vars);
  }

  // Bare viewport comparison: `Width`/`Height` <op> <threshold>.
  if (name === 'Width' || name === 'Height') {
    const save = s.pos;
    _skipWs(s);
    const op = _tryReadCompareOp(s);
    if (op) {
      _skipWs(s);
      const value = _resolveThreshold(_readThresholdToken(s), vars, className);
      return { Kind: 'Compare', Metric: name, Op: op, Value: value };
    }
    s.pos = save; // bare `Width`/`Height` with no operator — fall through to a state atom
  }

  // State-name atom. No validation against a closed list — any name becomes
  // a state; the runtime evaluator returns false for names not currently set.
  return { Kind: 'State', Name: name };
};

