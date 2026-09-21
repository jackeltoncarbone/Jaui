/**
 * `BackdropFilter: Lift(n)` -- one authored number, two implementations, and the engine picks.
 *
 * A lift adds the signed constant `L = n / 255` to every channel of whatever is painted beneath the
 * element, inside the element's shape, scaled by its coverage and opacity. It carries the colour at 1
 * (a constant added to all three channels moves luma and leaves chroma where it was), and it never
 * touches the element's own ink.
 *
 * UNDER. `Lift(n)` with nothing else that samples the backdrop. No snapshot, no pyramid: one extra
 * panel instance in the element's own shape (same SDF, same radii, same clip stack) drawn BEFORE the
 * element's own panel, with blend state
 *
 *     L > 0   FUNC_ADD               rgb: dst + src * srcA     alpha: dst
 *     L < 0   FUNC_REVERSE_SUBTRACT  rgb: dst - src * srcA     alpha: dst
 *
 * where src = |L| on every channel and srcA = coverage * opacity * clip. Both are exact per-channel
 * offsets; neither is a multiply, so neither scales chroma. The element's fill, border, shadow and
 * text are separate draws that come after, so the ink is never in the blend.
 *
 * GRADED. `Lift(n)` next to anything that already samples (Brightness / Saturate / Contrast, Blur, a
 * glass body, a Tint, a progressive blur): the fragment is reading the backdrop anyway, so the lift is
 * folded into the grade it already runs. `applyGrading` is contrast about 0.5, then saturate about
 * luma, then brightness:
 *
 *     y = b*c*luma(x) + b*(1 - c)/2 + b*c*s*(x - luma(x))
 *
 * An additive L after the grade is a new pair (b', c') with the same GAIN (b'c' = bc, so the chroma
 * term b*c*s and the luma slope are untouched) and an offset larger by exactly L:
 *
 *     b'(1 - c')/2 = b(1 - c)/2 + L   and   b'c' = bc   =>   b' = b + 2L,   c' = b*c / (b + 2L)
 *
 * which at the identity grade (b = c = 1) is the washeffect pair b = 1 + 2L, c = 1/b. The naive
 * composition, multiplying the pairs (b * (1+2L), c / (1+2L)), keeps the gain too but its offset is
 * b(1 - c)/2 + b*L: it scales the lift by the authored Brightness, which is not what was written.
 * Saturate never enters: it multiplies the chroma, and a lift has none. So the lift lands LAST in the
 * grade, before a glass body's Tint (which runs after the grade in both the shader and this fold).
 *
 * Both paths put `x + L * coverage` on screen for a transparent element: UNDER by the blend unit,
 * GRADED as `(x + L) * a + x * (1 - a)` through the ordinary source-over. They are held to agree in
 * `tests/Lift.Equivalence.test.ts`.
 *
 * Why the choice is made HERE, at draw time, and not in the resolver: the foreground `Filter`
 * cascades, and the graded path's fragment grades its WHOLE result -- the lifted backdrop included --
 * by it. An additive blend cannot apply a multiply, so an element under a non-identity foreground
 * grade takes the graded path, and the cascaded grade only exists after the resolve.
 */

import type { JivRenderStyle } from '../Jiv/Jiv.Types';

/** A lift smaller than this draws nothing: 0.03 of one 8-bit step. */
export const LIFT_EPSILON = 1e-4;

/** The grade epsilon `_hasBackdropFilter` and the panel fragment's `hasBackdropFilter` both use. */
const GRADE_EPSILON = 0.001;

/** `?lift=` -- `on` (default) lets the engine choose; `graded` sends every lift through the fold, the
 *  equivalence arm; `off` draws no lift at all, the null arm. */
export type LiftMode = 'on' | 'graded' | 'off';

/** The four blend states a draw can take that compose against the destination instead of over it:
 *  the two signs of a lift's under-draw and the two element `BlendMode`s. `WebGL2Renderer.SetCompositeBlend`. */
export type CompositeBlend = 'LiftAdd' | 'LiftSubtract' | 'PlusLighter' | 'Screen';

