import type { BlurStop, ProgressiveBlurDirection } from '../Jiv/Jiv.Types';
import { MAX_BLUR_STOPS } from '../Jiv/Jiv.Types';

export interface ParsedProgressiveBlur {
  /** Axis the spectrum runs along, derived from the gradient angle. */
  Direction: ProgressiveBlurDirection;
  Stops: BlurStop[];
}

/**
 * Parse a `ProgressiveBlur` authored value into a blur spectrum, using the same
 * readable gradient syntax as `Background` — `LinearGradient(angle, <stop>, …)`
 * — except each stop carries a scalar BLUR amount instead of a color:
 *
 *   ProgressiveBlur: LinearGradient(180deg, 1 0%, 0 28% ease 1.6, 1 56%, 0 80%, 1 100%)
 *
 * Each stop is `<amount> <position> [ease <e>]` where `amount` ∈ [0,1]
 * (0 = clear/sharp, 1 = max blur), `position` accepts `0..1` or `%`, and the
 * optional `ease <e>` is the exponent on the segment FROM this stop to the next.
 * The angle selects the axis (≈90°/270° → horizontal, else vertical). Returns
 * `null` for an unusable spec (caller falls back to the linear feather).
 */
export const ParseProgressiveBlur = (raw: string): ParsedProgressiveBlur | null => {
  const s = raw.trim();
  const open = s.indexOf('(');
  const close = s.lastIndexOf(')');
  if (open < 0 || close < 0 || close < open) return null;
  const args = _splitTopLevel(s.slice(open + 1, close));
  if (args.length < 2) return null;

  let direction: ProgressiveBlurDirection = 'ToBottom';
  let stopArgs = args;
  // A leading single-token arg is the angle (stops always have ≥2 tokens).
  const firstTokens = args[0].trim().split(/\s+/).filter(t => t.length);
  if (firstTokens.length === 1) {
    const angle = _tryAngleDeg(firstTokens[0]);
    if (angle !== null) {
      direction = _angleToDirection(angle);
      stopArgs = args.slice(1);
    }
  }

  const stops: BlurStop[] = [];
  for (const a of stopArgs) {
    const tokens = a.trim().split(/\s+/).filter(t => t.length);
    if (tokens.length < 2) continue;
    const value = _num(tokens[0]);
    const position = _num(tokens[1]);
    if (Number.isNaN(value) || Number.isNaN(position)) continue;
    let easing = 1;
    const ei = tokens.findIndex(t => t.toLowerCase() === 'ease');
    if (ei >= 0 && ei + 1 < tokens.length) {
      const e = parseFloat(tokens[ei + 1]);
      if (!Number.isNaN(e) && e > 0) easing = e;
    }
    stops.push({ Position: _clamp01(position), Value: _clamp01(value), Easing: easing });
  }
  if (stops.length < 2) return null;
  stops.sort((a, b) => a.Position - b.Position);
  return {
    Direction: direction,
    Stops: stops.length > MAX_BLUR_STOPS ? stops.slice(0, MAX_BLUR_STOPS) : stops,
  };
};

/** Split top-level commas, respecting nested parens (so `rgb(…)`-style tokens
 *  inside a stop never split). */
const _splitTopLevel = (raw: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      out.push(raw.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = raw.slice(start).trim();
  if (last.length > 0) out.push(last);
  return out;
};

const _tryAngleDeg = (raw: string): number | null => {
  const m = /^(-?\d+(?:\.\d+)?)(deg|rad|turn)?$/.exec(raw.trim().toLowerCase());
  if (!m) return null;
  const v = parseFloat(m[1]);
  if (Number.isNaN(v)) return null;
  const unit = m[2] ?? 'deg';
  if (unit === 'rad') return (v * 180) / Math.PI;
  if (unit === 'turn') return v * 360;
  return v;
};

/** CSS gradient angle → blur axis. 0°/180° = vertical, 90°/270° = horizontal. */
const _angleToDirection = (deg: number): ProgressiveBlurDirection => {
  const d = ((deg % 360) + 360) % 360;
  const horizontal = (d >= 45 && d < 135) || (d >= 225 && d < 315);
  return horizontal ? 'ToRight' : 'ToBottom';
};

const _num = (raw: string): number => {
  const t = raw.trim();
  if (t.endsWith('%')) {
    const v = parseFloat(t.slice(0, -1));
    return Number.isNaN(v) ? NaN : v / 100;
  }
  return parseFloat(t);
};

const _clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
