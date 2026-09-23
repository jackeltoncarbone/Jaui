/**
 * `Lift(<color>, <amount>)` -- AN ADDITIVE COLOR. Where an ordinary color covers what is beneath it,
 * an additive color adds to it.
 *
 * The value is a color times a signed amount, and the amount is where the theme flip lives:
 *
 *     Lift(rgb(255, 255, 255), @JwiftWashLift)      // @JwiftWashLift = 18 * @Dark - 12 * @Light
 *     Lift(rgb(255, 220, 180), @JwiftWashLift)      // the same var against a warm color
 *     Lift(18)                                      // white times 18, the one-argument spelling
 *
 * The amount is in 0-255 units in EVERY spelling, signed, and it is stored here as `n / 255`.
 * `Lift(18)` is therefore `Lift(rgb(255,255,255), 18)` to the bit: the one-argument form is the
 * two-argument form with a white color, not a different code path. There is NO `Sink` -- the negative
 * is the amount's sign, which is where the theme flip already lives. Positive adds the color,
 * negative subtracts it.
 *
 * ## THREE ZONES, AND THE PLACE SAYS WHICH SIDE OF THE ELEMENT IT TOUCHES
 *
 * One mechanism serves all three. `Lift(c, n)` puts an ADDITIVE DRAW of the element's own shape, in
 * `|n|/255 * c` at the element's own coverage, into the destination before anything of the element
 * paints. The zones differ only in whether the element's -- and its descendants' -- own INK then
 * COVERS that destination or ADDS to it:
 *
 * | zone                       | additive shape draw    | own ink | descendants' ink |
 * |----------------------------|------------------------|---------|------------------|
 * | `BackdropFilter: Lift(..)` | yes                    | covers  | covers           |
 * | `Filter: Lift(..)`         | yes                    | ADDS    | covers           |
 * | `Lift: <color> <amount>`   | yes, where AUTHORED    | ADDS    | ADD (cascades)   |
 * | `TextFilter: Lift(n)`      | NO                     | ADDS    | covers           |
 *
 * `TextFilter` is the FOURTH row and the odd one: it emits no shape draw at all. It exists because the
 * other three cannot say "only the ink" -- an element's fill, border, shadow and text are ONE draw, so
 * `Filter: Lift()` moves all four together. The ink is the one of the four that is already drawn
 * separately (its own batch, its own atlas, after the material has committed), so it is the one that
 * can be separated. That also means `TextFilter` WORKS ON GLASS, where an authored foreground lift is
 * refused: the glass body is a different draw and is left alone.
 *
 * Its amount SCALES the ink rather than only flipping its sign. That is not an inconsistency with the
 * foreground zone: the amount always says "how much" of whatever the zone paints, and in the
 * foreground zone the amount is already spent on the SHAPE draw (so only its sign is left for the
 * ink). With no shape draw, the amount has nothing else to mean. `TextFilter` takes the ONE-argument
 * form only -- the ink's color is `Color`, and `Filter.Parse._refuseInText` says why a second color
 * there would be a different meaning for the same word.
 *
 * So a FULLY TRANSPARENT element gets the same pixels from the backdrop zone and the foreground zone.
 * That is not a defect and it is not a collapse of the design: it is Jack's own reading of it --
 * "or foreground only which is just all of it technically". An element with paint is where they part.
 *
 * The additive draw is emitted ONCE, at the node where the lift is AUTHORED. An INHERITED lift never
 * emits one, because cascading a backdrop op would lift the same pixels once per descendant -- the one
 * variant to argue against rather than build.
 *
 * ## THE CASCADE CARRIES A VALUE, LIKE `color`
 *
 * `Lift: <color> <amount>` is one more field on the walk that already cascades `Filter` and `Opacity`.
 * No new pass, no render target, no copy -- which is the whole reason the shape is affordable on the
 * phone, where a per-subtree target is the cost class this week has been spent deleting.
 *
 * Additive therefore STACKS: a label on an additive card adds twice, two overlapping additive siblings
 * double. That is what light does, and it is the cheap default. What CSS got wrong is that
 * `mix-blend-mode` looks like a color property and costs a compositing layer -- it reads as free and
 * allocates a target. An Apple-designed replacement would not hide a render target behind a property
 * that looks like `color`.
 *
 *   - `Lift: None` is the reset, per node AND its subtree -- the `color: black` override.
 *   - `Isolate: true` is the subtree barrier. It already means "stop the `Filter` cascade here"
 *     (`_cascadeFilterGrade`'s `base = node === this.Root || rs.Isolate`), so this adds no vocabulary.
 *     An isolated node does not receive an inherited lift, and its own authored lift does not reach its
 *     children: the lift stops there. See `CascadeLift` for the algebra.
 *
 * ## TWO IMPLEMENTATIONS OF THE ADDITIVE DRAW, CHOSEN PER ELEMENT PER FRAME
 *
 * UNDER. Nothing beside the lift samples the backdrop. One instance of the element's own shape
 * (`Push(..., 'LiftOnly')`) in its own draw -- same SDF, same radii, same clip stack, same opacity:
 *
 *     n > 0   FUNC_ADD               rgb: dst + src * srcA     alpha: dst
 *     n < 0   FUNC_REVERSE_SUBTRACT  rgb: dst - src * srcA     alpha: dst
 *
 * where src = `|n|/255 * c` per channel and srcA = coverage * opacity * clip. Neither case is a
 * multiply. There is no snapshot, no sampler and no pyramid.
 *
 * GRADED. Something beside it already samples (a grade, a blur, a glass body, a Tint, a progressive
 * blur), so the fragment is reading the backdrop anyway and the lift folds into the grade it already
 * runs. `applyGrading` is contrast about 0.5, then saturate about luma, then brightness:
 *
 *     y = b*c*luma(x) + b*(1 - c)/2 + b*c*s*(x - luma(x))
 *
 * An additive L after the grade is a new pair with the SAME GAIN (b'c' = bc, so the chroma term and
 * the luma slope are untouched) and an offset larger by exactly L:
 *
 *     b'(1 - c')/2 = b(1 - c)/2 + L   and   b'c' = bc   =>   b' = b + 2L,   c' = b*c / (b + 2L)
 *
 * which at the identity grade is the washeffect pair `1 + 2L, 1/(1 + 2L)`. The naive composition,
 * multiplying the pairs `(b(1+2L), c/(1+2L))`, keeps the gain too but its offset is `b(1-c)/2 + b*L`:
 * it scales the lift by the authored Brightness, which is not what was written. Saturate never enters
 * -- it multiplies chroma, and a GRAY lift has none.
 *
 * WHICH IS WHY A CHROMATIC LIFT CANNOT TAKE THE GRADED PATH. `(Brightness, Saturation, Contrast)` are
 * three SCALARS applied to all three channels; a per-channel offset needs three more numbers. The
 * instance stride is 60 floats = exactly 15 `vec4` vertex attributes, and WebGL2 guarantees 16 in
 * total -- which is why the foreground grade is bit-packed into one reused lane rather than given
 * lanes of its own. So a chromatic lift on an element that must take the graded path is REFUSED BY
 * NAME (`ChromaticGraded`) rather than silently desaturated into a gray one, which would be a
 * different picture wearing the property's name. A gray lift folds exactly as it always did.
 *
 * Why the choice is made HERE, at draw time, and not in the resolver: the foreground `Filter`
 * cascades, and the graded path's fragment grades its WHOLE result -- the lifted backdrop included --
 * by it. An additive blend cannot apply a multiply, so an element under a non-identity foreground
 * grade takes the graded path, and the cascaded grade only exists after the resolve.
 *
 * ## THE BLEND FACTORS, AND WHY `SRC_ALPHA` AND NOT `ONE`
 *
 * The panel and text programs write STRAIGHT alpha (rgb, coverage). `SRC_ALPHA` is what makes a
 * half-covered edge pixel add half, so edges do not bloom. Given a PREMULTIPLIED source instead,
 * `SRC_ALPHA` would scale it by coverage a second time and every antialiased edge would come out thin
 * (a-squared instead of a): a premultiplied source must take `ONE`. Every state here reads a straight
 * source, so every state here takes `SRC_ALPHA`.
 *
 * `BlendMode` is gone. It was the authoring surface for `PlusLighter` / `Screen`; the foreground zone
 * of this additive color is that surface now, and `CompositeBlend` remains what it always was -- the
 * internal name for the GL state. `Screen` left with it: it is not additive, it is not a color offset,
 * it is a different equation, and no site in the app wanted it. It was the only state that needed a
 * premultiplied source (its destination factor is `1 - src*a`, and no blend factor forms a product),
 * so `u_PremulOut` left with it too. The reasoning is kept above because it is the reason the four
 * surviving states are correct, not because any of them is premultiplied.
 */