/** Why a lift did not take the under-draw. The census prints these by name. */
export type LiftRefusal = 'Glass' | 'ProgressiveBlur' | 'Grade' | 'Blur' | 'Tint' | 'Filter' | 'Shadow' | 'Forced';

/** What a lift needs to know about its element: the resolved style and the CASCADED foreground grade. */
export interface LiftSubject {
  RenderStyle: JivRenderStyle;
  EffectiveBrightness: number;
  EffectiveSaturation: number;
  EffectiveContrast: number;
}

export class Lift {
  /** Set once from the URL flags, before the first frame. */
  static Mode: LiftMode = 'on';
}

/** The foreground grade as the fragment sees it after `_packFgGrade`'s quantisation. */
const _fgIsIdentity = (b: number, s: number, c: number): boolean =>
  (!Number.isFinite(b) || Math.round(b * 256) === 256)
  && (!Number.isFinite(s) || Math.round(s * 32) === 32)
  && (!Number.isFinite(c) || Math.round(c * 32) === 32);

/** The authored lift, 0 when there is none or the null arm is armed. */
export const LiftAmount = (rs: JivRenderStyle): number => {
  if (Lift.Mode === 'off') return 0;
  const l = rs.BackdropLift;
  return Math.abs(l) > LIFT_EPSILON ? l : 0;
};

/** Null when the lift can be drawn under the element; otherwise the FIRST reason it cannot, in the
 *  order the fragment would meet them. Asked only of an element that has a lift. */
export const LiftRefusalOf = (n: LiftSubject): LiftRefusal | null => {
  const s = n.RenderStyle;
  if (Lift.Mode === 'graded') return 'Forced';
  if (s.Material === 'LiquidGlass') return 'Glass';
  if (s.Material === 'ProgressiveBlur') return 'ProgressiveBlur';
  if (Math.abs(s.BackdropBrightness - 1) > GRADE_EPSILON
    || Math.abs(s.BackdropSaturation - 1) > GRADE_EPSILON
    || Math.abs(s.BackdropContrast - 1) > GRADE_EPSILON) return 'Grade';
  if (s.BackdropFrostBlur > GRADE_EPSILON) return 'Blur';
  if (Math.abs(s.Tint) > GRADE_EPSILON) return 'Tint';
  // The graded fragment grades its whole result, backdrop included, by the foreground Filter.
  if (!_fgIsIdentity(n.EffectiveBrightness, n.EffectiveSaturation, n.EffectiveContrast)) return 'Filter';
  // The graded fill is opaque over the backdrop (`fillA = fillAlpha`), so it hides the element's own
  // drop shadow under its shape; a transparent element over an under-draw shows it. Same picture
  // only without one.
  if (s.ShadowColor.A > GRADE_EPSILON) return 'Shadow';
  return null;
};

/** The lift this element draws UNDER itself, 0 when it has none or takes the graded path. */
export const LiftUnder = (n: LiftSubject): number => {
  const l = LiftAmount(n.RenderStyle);
  return l !== 0 && LiftRefusalOf(n) === null ? l : 0;
};

/** The lift folded into this element's backdrop grade, 0 when it has none or draws it under. */
export const LiftGraded = (n: LiftSubject): number => {
  const l = LiftAmount(n.RenderStyle);
  return l !== 0 && LiftRefusalOf(n) !== null ? l : 0;
};

/** The grade pair that adds `lift` after `(brightness, contrast)`. Saturation is untouched (see the
 *  header). `lift === 0` returns the inputs unchanged, not a recomputed pair, so an element with no
 *  lift keeps its exact floats. */
export const FoldLift = (brightness: number, contrast: number, lift: number): { Brightness: number; Contrast: number } => {
  if (lift === 0) return { Brightness: brightness, Contrast: contrast };
  const b = brightness + 2 * lift;
  if (!(b > GRADE_EPSILON)) {
    throw new Error(
      `[Jaui] Lift(${Math.round(lift * 255)}) cannot be folded into Brightness(${brightness}): the grade's brightness ` +
      `would be ${b.toFixed(4)}. A lift that deep only exists as an under-draw; drop the other backdrop functions.`,
    );
  }
  return { Brightness: b, Contrast: (brightness * contrast) / b };
};
