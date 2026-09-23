/**
 * VIBRANCY -- Apple's model for content that reads through a surface already dimming or blocking what
 * is behind it (UIVibrancyEffect; SwiftUI material vibrancy). Vibrancy.md next to this file has the
 * sources, the measured levels and the costs. One formula serves every zone:
 *
 *     out = dst * (1 - cover * a)  +/-  (|amount| / 255) * color * a          a = the draw's coverage
 *
 *   - `amount` is signed, in 0-255 units in every spelling, and its sign is where the theme flip lives:
 *     positive brings light through, negative darkens.
 *   - `cover` is 0..1: how much of what is under the draw it dims. 0 is pure plus-lighter (a wash, a
 *     glow); Apple's measured label is 0.55 in dark and 0.88 in light; 1 with amount 255 is ordinary ink.
 *   - `color` is white in the shape zones unless given, and the element's `Color` in the ink zone.
 *
 * ## ZONES: WHERE IT APPLIES
 *
 * | zone                              | shape draw          | own paint | descendants' paint |
 * |-----------------------------------|---------------------|-----------|--------------------|
 * | `BackdropFilter: Vibrancy(..)`    | yes                 | covers    | covers             |
 * | `Filter: Vibrancy(..)`            | yes                 | vibrant   | covers             |
 * | `Vibrancy: <color> <amount> [c]`  | yes, where AUTHORED | vibrant   | vibrant (cascades) |
 * | `TextFilter: Vibrancy(..)`        | no                  | ink only  | covers             |
 *
 * The SHAPE draw is one instance of the element's own silhouette (same SDF, radii, clip stack and
 * opacity as its fill) in `|amount|/255 * color`, drawn under everything of the element's own. The
 * ink zone emits no shape draw: the text is already its own batch, so it can be vibrant on glass while
 * the glass body samples its backdrop untouched. The ink zone takes no color argument, because the
 * ink already has one (`Color`); its amount scales that ink.
 *
 * The cascade carries a value like `color`. `Vibrancy: None` resets a node and its subtree;
 * `Isolate: true` is the barrier (the value neither arrives nor leaves). The shape draw is emitted
 * only where the value is AUTHORED, since a cascaded shape draw would treat the same pixels once per
 * descendant. Vibrancy therefore STACKS: vibrant content on a vibrant card is drawn twice, as light is.
 *
 * ## HOW IT IS DRAWN
 *
 * Every vibrancy draw writes PREMULTIPLIED `(rgb * a, cover * a)` (the panel and text programs'
 * `u_VibrancyCover`, -1 for every ordinary draw) under one blend family:
 *
 *     rgb    ONE, ONE_MINUS_SRC_ALPHA     FUNC_ADD, or FUNC_REVERSE_SUBTRACT for a negative amount
 *     alpha  shape: ZERO, ONE (a transparent element stays transparent)
 *            ink:   ONE, ONE_MINUS_SRC_ALPHA
 *
 * At cover 0 that is `dst + src * a`, at cover 1 with amount 255 it is ordinary source-over, and
 * between them it is Apple's label. No snapshot, no sampler, no render target.
 *
 * THE GRADED PATH. When something beside the shape draw already samples the backdrop (glass, a grade,
 * a frost, a Tint, a progressive blur), the vibrancy folds into the grade that fragment runs instead:
 *
 *     y = b*c*luma(x) + b*(1 - c)/2 + b*c*s*(x - luma(x))                      applyGrading
 *     (1 - k) y + L   =>   b' = (1 - k) b + 2L,   c' = (1 - k) b c / b'        k = cover, L = amount
 *
 * Saturation never enters: it multiplies chroma, and a gray vibrancy has none. The grade is three
 * scalars, so a CHROMATIC vibrancy on a graded element is refused by name (`ChromaticGraded`) rather
 * than drawn gray: the 60-float instance stride is exactly 15 of WebGL2's guaranteed 16 attributes.
 */

import type { JivRenderStyle } from '../Jiv/Jiv.Types';

/** Below this an amount or a cover draws nothing: 0.03 of one 8-bit step. */
export const VIBRANCY_EPSILON = 1e-4;

/** The grade epsilon `_hasBackdropFilter` and the panel fragment's `hasBackdropFilter` both use. */
const GRADE_EPSILON = 0.001;

/** A channel further than one 8-bit step from white makes a vibrancy CHROMATIC. */
const CHROMA_EPSILON = 1 / 255;

/** `?vibrancy=` -- `on` (default) lets the engine choose; `graded` sends every shape draw through the
 *  fold, the equivalence arm; `off` draws no vibrancy at all, the null arm. */
