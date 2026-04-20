import { SlotFor } from './Jss.Routes';
import type { JivStyle } from '../Jiv/Jiv.Types';
import type { LayoutConfig, ChildLayout } from '../Layout/Layout.Types';
import type { TextStyle } from '../Text/Text.Types';

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
 * Bases must be declared earlier in the same sheet (forward references are
 * a future nicety; error out for now).
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
 *  else (`Name { ... }`) populates `Sheet`. */
export const ParseJss = (source: string): ParsedJss => {
  const cleaned = _stripComments(source);
  const sheet: Stylesheet = {};
  const vars: VarTable = {};
  const state: _ScanState = { src: cleaned, pos: 0 };
  _skipWs(state);
  while (state.pos < state.src.length) {
    if (state.src[state.pos] === '@') {
      _parseTopLevelAt(state, vars);
    } else {
      _parseRuleset(state, sheet);
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

const _parseRuleset = (s: _ScanState, out: Stylesheet): void => {
  // Selector — bare class name, no leading `.`, no ids, no tags, no
  // combinators. JSS uses class-only selectors by design.
  const className = _readIdent(s);
  _skipWs(s);

  // Optional `: Base1, Base2` extends list.
  const bases: string[] = [];
  if (s.src[s.pos] === ':') {
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
      throw new Error(`[Jaui] Unterminated ruleset "${className}" — missing "}"`);
    }
    _parseDeclaration(s, own);
  }

  // Flatten extends: start from empty, merge each base in declared order,
  // then overlay own declarations. Later always wins. When there are no
  // bases, skip the merge entirely so the emitted ruleset only carries the
  // slots that were actually declared (same shape as before extends existed).
  let ruleset: Ruleset = own;
  if (bases.length > 0) {
    ruleset = {};
    for (const base of bases) {
      const baseRuleset = out[base];
      if (!baseRuleset) {
        throw new Error(`[Jaui] "${className}" extends unknown class "${base}" — bases must be declared earlier in the same sheet`);
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
  Style:       { ...a.Style,       ...b.Style },
  Layout:      { ...a.Layout,      ...b.Layout },
  ChildLayout: { ...a.ChildLayout, ...b.ChildLayout },
  TextStyle:   { ...a.TextStyle,   ...b.TextStyle },
});
