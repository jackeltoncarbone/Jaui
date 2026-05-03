import { SlotFor } from './Jss.Routes';
import type { JivStyle } from '../Jiv/Jiv.Types';
import type { LayoutConfig, ChildLayout } from '../Layout/Layout.Types';
import type { TextStyle } from '../Text/Text.Types';
import { type SpringConfig, TransitionToSpring } from '../Animation/Animation.Types';

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
}

export type Stylesheet = Record<string, Ruleset>;

/** Author-declared variables. Values stay as unresolved strings (the
 *  Length parser resolves `@Name` references at property-resolution time
 *  against this table, so declaration order doesn't matter and chained
 *  vars like `@B: @A * 2` work naturally). */
export type VarTable = Record<string, string>;

export interface ParsedJss {
  Sheet: Stylesheet;
  Vars: VarTable;
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
  const state: _ScanState = { src: cleaned, pos: 0 };
  _skipWs(state);
  while (state.pos < state.src.length) {
    if (state.src[state.pos] === '@') {
      _parseTopLevelAt(state, vars);
    } else {
      _parseRuleset(state, sheet, globals);
    }
    _skipWs(state);
  }
  return { Sheet: sheet, Vars: vars };
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

/** Parse a top-level `@Name: value` var declaration. The `@var` keyword
 *  was dropped — `@Name:` at top level is already unambiguous. Any other
 *  `@Keyword` at top level (future `@Import`, `@Theme`, etc.) is a parse
 *  error for now. */
const _parseTopLevelAt = (s: _ScanState, vars: VarTable): void => {
  _expect(s, '@');
  const name = _readIdent(s);
  _skipWs(s);

  if (s.src[s.pos] !== ':') {
    if (name === 'var') {
      throw new Error(`[Jaui] "@var" is no longer a keyword — declare variables as "@Name: value" directly (drop the "@var" prefix)`);
    }
    throw new Error(`[Jaui] Unexpected "@${name}" at top level — only "@Name: value" var declarations are allowed here`);
  }

  if (_RESERVED_IDENTS.has(name)) {
    throw new Error(`[Jaui] Cannot declare "@${name}: …" — "${name}" is a reserved built-in identifier provided by the engine per Jiv. Reference it without the "@" prefix in property values (e.g. "Opacity: ${name}").`);
  }

  s.pos++; // consume ':'
  _skipWs(s);
  const value = _readValue(s);
  vars[name] = value;
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

/** Inside-ruleset `@` directives. `@Spring Property { Stiffness: …, Damping: …, Mass: … }`
 *  authors a spring directly. `@Transition Property { Duration: 150ms, Easing: EaseOut }`
 *  is the CSS-flavoured shorthand — both end up as a SpringConfig in the
 *  Springs map (transitions are translated to a critically-damped spring). */
const _parseRulesetAt = (s: _ScanState, ruleset: Ruleset, className: string): void => {
  s.pos++; // skip '@'
  const directive = _readIdent(s);
  if (directive !== 'Spring' && directive !== 'Transition') {
    throw new Error(`[Jaui] "${className}" — unknown @${directive}; supported: @Spring, @Transition.`);
  }
  _skipWs(s);
  const property = _readIdent(s);
  _skipWs(s);
  _expect(s, '{');
  const raw: Record<string, string> = {};
  while (true) {
    _skipWs(s);
    if (s.src[s.pos] === '}') { s.pos++; break; }
    if (s.pos >= s.src.length) {
      throw new Error(`[Jaui] Unterminated @${directive} ${property} in "${className}" — missing "}"`);
    }
    const k = _readIdent(s);
    _skipWs(s);
    _expect(s, ':');
    _skipWs(s);
    raw[k] = _readValue(s);
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
    // @Transition — strip optional `ms` suffix, translate to a critically
    // damped spring with matching settle time.
    const dStr = raw['Duration'] ?? '';
    const dNum = parseFloat(dStr.replace(/ms$/, ''));
    if (Number.isNaN(dNum)) throw new Error(`[Jaui] @Transition ${property}.Duration must be a number (optionally ms-suffixed), got "${dStr}"`);
    const easing = raw['Easing'] as 'Linear' | 'EaseOut' | 'EaseInOut' | 'Spring' | undefined;
    spring = TransitionToSpring({ Duration: dNum, Easing: easing ?? 'EaseOut', Spring: null });
  }
  ruleset.Springs ??= {};
  ruleset.Springs[property] = { ...ruleset.Springs[property], ...spring };
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
