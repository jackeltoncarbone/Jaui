import type { JivStyle } from './Jiv.Types';

export const DefaultJivStyle: JivStyle = {
  ProgressiveBlurDirection: null,
  ProgressiveBlurFeather: '0',
  ProgressiveBlurEasing: '1',
  ProgressiveBlur: null,
  ProgressiveBlurKind: 'Surface',
  // PointScale defaults to "1pt" — "inherit from parent's PointScale".
  // Root Jiv has no parent, so its `pt` refers to a hardcoded fallback (16)
  // inside the layout solver. Set PointScale to an absolute like "16" at
  // the root (or any subtree root) to rebase `pt` for that subtree.
  PointScale: '1pt',
  BorderRadius: '0',
  CornerShape: 'Round',
  BorderRadiusSmoothness: '1',
  Background: 'rgba(0, 0, 0, 0)',
  // Vibrancy, inherited (Core/Vibrancy.ts). `Inherit` takes the ancestor's; `None` is the reset.
  Vibrancy: 'Inherit',
  // Filters — identity by default (no grade, no frost). See Jiv.Types.
  Filter: 'None',
  BackdropFilter: 'None',
  // The INK zone. 'None' means the ink covers, which is what ink does -- so the default costs one
  // identity parse per style and reaches no draw.
  TextFilter: 'None',
  Isolate: 'false',
  Frost: '0',
  Glass: 'None',
  Thickness: 'Auto',
  Refraction: '0',
  Tint: '0',
  TintTone: 'Ground',
  ChromaticAberration: '0',
  LensInk: 'rgba(0, 0, 0, 0)',
  RimWidth: '0',
  RimStrength: '0',
  LensLiftedScale: '1',
  GlassGlow: '0',
  Flex: 'None',
  FlexLift: 'Auto',
  FlexBigGlow: 'Auto',
  FlexLittleGlow: 'Auto',
  FlexStretch: 'Auto',
  GlassDispersion: 'Auto',
  GlassBlur: 'Auto',
  GlassOuterRefraction: 'Auto',
  GlassBleed: 'Auto',
  GlassFrost: 'Inherit',
  Transform: '',                         // empty = identity
  // Visual* — render-time, per-element. `VisualScale: '1'` is identity;
  // `VisualTranslate: '0'` is no offset; `VisualOrigin: '0.5'` is center.
  // Shorthand: single value = uniform; two values (`x y`) = per-axis.
  VisualScale: '1',
  VisualTranslate: '0',
  VisualOrigin: '0.5',
  // Perspective context for descendants (CSS `perspective`). '0' = none.
  Perspective: '0',
  PerspectiveOrigin: '0.5',
  BorderColor: 'rgba(0, 0, 0, 0)',
  BorderWidth: '0',
  BorderBlur: '0.5',
  BorderFade: '0',
  BorderOffset: '0',
  ContainBorder: false,
  BorderLayer: '0',
  ShadowColor: 'rgba(0, 0, 0, 0)',
  ShadowBlur: '0',
  ShadowOffsetX: '0',
  ShadowOffsetY: '0',
  InnerShadow: false,
  // Implicit fade: resolving `Presence` at style-resolution time yields the
  // Jiv's current PresenceSpring value (0 on mount, springing to 1). Authors
  // who want no fade override explicitly (`Opacity: 1`); authors who want a
  // custom fade curve replace the default with their own expression.
  Opacity: 'Presence',
  Layer: '0',
};