import type { JivRenderStyle } from '../Jiv/Jiv.Types';

/** A lift smaller than this draws nothing: 0.03 of one 8-bit step. */
export const LIFT_EPSILON = 1e-4;

/** The grade epsilon `_hasBackdropFilter` and the panel fragment's `hasBackdropFilter` both use. */
const GRADE_EPSILON = 0.001;

/** A channel further than this from white makes a lift CHROMATIC, which the scalar backdrop grade
 *  cannot carry (see the header). One 8-bit step, so `rgb(255,255,255)` and `#fff` are both gray and
 *  `rgb(255,254,255)` is not pretending otherwise. */
const CHROMA_EPSILON = 1 / 255;

/** `?lift=` -- `on` (default) lets the engine choose; `graded` sends every lift through the fold, the
 *  equivalence arm; `off` draws no lift at all, the null arm. */
export type LiftMode = 'on' | 'graded' | 'off';

/** The four blend states a draw can take that compose against the destination instead of over it.
 *  `Lift*` are the additive SHAPE draw, whose alpha factors are `ZERO, ONE` so a transparent element
 *  stays transparent. `Plus*` are the element's own INK adding or subtracting, whose alpha factors are
 *  `ONE, ONE_MINUS_SRC_ALPHA` so alpha still accumulates the ordinary way. Both signs of both, because
 *  the sign of the amount is where the theme flip lives. `WebGL2Renderer.SetCompositeBlend`.
 *
 *  `PlusLighter` / `PlusDarker` are Apple's own names for this pair (`CGBlendMode.plusLighter` /
 *  `.plusDarker`); they are no longer authorable under any name. */
