/**
 * Jaui's length/size value system. Every dimensional or numeric style field
 * on a Jiv accepts a `Length`, which is just a `number | string`.
 *
 * Why strings? Authors get one uniform authoring grammar (matching JSS) that
 * covers units, arithmetic, parens, and can be placed anywhere a numeric
 * field lives. Plain numbers remain valid — they're the fast path (no parse,
 * treated as px). Strings go through the parser; parsed ASTs are cached so
 * the same literal is only parsed once.
 *
 * Grammar:
 *   Value   = Term   ( ('+'|'-') Term   )*
 *   Term    = Factor ( ('*'|'/') Factor )*
 *   Factor  = '-' Factor | Number [Unit] | '(' Value ')'
 *
 * Units (case-insensitive): px pt rpt % %w %h vw vh
 *   px    absolute device-independent pixel
 *   pt    V × current PointScale  (V × parent PointScale when resolving PointScale itself)
 *   rpt   V × root PointScale
 *   %     V/100 × parent dim along the field's natural axis
 *   %w    V/100 × parent width  (explicit)
 *   %h    V/100 × parent height (explicit)
 *   vw    V/100 × viewport width
 *   vh    V/100 × viewport height
 *
 * `PointScale` is Jaui's cascading base-unit prop, decoupled from text —
 * set it anywhere and every `pt` expression in the subtree scales together.
 * FontSize, Padding, BorderRadius, anything else can reference it via `pt`.
 */

import { EvaluatePredicate, type PredicateContext, type PredicateElement } from '../Jss/Jss.Predicate';
import type { PredicateExpr } from '../Jss/Jss.Parser';

export type Length = number | string;

export type Unit = 'px' | 'pt' | 'rpt' | '%' | '%w' | '%h' | 'vw' | 'vh';

/** A laid-out node as the ternary/predicate resolver sees it — resolved box +
 *  ancestry + classes/states. `Element` (the real Jiv) satisfies this
 *  structurally (LayoutWidth/Height, Parent; Classes/StateSet on Jiv), so the
 *  layout solver can stash the node in `ResolveContext.Element` with no
 *  allocation; the PredicateElement adapter is built lazily only when a
 *  ternary actually decodes. */
export interface SizedNode {
  readonly LayoutWidth: number;
  readonly LayoutHeight: number;
  readonly Parent: SizedNode | null;
  readonly Classes?: readonly string[];
  readonly StateSet?: ReadonlySet<string>;
}

/** Sentinel prefix marking a value string as a pre-compiled inline ternary
 *  (`cond ? a : b`). The JSS parser encodes the parsed condition + branches as
 *  `TERNARY_SENTINEL + JSON`; `ResolveTernary` decodes + picks at resolve time.
 *  A control char keeps it disjoint from any real authored value. */
export const TERNARY_SENTINEL = String.fromCharCode(0) + 'tern:';

/** Context needed to resolve a Length to pixels. Layout solver fills this
 *  before running flex math; style animator fills it when resolving spring
 *  targets at Tick time. */