export type VibrancyMode = 'on' | 'graded' | 'off';

export class Vibrancy {
  /** Set once from the URL flags, before the first frame. */
  static Mode: VibrancyMode = 'on';
}

/** A vibrancy: a color, a signed amount as a fraction of full scale, and a cover. `Vibrancy(18)` is
 *  `{ R: 1, G: 1, B: 1, Amount: 18/255, Cover: 0 }`. */
export interface VibrancyValue {
  R: number;
  G: number;
  B: number;
  Amount: number;
  Cover: number;
}

/** A zone's amount and cover, without a color. Both 0 is no vibrancy. */
export interface VibrancyLevel {
  Amount: number;
  Cover: number;
}

/** The `Vibrancy:` property on one node, before the cascade: `'Inherit'` (not authored, the initial
 *  value), `'None'` (the reset), or a value authored here. */
export type VibrancyDeclaration = 'Inherit' | 'None' | VibrancyValue;

/** The GL state a vibrancy draw takes. `Shape` preserves destination alpha; `Ink` accumulates it. */
export interface VibrancyBlend {
  Target: 'Shape' | 'Ink';
  Subtract: boolean;
  Cover: number;
}

/** Why a shape draw did not go UNDER its element. The first eight choose the graded fold;
 *  `ChromaticGraded` is an author error, because the fold cannot carry chroma. */
export type VibrancyRefusal =
  | 'Glass' | 'ProgressiveBlur' | 'Grade' | 'Blur' | 'Tint' | 'Filter' | 'Shadow' | 'Forced'
  | 'ChromaticGraded';

/** White with nothing, shared and never mutated. */
export const VIBRANCY_WHITE: VibrancyValue = { R: 1, G: 1, B: 1, Amount: 0, Cover: 0 };

const NO_LEVEL: VibrancyLevel = { Amount: 0, Cover: 0 };

/** True when an amount or a cover would draw anything. */
export const VibrancyIsActive = (amount: number, cover: number): boolean =>
  Math.abs(amount) > VIBRANCY_EPSILON || cover > VIBRANCY_EPSILON;

/** The blend a vibrancy draw of this target takes. */
export const VibrancyBlendOf = (target: 'Shape' | 'Ink', amount: number, cover: number): VibrancyBlend =>
  ({ Target: target, Subtract: amount < 0, Cover: cover });

/** True when the color is white to within one 8-bit step, so the scalar grade can carry it. A vibrancy
 *  with no amount is gray whatever its color: only its cover folds. */
export const VibrancyIsGray = (v: VibrancyValue): boolean =>
  Math.abs(v.Amount) <= VIBRANCY_EPSILON
  || (Math.abs(v.R - 1) <= CHROMA_EPSILON && Math.abs(v.G - 1) <= CHROMA_EPSILON && Math.abs(v.B - 1) <= CHROMA_EPSILON);

const _gated = (amount: number, cover: number): VibrancyLevel =>
  Vibrancy.Mode === 'off' || !VibrancyIsActive(amount, cover) ? NO_LEVEL : { Amount: amount, Cover: cover };

/** The backdrop zone's level, zero when there is none or the null arm is armed. */
export const BackdropVibrancy = (rs: JivRenderStyle): VibrancyLevel =>
  _gated(rs.BackdropVibrancy, rs.BackdropVibrancyCover);

/** The foreground zone's level. */
export const ForegroundVibrancy = (rs: JivRenderStyle): VibrancyLevel =>
  _gated(rs.ForegroundVibrancy, rs.ForegroundVibrancyCover);

/** The ink zone's level. Read from the style, not the cascade: `TextFilter` is per element. */
export const TextVibrancy = (rs: JivRenderStyle): VibrancyLevel =>
  _gated(rs.TextVibrancy, rs.TextVibrancyCover);

/** A cascaded value's level, zero under the null arm. */
export const CascadedVibrancy = (v: VibrancyValue | null): VibrancyLevel =>
  v === null ? NO_LEVEL : _gated(v.Amount, v.Cover);

/** How much of its own color vibrant ink brings: `|amount|`, multiplied into the text instance's tint
 *  lane (an RGBA multiplier on the glyph raster), so no new attribute and no second atlas entry. Only
 *  the RGB is scaled: the premultiplied output multiplies by coverage once, as ordinary text does. */
export const VibrancyInkScale = (amount: number): number => Math.abs(amount);