export type CompositeBlend = 'LiftAdd' | 'LiftSubtract' | 'PlusLighter' | 'PlusDarker' | 'Vibrant';

/** VIBRANT INK (`TextFilter: Vibrant(cover)`), Apple's tab bar glyphs and labels. Measured on the native
 *  iPhone bars (LiquidGlassGallery Web/Full) as the ink pixel against the glass beside it, per channel:
 *
 *      out = (1 - cover) dst + ink            dark:  ink 212 of 255, cover 0.55  (App Store 0.63, Photos 0.48)
 *                                             light: ink 5 of 255,   cover 0.88  (Music)
 *
 *  A white screen fits the brightness but keeps a twentieth of the glass's colour, where Apple's ink
 *  keeps 63 to 88% of it: the ink is a dimmed copy of the glass with a light added, not a paint. It is a
 *  PREMULTIPLIED source-over, `ink * a` over `cover * a`, so the text program writes that (its
 *  `u_InkCover`) and the blend is `ONE, ONE_MINUS_SRC_ALPHA`. Unlike an additive ink it is safe in a
 *  retained capture: over a cleared target it leaves exactly the premultiplied layer to composite. */
export const VIBRANT_EPSILON = 1e-4;

/** Why a lift's additive draw did not go UNDER the element. The census prints these by name. The first
 *  eight choose the graded fold instead; `ChromaticGraded` is the one that is an author ERROR, because
 *  the fold cannot carry chroma (see the header) and there is no third implementation. */
export type LiftRefusal =
  | 'Glass' | 'ProgressiveBlur' | 'Grade' | 'Blur' | 'Tint' | 'Filter' | 'Shadow' | 'Forced'
  | 'ChromaticGraded';

/** An additive color: a color times a signed amount. The channels are 0..1 (the color's own alpha is
 *  not part of an additive color -- there is nothing to be transparent over) and `Amount` is signed as
 *  a fraction of full scale, so `Lift(18)` is `{ R: 1, G: 1, B: 1, Amount: 18/255 }`. */
export interface LiftValue {
  R: number;
  G: number;
  B: number;
  /** Signed, a fraction of full scale. Authored in 0-255 units and divided here. */
  Amount: number;
}

/** What the `Lift:` property resolved to on one node, before the cascade:
 *    - `'Inherit'`  the property was not authored -- take the ancestor's value (the initial value)
 *    - `'None'`     `Lift: None`, the reset: this node and its subtree carry nothing
 *    - a value      `Lift: <color> <amount>`, authored here */
export type LiftDeclaration = 'Inherit' | 'None' | LiftValue;

export class Lift {
  /** Set once from the URL flags, before the first frame. */
  static Mode: LiftMode = 'on';
}

/** White, the color the one-argument `Lift(n)` means. Shared and never mutated, so an element with no
 *  chromatic lift allocates nothing. */
export const LIFT_WHITE: LiftValue = { R: 1, G: 1, B: 1, Amount: 0 };