export interface ResolveContext {
  ParentWidth: number;
  ParentHeight: number;
  /** PointScale for `pt` in the normal case. */
  PointScale: number;
  /** Parent's PointScale — used ONLY when resolving `PointScale` itself
   *  (via `ptRefersToParent` flag) to avoid self-reference. */
  ParentPointScale: number;
  /** Root Jiv's PointScale — target for `rpt`. */
  RootPointScale: number;
  ViewportWidth: number;
  ViewportHeight: number;
  /** Author-declared JSS variables (from top-level `@Name: value`). The
   *  resolver substitutes `@Name` references in expressions against this
   *  table. Optional so callers without a JSS stylesheet (seed context,
   *  imperative code) can skip it; a missing table just produces warnings
   *  when a `@Name` reference is encountered. */
  Vars?: ReadonlyMap<string, string>;
  /** Current per-Jiv Presence value (0..1). Resolved into expressions that
   *  reference the bare `Presence` identifier. Absent in layout-pass
   *  contexts (layout doesn't re-run per frame); populated by the style
   *  animator each tick so authored fade/slide/scale curves re-resolve
   *  against the current spring position. */
  Presence?: number;
  /** 1 while the Jiv's Presence spring is mounting toward 1 (Presence < 1
   *  AND spring target === 1); 0 otherwise. Lets authors branch entry vs
   *  exit via arithmetic: `OffsetY: Entering * -20 * (1 - Presence)`. */
  Entering?: number;
  /** 1 while the Jiv is leaving (Presence > 0 AND spring target === 0);
   *  0 otherwise. Symmetric counterpart to `Entering`. */
  Exiting?: number;
  /** The laid-out node this resolve is for — supplies Self/Parent/Ancestor
   *  size + ancestry to inline-ternary conditions. The solver stashes the raw
   *  node (no alloc); `ResolveTernary` adapts it lazily. Absent in seed /
   *  layout-intrinsic contexts (ternary conditions then see no element). */
  Element?: SizedNode | null;
  /** Element's live states, for ternary conditions that reference them.
   *  Derived from `Element.StateSet` when absent. */
  States?: ReadonlySet<string>;
  /** Internal flag — true on the seed context the Jiv constructor uses to
   *  produce its initial RenderStyle before any layout / style-animator
   *  pass has run. The registry's var table hasn't been merged at that
   *  point, so an authored `@Name` reference would otherwise log a false-
   *  positive "undefined var" warning every time. The animator's next
   *  tick re-resolves with the live registry; that's where genuine
   *  misspellings should still surface. */
  IsSeed?: boolean;
}

// ─── Authoring helpers (PascalCase, return strings) ─────────────────────

export const Px  = (v: number): string => `${v}px`;
export const Pt  = (v: number): string => `${v}pt`;
export const Rpt = (v: number): string => `${v}rpt`;
export const Pct = (v: number): string => `${v}%`;
export const PctW = (v: number): string => `${v}%w`;
export const PctH = (v: number): string => `${v}%h`;
export const Vw  = (v: number): string => `${v}vw`;
export const Vh  = (v: number): string => `${v}vh`;

// ─── Resolver ───────────────────────────────────────────────────────────

/** Resolve a Length to a pixel number under the given context.
 *  @param axis — which parent dim `%` defaults to ('W' → width, 'H' → height).
 *  @param ptRefersToParent — set true ONLY when resolving PointScale itself
 *                            to avoid self-recursive `pt`. */
export const Resolve = (
  length: Length,
  ctx: ResolveContext,
  axis: 'W' | 'H',
  ptRefersToParent: boolean = false,
): number => {
  if (typeof length === 'number') return length;
  length = ResolveTernary(length, ctx);
  const parsed = _parseCached(length);
  return _resolveParsed(parsed, ctx, axis, ptRefersToParent, null);
};

// ─── Inline ternaries (`cond ? a : b`) ──────────────────────────────────
// The JSS parser pre-compiles ternaries to `TERNARY_SENTINEL + JSON({Cond,T,F})`
// (Cond is a parsed PredicateExpr; T/F are value strings, themselves possibly
// ternaries). At resolve time we evaluate Cond against the live context and
// return the chosen branch — recursively, so chained `a ? x : b ? y : z` works.
// Kept here (Core/Length) so every value resolver shares one decode path; only
// the worker-safe evaluator is pulled in, never the parser.

interface _Ternary { Cond: PredicateExpr; T: string; F: string; }
const _ternaryCache = new Map<string, _Ternary>();
const _EMPTY_STATE_SET: ReadonlySet<string> = new Set();

/** Adapt a SizedNode (the real Jiv) to the evaluator's PredicateElement —
 *  resolved box + chained ancestry. Built lazily, only while decoding. */
const _adaptElement = (n: SizedNode | null | undefined): PredicateElement | null => {
  if (!n) return null;
  return {
    get Width() { return n.LayoutWidth; },
    get Height() { return n.LayoutHeight; },
    get Parent() { return _adaptElement(n.Parent); },
    Classes: n.Classes ?? [],
    States: n.StateSet ?? _EMPTY_STATE_SET,
  };
};

