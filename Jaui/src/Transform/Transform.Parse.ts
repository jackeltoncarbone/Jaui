import { Resolve, type ResolveContext } from '../Core/Length';
import type { Transform } from './Transform.Types';
import { DefaultTransform } from './Transform.Types';

/**
 * Parser for CSS-style transform strings. Accepts function-syntax — any order,
 * any subset — and produces a resolved Transform object (all fields numeric).
 *
 *   "translate(1pt, 2pt)"            → TranslateX = 1 × PointScale, etc.
 *   "scale(1.5)"                     → ScaleX = ScaleY = 1.5
 *   "scale(1.5, 0.8)"                → ScaleX = 1.5, ScaleY = 0.8
 *   "rotate(45)"                     → Rotation = 45
 *   "skew(10, 0)"                    → SkewX = 10, SkewY = 0
 *   "origin(0.5, 0.5)"               → OriginX = OriginY = 0.5
 *   "translate(1pt, 2pt) scale(1.5)" → composed
 *
 * Unrecognized functions throw with a clear message. Each argument is
 * parsed as a Length and resolved against the given context.
 *
 * Parsed ASTs (the split-into-function-calls form) are cached per raw
 * string so repeated resolution doesn't re-split.
 */

interface _Call { Name: string; Args: string[]; }

const _splitCache = new Map<string, _Call[]>();

/** Split a transform string into function calls. Not resolved — just
 *  syntactic. Cached per raw input. */
const _split = (raw: string): _Call[] => {
  const hit = _splitCache.get(raw);
  if (hit !== undefined) return hit;

  const calls: _Call[] = [];
  let i = 0;
  const s = raw;
  while (i < s.length) {
    // Skip whitespace
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;

    // Read function name (letters)
    const nameStart = i;
    while (i < s.length && /[a-zA-Z]/.test(s[i])) i++;
    const name = s.slice(nameStart, i).toLowerCase();
    if (name.length === 0) {
      throw new Error(`[Jaui] Unexpected character "${s[i]}" in transform: "${raw}"`);
    }

    // Expect '('
    while (i < s.length && /\s/.test(s[i])) i++;
    if (s[i] !== '(') {
      throw new Error(`[Jaui] Expected "(" after "${name}" in transform: "${raw}"`);
    }
    i++;

    // Read args until ')' — comma or space separated, respecting nested parens
    let depth = 1;
    let arg = '';
    const args: string[] = [];
    while (i < s.length && depth > 0) {
      const c = s[i];
      if (c === '(') { depth++; arg += c; i++; continue; }
      if (c === ')') {
        depth--;
        if (depth === 0) { i++; break; }
        arg += c; i++; continue;
      }
      if (depth === 1 && c === ',') {
        args.push(arg.trim());
        arg = '';
        i++;
        continue;
      }
      arg += c;
      i++;
    }
    if (arg.trim().length > 0) args.push(arg.trim());

    calls.push({ Name: name, Args: args });
  }

  _splitCache.set(raw, calls);
  return calls;
};

/** Resolve a transform string into the full Transform object, starting from
 *  defaults and applying each function-call in order. */
export const ResolveTransform = (raw: string, ctx: ResolveContext): Transform => {
  const out: Transform = { ...DefaultTransform };
  if (raw === '' || raw === 'none') return out;
  const calls = _split(raw);
  for (const call of calls) {
    _applyCall(call, out, ctx);
  }
  return out;
};

const _applyCall = (call: _Call, out: Transform, ctx: ResolveContext): void => {
  const { Name: n, Args: a } = call;
  switch (n) {
    case 'translate': {
      if (a.length !== 2) throw new Error(`[Jaui] translate() needs 2 args, got ${a.length}`);
      out.TranslateX = Resolve(a[0], ctx, 'W');
      out.TranslateY = Resolve(a[1], ctx, 'H');
      return;
    }
    case 'translatex': {
      if (a.length !== 1) throw new Error(`[Jaui] translateX() needs 1 arg, got ${a.length}`);
      out.TranslateX = Resolve(a[0], ctx, 'W');
      return;
    }
    case 'translatey': {
      if (a.length !== 1) throw new Error(`[Jaui] translateY() needs 1 arg, got ${a.length}`);
      out.TranslateY = Resolve(a[0], ctx, 'H');
      return;
    }
    case 'translatez': {
      if (a.length !== 1) throw new Error(`[Jaui] translateZ() needs 1 arg, got ${a.length}`);
      out.TranslateZ = Resolve(a[0], ctx, 'W');
      return;
    }
    case 'scale': {
      if (a.length === 1) {
        const s = Resolve(a[0], ctx, 'W');
        out.ScaleX = s; out.ScaleY = s;
      } else if (a.length === 2) {
        out.ScaleX = Resolve(a[0], ctx, 'W');
        out.ScaleY = Resolve(a[1], ctx, 'H');
      } else {
        throw new Error(`[Jaui] scale() needs 1 or 2 args, got ${a.length}`);
      }
      return;
    }
    case 'scalex': out.ScaleX = Resolve(a[0], ctx, 'W'); return;
    case 'scaley': out.ScaleY = Resolve(a[0], ctx, 'H'); return;
    case 'rotate': out.Rotation = Resolve(a[0], ctx, 'W'); return;
    case 'rotatex': out.RotateX = Resolve(a[0], ctx, 'W'); return;
    case 'rotatey': out.RotateY = Resolve(a[0], ctx, 'W'); return;
    case 'skew': {
      if (a.length === 1) { out.SkewX = Resolve(a[0], ctx, 'W'); out.SkewY = 0; }
      else if (a.length === 2) {
        out.SkewX = Resolve(a[0], ctx, 'W');
        out.SkewY = Resolve(a[1], ctx, 'H');
      } else throw new Error(`[Jaui] skew() needs 1 or 2 args, got ${a.length}`);
      return;
    }
    case 'skewx': out.SkewX = Resolve(a[0], ctx, 'W'); return;
    case 'skewy': out.SkewY = Resolve(a[0], ctx, 'H'); return;
    case 'origin': {
      if (a.length !== 2) throw new Error(`[Jaui] origin() needs 2 args, got ${a.length}`);
      out.OriginX = Resolve(a[0], ctx, 'W');
      out.OriginY = Resolve(a[1], ctx, 'H');
      return;
    }
    default:
      throw new Error(`[Jaui] Unknown transform function "${n}"`);
  }
};