/** True when this lift's color is white to within one 8-bit step, so the scalar backdrop grade can
 *  carry it. A lift of amount 0 is gray whatever its color -- there is nothing to carry. */
export const LiftIsGray = (v: LiftValue): boolean =>
  Math.abs(v.Amount) <= LIFT_EPSILON
  || (Math.abs(v.R - 1) <= CHROMA_EPSILON && Math.abs(v.G - 1) <= CHROMA_EPSILON && Math.abs(v.B - 1) <= CHROMA_EPSILON);

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

/** The element's own additive-ink amount: the FOREGROUND zone, 0 when there is none or the null arm is
 *  armed. Unlike the backdrop amount this one may be INHERITED, so the walk passes the cascade result
 *  in rather than reading the style. */
export const LiftInkAmount = (amount: number): number => {
  if (Lift.Mode === 'off') return 0;
  return Math.abs(amount) > LIFT_EPSILON ? amount : 0;
};

/** The GL state the element's own ink takes to ADD (or subtract) instead of cover. */
export const InkBlendOf = (amount: number): CompositeBlend => (amount > 0 ? 'PlusLighter' : 'PlusDarker');

/** True when this element's own ink MIGHT add instead of cover, so nothing may treat it as an
 *  ordinary source-over panel: not the empty-panel cull (a quad that adds is not `x*1 + c*0`), not
 *  the occlusion pre-pass (an element that brightens what is beneath it is not a coverer however
 *  opaque its fill), and not the retained layer cache (a capture's destination is a CLEARED target,
 *  so a lift there adds onto nothing).
 *
 *  BOTH HALVES, and that is the point. `effective` is the CASCADE result, which is the only place an
 *  INHERITED lift appears -- reading the style alone is the quiet way to let a cached subtree lose
 *  its backdrop. `rs.LiftDeclaration` is the node's OWN declaration, which is available even when
 *  this is asked before the cascade has run for the frame. Either one is enough to refuse, and
 *  refusing too often is only a missed optimization; refusing too rarely is a wrong picture. */
export const LiftTouchesInk = (rs: JivRenderStyle, effective: LiftValue | null): boolean => {
  if (Lift.Mode === 'off') return false;
  if (effective !== null && Math.abs(effective.Amount) > LIFT_EPSILON) return true;
  if (Math.abs(rs.ForegroundLift) > LIFT_EPSILON) return true;
  // The INK zone (`TextFilter: Lift()`) makes this element's ink add, which is exactly what this
  // predicate asks. It is counted CONSERVATIVELY: a text lift leaves the PANEL alone, so the
  // empty-panel cull and the occlusion pre-pass would both still be sound on the fill -- but the
  // retained layer cache would NOT be, because a capture's destination is a cleared target and ink
  // that adds onto nothing is a wrong picture. Rather than split one predicate into three, this
  // refuses all three: per this function's own rule, refusing too often costs an optimization and
  // refusing too rarely costs correctness.
  if (Math.abs(rs.TextLift) > LIFT_EPSILON) return true;
  const d = rs.LiftDeclaration;
  return d !== 'Inherit' && d !== 'None' && Math.abs(d.Amount) > LIFT_EPSILON;
};

/** The INK zone's amount, 0 when there is none or the null arm is armed. Same shape as
 *  `LiftInkAmount`, read from the style rather than the cascade because `TextFilter` does NOT
 *  cascade -- it is a per-element zone like its four siblings, not the inherited `Lift:` property. */
export const TextLiftAmount = (rs: JivRenderStyle): number => {
  if (Lift.Mode === 'off') return 0;
  const l = rs.TextLift;
  return Math.abs(l) > LIFT_EPSILON ? l : 0;
};

/** How much of its own color a lifted ink adds: `|amount|`, a fraction of full scale. This multiplies
 *  the text instance's TINT lane, which is already an RGBA multiplier on the glyph raster, so an
 *  additive ink needs NO new vertex attribute, NO shader change and NO second atlas entry.
 *
 *  WHY THE TINT LANE AND NOT THE RASTER. The glyph's color is baked into the atlas bitmap by
 *  Canvas2D `fillText` and the atlas is keyed by that color, so scaling the color at raster time
 *  would cut a fresh atlas entry per amount -- and the atlas is the real ceiling. The tint lane is
 *  `(1,1,1,1)` for all settled text and exists precisely to multiply the raster.
 *
 *  AND WHY IT IS COVERAGE-LINEAR. The text fragment writes `texel * tint * opacity * clipAlpha` and
 *  the atlas texel is STRAIGHT (uploaded from a canvas with `UNPACK_PREMULTIPLY_ALPHA_WEBGL` at its
 *  default `false`, so the browser un-premultiplies). Under `PlusLighter`'s `SRC_ALPHA, ONE` the
 *  contribution is `texel.rgb * scale * texel.a`, which is LINEAR in glyph coverage: a half-covered
 *  edge adds half. Scaling the tint's RGB and not its ALPHA is what keeps that true -- scaling alpha
 *  instead would give `a-squared` and every antialiased edge would come out thin. */