/** True when this element draws anything vibrant, so nothing may treat it as an ordinary source-over
 *  panel: not the empty-panel cull, not the occlusion pre-pass, and not the retained layer cache (a
 *  capture's destination is a cleared target, and vibrancy over nothing is a different picture).
 *  `effective` is the cascade result; the node's own declaration is read too, so this is sound even
 *  before the cascade has run for the frame. Refusing too often costs an optimization; too rarely, a
 *  wrong picture. */
export const VibrancyTouchesInk = (rs: JivRenderStyle, effective: VibrancyValue | null): boolean => {
  if (Vibrancy.Mode === 'off') return false;
  if (effective !== null && VibrancyIsActive(effective.Amount, effective.Cover)) return true;
  if (VibrancyIsActive(rs.ForegroundVibrancy, rs.ForegroundVibrancyCover)) return true;
  if (VibrancyIsActive(rs.TextVibrancy, rs.TextVibrancyCover)) return true;
  const d = rs.VibrancyDeclaration;
  return d !== 'Inherit' && d !== 'None' && VibrancyIsActive(d.Amount, d.Cover);
};

/** What a shape draw needs to know about its element: its style and the CASCADED foreground grade. */
export interface VibrancySubject {
  RenderStyle: JivRenderStyle;
  EffectiveBrightness: number;
  EffectiveSaturation: number;
  EffectiveContrast: number;
}

/** True when this element's fragment reads its backdrop, so a shape draw under it and vibrant paint
 *  on it are both the wrong picture. */
export const VibrancySamplesBackdrop = (s: JivRenderStyle): boolean =>
  s.Material === 'LiquidGlass'
  || s.Material === 'ProgressiveBlur'
  || Math.abs(s.BackdropBrightness - 1) > GRADE_EPSILON
  || Math.abs(s.BackdropSaturation - 1) > GRADE_EPSILON
  || Math.abs(s.BackdropContrast - 1) > GRADE_EPSILON
  || s.BackdropFrostBlur > GRADE_EPSILON
  || Math.abs(s.Tint) > GRADE_EPSILON;

/** The foreground grade as the fragment sees it after `_packFgGrade`'s quantisation. */
const _fgIsIdentity = (b: number, s: number, c: number): boolean =>
  (!Number.isFinite(b) || Math.round(b * 256) === 256)
  && (!Number.isFinite(s) || Math.round(s * 32) === 32)
  && (!Number.isFinite(c) || Math.round(c * 32) === 32);

/** Null when the backdrop zone's shape draw can go under the element; otherwise the FIRST reason it
 *  cannot, in the order the fragment would meet them. */
export const VibrancyRefusalOf = (n: VibrancySubject, color: VibrancyValue = VIBRANCY_WHITE): VibrancyRefusal | null => {
  const s = n.RenderStyle;
  const graded = (why: VibrancyRefusal): VibrancyRefusal => (VibrancyIsGray(color) ? why : 'ChromaticGraded');
  if (Vibrancy.Mode === 'graded') return graded('Forced');
  if (s.Material === 'LiquidGlass') return graded('Glass');
  if (s.Material === 'ProgressiveBlur') return graded('ProgressiveBlur');
  if (Math.abs(s.BackdropBrightness - 1) > GRADE_EPSILON
    || Math.abs(s.BackdropSaturation - 1) > GRADE_EPSILON
    || Math.abs(s.BackdropContrast - 1) > GRADE_EPSILON) return graded('Grade');
  if (s.BackdropFrostBlur > GRADE_EPSILON) return graded('Blur');
  if (Math.abs(s.Tint) > GRADE_EPSILON) return graded('Tint');
  // The graded fragment grades its whole result, backdrop included, by the foreground Filter.
  if (!_fgIsIdentity(n.EffectiveBrightness, n.EffectiveSaturation, n.EffectiveContrast)) return graded('Filter');
  // The graded fill is opaque over the backdrop, so it hides the element's own drop shadow under its
  // shape; a transparent element over a shape draw shows it.
  if (s.ShadowColor.A > GRADE_EPSILON) return graded('Shadow');
  return null;
};

/** The backdrop zone's level folded into this element's grade: zero when it has none, draws it
 *  under, or is refused as chromatic (that one throws at the walk). */
export const VibrancyGraded = (n: VibrancySubject): VibrancyLevel => {
  const v = BackdropVibrancy(n.RenderStyle);
  if (!VibrancyIsActive(v.Amount, v.Cover)) return NO_LEVEL;
  const c = n.RenderStyle.BackdropVibrancyColor;
  const r = VibrancyRefusalOf(n, { R: c.R, G: c.G, B: c.B, Amount: v.Amount, Cover: v.Cover });
  return r === null || r === 'ChromaticGraded' ? NO_LEVEL : v;
};