/** If `value` is an encoded ternary, evaluate its condition and return the
 *  chosen branch (recursively resolving a chained branch); otherwise return
 *  `value` unchanged. */
export const ResolveTernary = (value: string, ctx: ResolveContext): string => {
  if (!value.startsWith(TERNARY_SENTINEL)) return value;
  let node = _ternaryCache.get(value);
  if (!node) {
    node = JSON.parse(value.slice(TERNARY_SENTINEL.length)) as _Ternary;
    _ternaryCache.set(value, node);
  }
  const pctx: PredicateContext = {
    States: ctx.States ?? ctx.Element?.StateSet ?? _EMPTY_STATE_SET,
    ViewportW: ctx.ViewportWidth,
    ViewportH: ctx.ViewportHeight,
    Element: _adaptElement(ctx.Element),
  };
  const picked = EvaluatePredicate(node.Cond, pctx) ? node.T : node.F;
  return ResolveTernary(picked, ctx);
};

/** Missing-var warnings are deduped — one console message per var name
 *  per page load, not one per property that references it. */
const _warnedMissingVars = new Set<string>();
const _warnedCycleVars = new Set<string>();

// ─── Internal AST + parse cache ─────────────────────────────────────────

interface _Relative { V: number; U: Unit; }
interface _Expr { Op: '+' | '-' | '*' | '/'; L: _Parsed; R: _Parsed; }
interface _VarRef { Name: string; }
type _Parsed = number | _Relative | _Expr | _VarRef;

/** Built-in identifiers resolved per-Jiv by the renderer. In expression
 *  contexts they parse as numeric tokens (not `@var` references), looked
 *  up in `ResolveContext` at resolve time. When the context doesn't carry
 *  a value (layout pass, seed context, imperative callers), they fall
 *  back to 0 — which matches the "nothing is present yet" default and
 *  keeps layout-time resolutions deterministic. */
const _BUILTIN_IDENTS = new Set(['Presence', 'Entering', 'Exiting']);

const _parseCache = new Map<string, _Parsed>();

const _parseCached = (s: string): _Parsed => {
  const hit = _parseCache.get(s);
  if (hit !== undefined) return hit;
  const parsed = _parse(s);
  _parseCache.set(s, parsed);
  return parsed;
};

/** Parse a Length expression string. Exported for tests / the JSS plugin;
 *  not typically called directly — `Resolve(str, ctx, axis)` handles parsing
 *  internally with caching. */
export const Parse = (input: string): _Parsed => _parseCached(input);

const _resolveParsed = (
  length: _Parsed,
  ctx: ResolveContext,
  axis: 'W' | 'H',
  ptRefersToParent: boolean,
  visiting: Set<string> | null,
): number => {
  if (typeof length === 'number') return length;
  if ('Op' in length) {
    const l = _resolveParsed(length.L, ctx, axis, ptRefersToParent, visiting);
    const r = _resolveParsed(length.R, ctx, axis, ptRefersToParent, visiting);
    switch (length.Op) {
      case '+': return l + r;
      case '-': return l - r;
      case '*': return l * r;
      case '/': return l / r;
    }
  }
  if ('Name' in length) {
    const name = length.Name;
    // Built-in per-Jiv identifiers read from the resolve context. The
    // style animator extends each Jiv's layout ctx with current spring
    // state before resolving style expressions, so `Presence`, `Entering`,
    // `Exiting` produce live values. Contexts that omit them (layout pass,
    // seed) fall back to 0 — "nothing is present yet."
    if (_BUILTIN_IDENTS.has(name)) {
      if (name === 'Presence') return ctx.Presence ?? 0;
      if (name === 'Entering') return ctx.Entering ?? 0;
      if (name === 'Exiting')  return ctx.Exiting  ?? 0;
      return 0;
    }
    if (!ctx.Vars) {
      if (!ctx.IsSeed && !_warnedMissingVars.has(name)) {
        _warnedMissingVars.add(name);
        console.warn(`[Jaui] "@${name}" referenced but no var table in context — falling back to 0`);
      }
      return 0;
    }
    const raw = ctx.Vars.get(name);
    if (raw === undefined) {
      // Seed context fires before the JSS registry has merged any
      // sheet-local @Names — silence the warning there. Real misspellings
      // surface on the next style-animator tick (which uses a live ctx).
      if (!ctx.IsSeed && !_warnedMissingVars.has(name)) {
        _warnedMissingVars.add(name);
        console.warn(`[Jaui] Undefined var "@${name}" — falling back to 0`);
      }
      return 0;
    }
    const v = visiting ?? new Set<string>();
    if (v.has(name)) {
      if (!_warnedCycleVars.has(name)) {
        _warnedCycleVars.add(name);
        console.warn(`[Jaui] Circular var reference at "@${name}" — falling back to 0`);
      }
      return 0;
    }
    v.add(name);
    try {
      const parsed = _parseCached(raw);
      return _resolveParsed(parsed, ctx, axis, ptRefersToParent, v);
    } finally {
      v.delete(name);
    }
  }
  const { V, U } = length;
  switch (U) {
    case 'px':  return V;
    case 'pt':  return V * (ptRefersToParent ? ctx.ParentPointScale : ctx.PointScale);
    case 'rpt': return V * ctx.RootPointScale;
    case '%':   return V / 100 * (axis === 'W' ? ctx.ParentWidth : ctx.ParentHeight);
    case '%w':  return V / 100 * ctx.ParentWidth;
    case '%h':  return V / 100 * ctx.ParentHeight;
    case 'vw':  return V / 100 * ctx.ViewportWidth;
    case 'vh':  return V / 100 * ctx.ViewportHeight;
  }
};

