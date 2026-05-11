import { SlotFor } from './Jss.Routes';
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

export interface Ruleset {
  Style?: Partial<JivStyle>;
  Layout?: Partial<LayoutConfig>;
  ChildLayout?: Partial<ChildLayout>;
  TextStyle?: Partial<TextStyle>;
  /** Authored via `Name:Hover { ... }`. Merged on top of base Style when
   *  the Jiv's `Hover` flag is set (pointer hit-test, focus, disabled).
   *  Inherited by subclasses through the same extends chain as Style. */
  HoverStyle?: Partial<JivStyle>;
  ActiveStyle?: Partial<JivStyle>;
  FocusStyle?: Partial<JivStyle>;
  DisabledStyle?: Partial<JivStyle>;
  /** TextStyle declarations from a `:State` block — `Name:Hover { Color: red }`
   *  routes Color (a TextStyle prop per Jss.Routes) into HoverTextStyle so
   *  the runtime can layer it on top of the base TextStyle when the matching
   *  state is active. Plumbed through Jaui core Jiv. */
  HoverTextStyle?: Partial<TextStyle>;
  ActiveTextStyle?: Partial<TextStyle>;
  FocusTextStyle?: Partial<TextStyle>;
  DisabledTextStyle?: Partial<TextStyle>;
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
      _parseRuleset(state, sheet, globals);
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

