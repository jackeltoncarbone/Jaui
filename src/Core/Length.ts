/**
 * Jwift's length/size value system. Every dimensional or numeric style field
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
 * `PointScale` is Jwift's cascading base-unit prop, decoupled from text —
 * set it anywhere and every `pt` expression in the subtree scales together.
 * FontSize, Padding, BorderRadius, anything else can reference it via `pt`.
 */

export type Length = number | string;

export type Unit = 'px' | 'pt' | 'rpt' | '%' | '%w' | '%h' | 'vw' | 'vh';

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
  const parsed = _parseCached(length);
  return _resolveParsed(parsed, ctx, axis, ptRefersToParent);
};

// ─── Internal AST + parse cache ─────────────────────────────────────────

interface _Relative { V: number; U: Unit; }
interface _Expr { Op: '+' | '-' | '*' | '/'; L: _Parsed; R: _Parsed; }
type _Parsed = number | _Relative | _Expr;

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
): number => {
  if (typeof length === 'number') return length;
  if ('Op' in length) {
    const l = _resolveParsed(length.L, ctx, axis, ptRefersToParent);
    const r = _resolveParsed(length.R, ctx, axis, ptRefersToParent);
    switch (length.Op) {
      case '+': return l + r;
      case '-': return l - r;
      case '*': return l * r;
      case '/': return l / r;
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
  | { T: 'lp' }
  | { T: 'rp' };

const _tokenize = (raw: string): _Token[] => {
  // Unit matching is case-insensitive — lower-case the whole input once.
  // Digits, operators, parens are unaffected.
  const s = raw.toLowerCase();
  const tokens: _Token[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if ((c >= '0' && c <= '9') || c === '.') {
      let j = i;
      while (j < s.length && ((s[j] >= '0' && s[j] <= '9') || s[j] === '.')) j++;
      const num = parseFloat(s.slice(i, j));
      if (Number.isNaN(num)) {
        throw new Error(`[Jwift] Malformed number in length expression: "${raw}"`);
      }
      tokens.push({ T: 'num', V: num });
      i = j;
      const unit = _matchUnit(s, i);
      if (unit) {
        tokens.push({ T: 'unit', V: unit });
        i += unit.length;
      }
      continue;
    }
    if (c === '(') { tokens.push({ T: 'lp' }); i++; continue; }
    if (c === ')') { tokens.push({ T: 'rp' }); i++; continue; }
    if (c === '+' || c === '-' || c === '*' || c === '/') {
      tokens.push({ T: 'op', V: c });
      i++;
      continue;
    }
    throw new Error(`[Jwift] Unexpected character "${c}" in length expression: "${raw}"`);
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
    throw new Error(`[Jwift] Unexpected trailing input in length: "${input}"`);
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
  if (!t) throw new Error('[Jwift] Unexpected end of length expression');

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
      throw new Error('[Jwift] Expected ")" in length expression');
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

  throw new Error(`[Jwift] Unexpected token in length expression at position ${s.pos}`);
};
