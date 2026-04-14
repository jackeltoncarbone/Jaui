import { Parse as ParseLength, Resolve, type ResolveContext } from './Length';

/**
 * Parser for CSS-style space-separated length tuples. Supports the standard
 * 1 / 2 / 4-value shorthand collapse:
 *
 *   "10"                → [10, 10, 10, 10]          (all sides)
 *   "10 20"             → [10, 20, 10, 20]          (T/B, L/R)
 *   "10 20 30"          → [10, 20, 30, 20]          (T, L/R, B)
 *   "10 20 30 40"       → [10, 20, 30, 40]          (T, R, B, L — clockwise)
 *   "1pt + 4 2pt"       → [20, 32, 20, 32]          (arithmetic per component)
 *
 * Components are space-separated; arithmetic WITHIN a component uses
 * plus/minus/times/divide and must not contain spaces around operators
 * (otherwise the tokenizer would split mid-expression). In practice that
 * means parens around multi-term components:
 *
 *   "(1pt + 4) 2pt"     → 4-tuple with first = parsed expression
 *
 * Two parsers live here:
 *   ParseLengthTuple4 — splits string into component tokens, caches the split
 *   ResolveLengthTuple4 — splits + resolves each against the given ctx
 */

// A "token" here is one whitespace-separated component from the raw string.
// Parens group their contents so "(1pt + 4) 2pt" is two tokens, not four.
const _splitCache = new Map<string, string[]>();

const _splitComponents = (raw: string): string[] => {
  const hit = _splitCache.get(raw);
  if (hit !== undefined) return hit;

  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '(') { depth++; current += c; continue; }
    if (c === ')') { depth--; current += c; continue; }
    if (depth === 0 && (c === ' ' || c === '\t' || c === '\n' || c === '\r')) {
      if (current.length > 0) { out.push(current); current = ''; }
      continue;
    }
    current += c;
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
