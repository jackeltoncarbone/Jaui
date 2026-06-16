import type { JivStyle } from './Jiv.Types';

export const DefaultJivStyle: JivStyle = {
  ProgressiveBlurDirection: null,
  ProgressiveBlurFeather: '0',
  ProgressiveBlurEasing: '1',
  // PointScale defaults to "1pt" — "inherit from parent's PointScale".
  // Root Jiv has no parent, so its `pt` refers to a hardcoded fallback (16)
  // inside the layout solver. Set PointScale to an absolute like "16" at
  // the root (or any subtree root) to rebase `pt` for that subtree.
  PointScale: '1pt',
  BorderRadius: '0',
  CornerShape: 'Round',
  BorderRadiusSmoothness: '0.3',
  Background: 'rgba(0, 0, 0, 0)',
  BlendMode: 'Normal',
  // Filters — identity by default (no grade, no frost). See Jiv.Types.
  Filter: 'None',
  BackdropFilter: 'None',
  BorderFilter: 'None',
  Isolate: 'false',
  Frost: '0',
  Thickness: '0',
  Fillet: '0',
  Refraction: '0',
  BezelWidth: '12',
  BezelScale: '0.35',
  LightAngle: '-45',
  LightIntensity: '1',
  SpecularIntensity: '0',
  SpecularSharpness: '100',
  FresnelStrength: '0',
  ChromaticAberration: '0',
  EdgeLightTop: '0',
  EdgeLightBottom: '0',
  BorderVariance: '0',
  BorderAlphaVariance: '0',
  BorderFresnelBrightness: '0',
  InnerBlur: '0',
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
  BorderOffset: '0',
  ContainBorder: false,
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
