import { Parse as ParseLength, Resolve, type ResolveContext } from './Length';

/**
 * Parser for CSS-style space-separated length tuples. Supports the standard
 * 1 / 2 / 4-value shorthand collapse:
 *
 *   "10"                → [10, 10, 10, 10]          (all sides)
 *   "10 20"             → [10, 20, 10, 20]          (T/B, L/R)
 *   "10 20 30"          → [10, 20, 30, 20]          (T, L/R, B)
 *   "10 20 30 40"       → [10, 20, 30, 40]          (T, R, B, L — clockwise)
 *   "@A - @B"           → 1-tuple with the expression "@A - @B"
 *
 * Components are space-separated, but whitespace that sits *between a value
 * and a binary operator* (or vice-versa) is folded into the current
 * expression. That means:
 *
 *   "@A - @B"           → 1 component ("@A - @B")
 *   "(@A - @B) @C"      → 2 components
 *   "10 -5"             → 2 components (CSS-style negative value; unary `-`
 *                         is distinguished from binary `-` by the absence of
 *                         whitespace after the operator)
 *   "10 - 5"            → 1 component — binary minus
 *
 * Two parsers live here:
 *   ParseLengthTuple4 — splits string into component tokens, caches the split
 *   ResolveLengthTuple4 — splits + resolves each against the given ctx
 */

// A "token" here is one whitespace-separated component from the raw string.
// Parens group their contents so "(1pt + 4) 2pt" is two tokens, not four.
const _splitCache = new Map<string, string[]>();

const _isOp = (c: string): boolean =>
  c === '+' || c === '-' || c === '*' || c === '/';

const _isWs = (c: string): boolean =>
  c === ' ' || c === '\t' || c === '\n' || c === '\r';

const _splitComponents = (raw: string): string[] => {
  const hit = _splitCache.get(raw);
  if (hit !== undefined) return hit;

  const out: string[] = [];
  let depth = 0;
  let current = '';
  let lastNonWs = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '(') { depth++; current += c; lastNonWs = c; continue; }
    if (c === ')') { depth--; current += c; lastNonWs = c; continue; }
    if (depth === 0 && _isWs(c)) {
      if (current.length === 0) continue;

      // If the last non-ws char was a binary operator, we're mid-expression
      // waiting for the RHS — fold the space into `current`.
      if (_isOp(lastNonWs)) { current += ' '; continue; }

      // Peek past this run of whitespace. If the next non-ws char is an
      // operator AND it's followed by whitespace (or end-of-string), it's
      // a binary op; fold. `*` / `/` are always binary. `+` / `-` with no
      // space after are unary signs on the next token (CSS negative padding).
      let j = i + 1;
      while (j < raw.length && _isWs(raw[j])) j++;
      if (j < raw.length && _isOp(raw[j])) {
        const op = raw[j];
        const after = j + 1 < raw.length ? raw[j + 1] : '';
        const isBinary =
          op === '*' || op === '/' ||
          after === '' || _isWs(after);
        if (isBinary) { current += ' '; continue; }
      }

      out.push(current);
      current = '';
      lastNonWs = '';
      continue;
    }
    current += c;
    lastNonWs = c;
  }
  if (current.length > 0) out.push(current);

  _splitCache.set(raw, out);
  return out;
};

/** Parse a space-separated length tuple into its component strings, applying
 *  CSS-style 1/2/3/4-value shorthand collapse. Returned array always has
 *  exactly 4 entries ordered [top, right, bottom, left] for box props, or
 *  [tl, tr, br, bl] for corner props — the shape is the same; the caller
 *  decides how to interpret positions. */
export const ParseLengthTuple4 = (raw: string | number): [string, string, string, string] => {
  // Bare number means all-sides.
  if (typeof raw === 'number') {
    const s = String(raw);
    return [s, s, s, s];
  }
  const parts = _splitComponents(raw);
  switch (parts.length) {
    case 1: return [parts[0], parts[0], parts[0], parts[0]];
    case 2: return [parts[0], parts[1], parts[0], parts[1]];
    case 3: return [parts[0], parts[1], parts[2], parts[1]];
    case 4: return [parts[0], parts[1], parts[2], parts[3]];
    default:
      throw new Error(`[Jwift] Length tuple needs 1, 2, 3, or 4 components; got ${parts.length}: "${raw}"`);
  }
};

/** Resolve a length-tuple string to 4 pixel numbers. Callers pass the axis
 *  mapping per position — for Padding/Margin it's [H, W, H, W]; for
 *  BorderRadius it's [W, W, W, W]. */
export const ResolveLengthTuple4 = (
  raw: string | number,
  ctx: ResolveContext,
  axes: ['W' | 'H', 'W' | 'H', 'W' | 'H', 'W' | 'H'],
): [number, number, number, number] => {
  const tuple = ParseLengthTuple4(raw);
  return [
    Resolve(tuple[0], ctx, axes[0]),
    Resolve(tuple[1], ctx, axes[1]),
    Resolve(tuple[2], ctx, axes[2]),
    Resolve(tuple[3], ctx, axes[3]),
  ];
};

/** Used by tests / JSS to verify parse correctness. */
export const _DebugParseLengthTuple = (raw: string): Array<ReturnType<typeof ParseLength>> => {
  return _splitComponents(raw).map((c) => ParseLength(c));
};