export const LiftInkScale = (amount: number): number => Math.abs(amount);

/** The GL state the additive SHAPE draw takes. */
export const ShapeBlendOf = (amount: number): CompositeBlend => (amount > 0 ? 'LiftAdd' : 'LiftSubtract');

/** What a lift needs to know about its element: the resolved style, the CASCADED foreground grade, and
 *  the lift's own color (which decides whether the fold can carry it). */
export interface LiftSubject {
  RenderStyle: JivRenderStyle;
  EffectiveBrightness: number;
  EffectiveSaturation: number;
  EffectiveContrast: number;
}

/** True when this element's fragment reads its backdrop, so an additive draw under it and additive ink
 *  on it are both the wrong picture. The one predicate behind the sampling refusals. */
export const LiftSamplesBackdrop = (s: JivRenderStyle): boolean =>
  s.Material === 'LiquidGlass'
  || s.Material === 'ProgressiveBlur'
  || Math.abs(s.BackdropBrightness - 1) > GRADE_EPSILON
  || Math.abs(s.BackdropSaturation - 1) > GRADE_EPSILON
  || Math.abs(s.BackdropContrast - 1) > GRADE_EPSILON
  || s.BackdropFrostBlur > GRADE_EPSILON
  || Math.abs(s.Tint) > GRADE_EPSILON;

/** Null when the lift can be drawn under the element; otherwise the FIRST reason it cannot, in the
 *  order the fragment would meet them. Asked only of an element that has a lift.
 *
 *  `color` is the lift's own color. When the element must take the graded fold and the color is not
 *  gray, the answer is `ChromaticGraded`: an author error, not an implementation choice, because the
 *  scalar grade cannot carry chroma and there is no third path. */
export const LiftRefusalOf = (n: LiftSubject, color: LiftValue = LIFT_WHITE): LiftRefusal | null => {
  const s = n.RenderStyle;
  const graded = (why: LiftRefusal): LiftRefusal => (LiftIsGray(color) ? why : 'ChromaticGraded');
  if (Lift.Mode === 'graded') return graded('Forced');
  if (s.Material === 'LiquidGlass') return graded('Glass');
  if (s.Material === 'ProgressiveBlur') return graded('ProgressiveBlur');
  if (Math.abs(s.BackdropBrightness - 1) > GRADE_EPSILON
    || Math.abs(s.BackdropSaturation - 1) > GRADE_EPSILON
    || Math.abs(s.BackdropContrast - 1) > GRADE_EPSILON) return graded('Grade');
  if (s.BackdropFrostBlur > GRADE_EPSILON) return graded('Blur');
  if (Math.abs(s.Tint) > GRADE_EPSILON) return graded('Tint');
  // The graded fragment grades its whole result, backdrop included, by the foreground Filter.
  if (!_fgIsIdentity(n.EffectiveBrightness, n.EffectiveSaturation, n.EffectiveContrast)) return graded('Filter');
  // The graded fill is opaque over the backdrop (`fillA = fillAlpha`), so it hides the element's own
  // drop shadow under its shape; a transparent element over an under-draw shows it. Same picture
  // only without one.
  if (s.ShadowColor.A > GRADE_EPSILON) return graded('Shadow');
  return null;
};

/** The lift this element draws UNDER itself, 0 when it has none or takes the graded path. */
export const LiftUnder = (n: LiftSubject, color?: LiftValue): number => {
  const l = LiftAmount(n.RenderStyle);
  return l !== 0 && LiftRefusalOf(n, color) === null ? l : 0;
};

/** The lift folded into this element's backdrop grade, 0 when it has none or draws it under. A
 *  `ChromaticGraded` refusal returns 0 too: it folds nothing, it throws at the walk. */