  if (s.src[s.pos] !== ':') {
    if (name === 'var') {
      throw new Error(`[Jaui] "@var" is no longer a keyword, declare variables as "@Name: value" directly (drop the "@var" prefix)`);
    }
    throw new Error(`[Jaui] Unexpected "@${name}" at top level, only "@Name: value" var declarations and "@Animation Name { ... }" definitions are allowed here`);
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

const _parseRuleset = (s: _ScanState, out: Stylesheet, globals?: Stylesheet): void => {
  // Selector — bare class name, no leading `.`, no ids, no tags, no
  // combinators. JSS uses class-only selectors by design.
  const className = _readIdent(s);

  // Tight `:State` pseudo (no whitespace). `Foo:Hover { ... }` writes into
  // the existing Foo's HoverStyle slot. Must come before the extends check
  // so `Foo:Hover` isn't misread as `Foo extends Hover`.
  let stateSlot: 'HoverStyle' | 'ActiveStyle' | 'FocusStyle' | 'DisabledStyle' | null = null;
  let stateTextSlot: 'HoverTextStyle' | 'ActiveTextStyle' | 'FocusTextStyle' | 'DisabledTextStyle' | null = null;
  if (s.src[s.pos] === ':') {
    const next = s.src[s.pos + 1];
    if (next && next !== ' ' && next !== '\t' && next !== '\n') {
      // Tight colon — pseudo-state form.
      s.pos++;
      const stateName = _readIdent(s);
      const slot = _STATE_TO_SLOT[stateName];
      if (!slot) {
        throw new Error(`[Jaui] "${className}:${stateName}" — unknown state. Use Hover, Active, Focus, or Disabled.`);
      }
      stateSlot = slot;
      stateTextSlot = _STATE_TO_TEXT_SLOT[stateName];
    }
  }

  _skipWs(s);

  // Optional `: Base1, Base2` extends list (only valid on the base form).
  const bases: string[] = [];
  if (!stateSlot && s.src[s.pos] === ':') {
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
      throw new Error(`[Jaui] Unterminated ruleset "${className}${stateSlot ? `:${stateSlot}` : ''}" — missing "}"`);
    }
    if (s.src[s.pos] === '@') {
      _parseRulesetAt(s, own, className);
    } else {
      _parseDeclaration(s, own);
    }
  }

  // Pseudo-state ruleset — copy own.Style into the matching state slot AND
  // own.TextStyle into the matching state-text slot (e.g. `Foo:Hover {
  // Color: red }` routes Color via Jss.Routes to TextStyle, which we
  // then layer onto HoverTextStyle so the runtime can apply text-level
  // hover/active/focus/disabled overrides — not just visual JivStyle.
  if (stateSlot && stateTextSlot) {
    const target = out[className];
    if (!target) {
      throw new Error(`[Jaui] "${className}:${stateSlot}" declared before base "${className}" — declare the base ruleset first.`);
    }
    if (own.Style)     target[stateSlot]     = { ...target[stateSlot],     ...own.Style };
    if (own.TextStyle) target[stateTextSlot] = { ...target[stateTextSlot], ...own.TextStyle };
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

  // If this class appears multiple times in one sheet, merge (later
  // declarations win inside matching slots). Matches CSS cascade behavior.
  const existing = out[className];
  if (existing) {
    out[className] = _mergeRulesets(existing, ruleset);
  } else {
    out[className] = ruleset;
  }
};

/** Inside-ruleset `@` directives. Three supported keywords:
 *    `@Spring Property { Stiffness, Damping, Mass }` - direct spring tune.
 *    `@Spring * { ... }`                    - universal default for every animatable property.
 *    `@Transition Property { Duration, Easing }` - CSS-style shorthand,
 *      translates to a critically-damped spring with matching settle.
 *    `@Animation Name[, Name2, ...]`        - apply named animations (no block, comma-separated).
 *    `@Animation Property { From, To, Duration, Loop }` - inline anonymous. */
const _parseRulesetAt = (s: _ScanState, ruleset: Ruleset, className: string): void => {
  s.pos++; // skip '@'
  const directive = _readIdent(s);
  if (directive === 'Animation') {
    _parseRulesetAnimation(s, ruleset, className);
    return;
  }
  if (directive !== 'Spring' && directive !== 'Transition') {
    throw new Error(`[Jaui] "${className}" unknown @${directive}; supported: @Spring, @Transition, @Animation.`);
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

const _parseDeclaration = (s: _ScanState, ruleset: Ruleset): void => {
  const prop = _readIdent(s);
  _skipWs(s);
  _expect(s, ':');
  _skipWs(s);
  const value = _readValue(s);
  _assignToSlot(ruleset, prop, value);
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

const _assignToSlot = (ruleset: Ruleset, prop: string, value: string): void => {
  const slot = SlotFor(prop);
  switch (slot) {
    case 'Style':       (ruleset.Style       ??= {})[prop as keyof JivStyle]    = value as never; break;
    case 'Layout':      (ruleset.Layout      ??= {})[prop as keyof LayoutConfig] = value as never; break;
    case 'ChildLayout': (ruleset.ChildLayout ??= {})[prop as keyof ChildLayout] = value as never; break;
    case 'TextStyle':   (ruleset.TextStyle   ??= {})[prop as keyof TextStyle]   = value as never; break;
  }
};

const _mergeRulesets = (a: Ruleset, b: Ruleset): Ruleset => ({
  Style:             { ...a.Style,             ...b.Style },
  Layout:            { ...a.Layout,            ...b.Layout },
  ChildLayout:       { ...a.ChildLayout,       ...b.ChildLayout },
  TextStyle:         { ...a.TextStyle,         ...b.TextStyle },
  HoverStyle:        { ...a.HoverStyle,        ...b.HoverStyle },
  ActiveStyle:       { ...a.ActiveStyle,       ...b.ActiveStyle },
  FocusStyle:        { ...a.FocusStyle,        ...b.FocusStyle },
  DisabledStyle:     { ...a.DisabledStyle,     ...b.DisabledStyle },
  HoverTextStyle:    { ...a.HoverTextStyle,    ...b.HoverTextStyle },
  ActiveTextStyle:   { ...a.ActiveTextStyle,   ...b.ActiveTextStyle },
  FocusTextStyle:    { ...a.FocusTextStyle,    ...b.FocusTextStyle },
  DisabledTextStyle: { ...a.DisabledTextStyle, ...b.DisabledTextStyle },
  Springs:           { ...a.Springs,           ...b.Springs },
  // Animations concatenate (base first, then own). Source-order is
  // preserved so the cascade can apply last-wins within a tier.
  Animations: (a.Animations || b.Animations)
    ? [...(a.Animations ?? []), ...(b.Animations ?? [])]
    : undefined,
});

/** Reserved pseudo-state names following the `:` in `Foo:State`. Maps to
 *  the matching slot on Ruleset. PascalCase to match Jaui authoring style. */
const _STATE_TO_SLOT: Record<string, 'HoverStyle' | 'ActiveStyle' | 'FocusStyle' | 'DisabledStyle'> = {
  Hover: 'HoverStyle',
  Active: 'ActiveStyle',
  Focus: 'FocusStyle',
  Disabled: 'DisabledStyle',
};

/** TextStyle counterpart to _STATE_TO_SLOT — TextStyle props in `:State`
 *  blocks land here so the runtime can layer them on top of base TextStyle. */
const _STATE_TO_TEXT_SLOT: Record<string, 'HoverTextStyle' | 'ActiveTextStyle' | 'FocusTextStyle' | 'DisabledTextStyle'> = {
  Hover: 'HoverTextStyle',
  Active: 'ActiveTextStyle',
  Focus: 'FocusTextStyle',
  Disabled: 'DisabledTextStyle',
};