// ─── Tokenizer ──────────────────────────────────────────────────────────

type _Token =
  | { T: 'num'; V: number }
  | { T: 'unit'; V: Unit }
  | { T: 'op'; V: '+' | '-' | '*' | '/' }
  | { T: 'var'; Name: string }
  | { T: 'ident'; Name: string }
  | { T: 'lp' }
  | { T: 'rp' };

const _tokenize = (raw: string): _Token[] => {
  // Preserve original casing for identifiers (`@ScreenR`, `Presence`) —
  // lookup keys are case-sensitive. Numbers/ops/parens don't care, and
  // the unit matcher lowercases its own window below.
  const s = raw;
  const lower = raw.toLowerCase();
  const tokens: _Token[] = [];
  let i = 0;
  const isIdentStart = (c: string): boolean => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_';
  const isIdentPart  = (c: string): boolean => isIdentStart(c) || (c >= '0' && c <= '9');
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if ((c >= '0' && c <= '9') || c === '.') {
      let j = i;
      while (j < s.length && ((s[j] >= '0' && s[j] <= '9') || s[j] === '.')) j++;
      const num = parseFloat(s.slice(i, j));
      if (Number.isNaN(num)) {
        throw new Error(`[Jaui] Malformed number in length expression: "${raw}"`);
      }
      tokens.push({ T: 'num', V: num });
      i = j;
      const unit = _matchUnit(lower, i);
      if (unit) {
        tokens.push({ T: 'unit', V: unit });
        i += unit.length;
      }
      continue;
    }
    if (c === '@') {
      // Var reference — `@Name`. The `@` must be immediately followed by
      // an identifier character; otherwise this isn't a valid token.
      i++;
      if (i >= s.length || !isIdentStart(s[i])) {
        throw new Error(`[Jaui] "@" must be followed by an identifier in length expression: "${raw}"`);
      }
      let j = i;
      while (j < s.length && isIdentPart(s[j])) j++;
      tokens.push({ T: 'var', Name: s.slice(i, j) });
      i = j;
      continue;
    }
    if (isIdentStart(c)) {
      // Bare identifier — reserved built-in or future keyword. Grabs the
      // whole identifier (case-sensitive); the parser decides whether it
      // resolves to a value or is an error.
      let j = i;
      while (j < s.length && isIdentPart(s[j])) j++;
      tokens.push({ T: 'ident', Name: s.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '(') { tokens.push({ T: 'lp' }); i++; continue; }
    if (c === ')') { tokens.push({ T: 'rp' }); i++; continue; }
    if (c === '+' || c === '-' || c === '*' || c === '/') {
      tokens.push({ T: 'op', V: c });
      i++;
      continue;
    }
    throw new Error(`[Jaui] Unexpected character "${c}" in length expression: "${raw}"`);
  }
  return tokens;
};

/** Longest-match unit lookup. Input is lower-cased before this runs. */
const _matchUnit = (s: string, i: number): Unit | null => {
  if (s.startsWith('rpt', i)) return 'rpt';
  if (s.startsWith('pt', i))  return 'pt';
  if (s.startsWith('px', i))  return 'px';
  if (s.startsWith('vw', i))  return 'vw';
  if (s.startsWith('vh', i))  return 'vh';
  if (s.startsWith('%w', i))  return '%w';
  if (s.startsWith('%h', i))  return '%h';
  if (s.startsWith('%', i))   return '%';
  return null;
};

// ─── Recursive-descent parser ───────────────────────────────────────────

interface _ParseState { tokens: _Token[]; pos: number; }

const _parse = (input: string): _Parsed => {
  const tokens = _tokenize(input);
  const state: _ParseState = { tokens, pos: 0 };
  const result = _parseValue(state);
  if (state.pos < state.tokens.length) {
    throw new Error(`[Jaui] Unexpected trailing input in length: "${input}"`);
  }
  return result;
};

const _parseValue = (s: _ParseState): _Parsed => {
  let left = _parseTerm(s);
  while (true) {
    const op = s.tokens[s.pos];
    if (op && op.T === 'op' && (op.V === '+' || op.V === '-')) {
      s.pos++;
      const right = _parseTerm(s);
      left = { Op: op.V, L: left, R: right };
    } else break;
  }
  return left;
};

const _parseTerm = (s: _ParseState): _Parsed => {
  let left = _parseFactor(s);
  while (true) {
    const op = s.tokens[s.pos];
    if (op && op.T === 'op' && (op.V === '*' || op.V === '/')) {
      s.pos++;
      const right = _parseFactor(s);
      left = { Op: op.V, L: left, R: right };
    } else break;
  }
  return left;
};

const _parseFactor = (s: _ParseState): _Parsed => {
  const t = s.tokens[s.pos];
  if (!t) throw new Error('[Jaui] Unexpected end of length expression');

  if (t.T === 'op' && t.V === '-') {
    s.pos++;
    const inner = _parseFactor(s);
    if (typeof inner === 'number') return -inner;
    if ('U' in inner) return { V: -inner.V, U: inner.U };
    return { Op: '-', L: 0, R: inner };
  }

  if (t.T === 'lp') {
    s.pos++;
    const inner = _parseValue(s);
    const close = s.tokens[s.pos];
    if (!close || close.T !== 'rp') {
      throw new Error('[Jaui] Expected ")" in length expression');
    }
    s.pos++;
    return inner;
  }

  if (t.T === 'num') {
    s.pos++;
    const next = s.tokens[s.pos];
    if (next && next.T === 'unit') {
      s.pos++;
      if (next.V === 'px') return t.V;   // bare px collapses to number
      return { V: t.V, U: next.V };
    }
    return t.V;
  }

  if (t.T === 'var') {
    s.pos++;
    return { Name: t.Name };
  }

  if (t.T === 'ident') {
    s.pos++;
    // Engine-provided built-ins (`Presence`, `Entering`, `Exiting`) use
    // the same _VarRef node as author `@Name` references — the resolver
    // routes builtins through `_BUILTIN_IDENTS` and skips the var-table
    // lookup. Any other bare identifier in a length expression is a
    // parse error; authors who meant to declare a var should prefix `@`.
    if (!_BUILTIN_IDENTS.has(t.Name)) {
      throw new Error(`[Jaui] Unknown identifier "${t.Name}" in length expression — declare it as "@${t.Name}: value" at top level and reference it as "@${t.Name}", or check spelling against the reserved built-ins.`);
    }
    return { Name: t.Name };
  }

  throw new Error(`[Jaui] Unexpected token in length expression at position ${s.pos}`);
};