/** The grade pair that dims by `cover` and adds `amount` after `(brightness, contrast)` (see the
 *  header). A zero level returns the inputs unchanged, so an element with none keeps its exact floats. */
export const FoldVibrancy = (brightness: number, contrast: number, level: VibrancyLevel): { Brightness: number; Contrast: number } => {
  if (level.Amount === 0 && level.Cover === 0) return { Brightness: brightness, Contrast: contrast };
  const keep = 1 - level.Cover;
  const b = keep * brightness + 2 * level.Amount;
  if (!(b > GRADE_EPSILON)) {
    throw new Error(
      `[Jaui] Vibrancy(${Math.round(level.Amount * 255)}, ${level.Cover}) cannot be folded into Brightness(${brightness}): ` +
      `the grade's brightness would be ${b.toFixed(4)}. A vibrancy that deep only exists as a shape draw; drop the other ` +
      'backdrop functions.',
    );
  }
  return { Brightness: b, Contrast: (keep * brightness * contrast) / b };
};

/** ONE step of the cascade, the same shape as `_cascadeFilterGrade`'s:
 *
 *      inherited = (isRoot || Isolate) ? null : parent
 *      self      = decl === 'None' ? null : decl === 'Inherit' ? inherited : decl
 *      children  = Isolate ? null : self */
export const CascadeVibrancy = (
  decl: VibrancyDeclaration,
  parent: VibrancyValue | null,
  isRoot: boolean,
  isolate: boolean,
): { Self: VibrancyValue | null; Authored: boolean; ToChildren: VibrancyValue | null } => {
  const inherited = isRoot || isolate ? null : parent;
  const authored = decl !== 'Inherit' && decl !== 'None';
  const self = decl === 'None' ? null : decl === 'Inherit' ? inherited : decl;
  return { Self: self, Authored: authored, ToChildren: isolate ? null : self };
};

/** The effect field. `VibrancyGateLine` formats the `jaui:vibrancy` line FROM it, so the gate line and
 *  `__jauiVibrancy()` cannot print different numbers. */
export interface VibrancyCensus {
  Armed: VibrancyMode;
  /** Shape-zone vibrancy declared on the node that applied it. */
  Authored: number;
  /** Vibrancy that arrived through the cascade: vibrant paint, no shape draw. */
  Inherited: number;
  /** Inherited vibrancy a node DROPPED because it samples its backdrop. Not an error. */
  IgnoredSampling: number;
  /** Nodes whose ink was vibrant because of the `TextFilter` zone. It emits no shape draw, so it never
   *  raises `Under` or `Graded`; it does raise `Blends`, because the ink takes a batch of its own. */
  TextInk: number;
  /** The shape draw's two implementations. */
  Under: number;
  Graded: number;
  /** Pyramid builds caused by an under-drawn element's own paint. MUST BE 0. */
  Builds: number;
  /** The cascade's own cost: nodes the walk visited, and how many came out carrying a value. */
  CascadeVisited: number;
  CascadeCarried: number;
  /** Shared Color-batch draws. A shape draw landing mid-run splits one batch into two. */
  PanelBatches: number;
  /** Counted at the draw call, on the renderer. */
  ShapeDraws: number;
  Blends: number;
  BlendSwitches: number;
  /** Why each graded shape draw could not go under, by name. */
  Refused: Record<string, number>;
}

/** The `jaui:vibrancy` gate line, formatted from the census and from nothing else. */
export const VibrancyGateLine = (c: VibrancyCensus): string => {
  const refused = Object.keys(c.Refused).sort().map((k) => `${k}:${c.Refused[k]}`).join(',');
  return `jaui:vibrancy armed=${c.Armed}`
    + ` vibrancies=${c.Authored + c.Inherited} authored=${c.Authored} inherited=${c.Inherited}`
    + ` ignoredSampling=${c.IgnoredSampling}`
    + ` textInk=${c.TextInk}`
    + ` under=${c.Under} graded=${c.Graded}`
    + ` shapeDraws=${c.ShapeDraws} builds=${c.Builds}`
    + ` cascadeVisited=${c.CascadeVisited} cascadeCarried=${c.CascadeCarried}`
    + ` blends=${c.Blends} blendSwitches=${c.BlendSwitches} panelBatches=${c.PanelBatches}`
    + ` refused=${refused === '' ? 'none' : refused}`;
};