export const LiftGraded = (n: LiftSubject, color?: LiftValue): number => {
  const l = LiftAmount(n.RenderStyle);
  if (l === 0) return 0;
  const r = LiftRefusalOf(n, color);
  return r === null || r === 'ChromaticGraded' ? 0 : l;
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

/** ONE step of the lift cascade, the same shape as `_cascadeFilterGrade`'s.
 *
 *      inherited = (isRoot || Isolate) ? null : parent
 *      self      = decl === 'None' ? null : decl === 'Inherit' ? inherited : decl
 *      children  = Isolate ? null : self
 *
 *  Read it as one sentence: an inherited lift makes a node's ink additive; the node where it is
 *  AUTHORED additionally emits the additive shape draw. `Isolate` stops the value dead -- it neither
 *  arrives nor leaves -- which is the cheap way to buy "the lift applies once to this group" without
 *  a render target, and it is the ONLY place the author asks for that by name. */
export const CascadeLift = (
  decl: LiftDeclaration,
  parent: LiftValue | null,
  isRoot: boolean,
  isolate: boolean,
): { Self: LiftValue | null; Authored: boolean; ToChildren: LiftValue | null } => {
  const inherited = isRoot || isolate ? null : parent;
  const authored = decl !== 'Inherit' && decl !== 'None';
  const self = decl === 'None' ? null : decl === 'Inherit' ? inherited : decl;
  return { Self: self, Authored: authored, ToChildren: isolate ? null : self };
};

/** THE EFFECT FIELD. One object, and `LiftGateLine` formats the `jaui:lift` line FROM it, so the gate
 *  line and `__jauiLift()` cannot print different numbers. They did once -- the line had `blends=` and
 *  the census did not -- and the divergence cost a round trip to notice, so the two are now the same
 *  read by construction rather than by discipline. */
export interface LiftCensus {
  Armed: LiftMode;
  /** Lifts DECLARED on the node that applied them. An authored lift emits the additive shape draw. */
  Authored: number;
  /** Lifts that arrived through the cascade. An inherited lift makes ink add and emits NO shape draw:
   *  cascading the draw would lift the same pixels once per descendant. */
  Inherited: number;
  /** Inherited lifts a node DROPPED because it samples its backdrop. Not an error -- a cascade that
   *  threw the moment it contained one glass child would be unusable. */
  IgnoredSampling: number;
  /** Nodes whose INK added because of the `TextFilter` zone. Disjoint from `Authored` and
   *  `Inherited`, which count the shape-draw zones: a text lift emits NO shape draw, so it can never
   *  raise `Under` or `Graded`. It DOES raise `Blends`, because the ink takes a batch of its own.
   *
   *  `textInk=N` with `authored=0 inherited=0 liftUnder=0 liftGraded=0` is the signature of this zone
   *  working as designed -- the ink moved and nothing else did. */
  TextInk: number;
  /** The shape draw's two implementations. */
  Under: number;
  Graded: number;
  /** Pyramid builds caused by an UNDER-drawn element's own paint. MUST BE 0. Non-zero is this lane
   *  failing, exactly as before. */
  Builds: number;
  /** The cascade's own cost: nodes the walk visited, and how many came out carrying a value. */
  CascadeVisited: number;
  CascadeCarried: number;
  /** Shared Color-batch draws. An additive draw landing mid-run splits one batch into two. */
  PanelBatches: number;
  /** Counted at the draw call, on the renderer. */
  LiftDraws: number;
  Blends: number;
  BlendSwitches: number;
  /** Why each graded lift could not go under, by name. */
  Refused: Record<string, number>;
}

/** The `jaui:lift` gate line, formatted from the census and from nothing else. */
export const LiftGateLine = (c: LiftCensus): string => {
  const refused = Object.keys(c.Refused).sort().map((k) => `${k}:${c.Refused[k]}`).join(',');
  return `jaui:lift armed=${c.Armed}`
    + ` lifts=${c.Authored + c.Inherited} authored=${c.Authored} inherited=${c.Inherited}`
    + ` ignoredSampling=${c.IgnoredSampling}`
    + ` textInk=${c.TextInk}`
    + ` liftUnder=${c.Under} liftGraded=${c.Graded}`
    + ` liftDraws=${c.LiftDraws} liftBuilds=${c.Builds}`
    + ` cascadeVisited=${c.CascadeVisited} cascadeCarried=${c.CascadeCarried}`
    + ` blends=${c.Blends} blendSwitches=${c.BlendSwitches} panelBatches=${c.PanelBatches}`
    + ` refused=${refused === '' ? 'none' : refused}`;
};
