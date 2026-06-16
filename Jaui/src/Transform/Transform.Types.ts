/**
 * Runtime (resolved) Transform — numeric form consumed by the renderer.
 * The authorable form is a string on JivStyle.Transform, parsed via
 * Transform.Parse.ts into this object at StyleResolver time.
 */
export interface Transform {
  TranslateX: number;
  TranslateY: number;
  TranslateZ: number;          // px depth (positive = toward viewer); needs an ancestor Perspective to project
  ScaleX: number;              // unitless multiplier
  ScaleY: number;              // unitless multiplier
  Rotation: number;            // degrees (in-plane, about Z)
  RotateX: number;             // degrees (pitch, about the horizontal axis) — 3D, needs ancestor Perspective
  RotateY: number;             // degrees (yaw, about the vertical axis)     — 3D, needs ancestor Perspective
  SkewX: number;               // degrees
  SkewY: number;               // degrees
  OriginX: number;             // 0-1 fraction (0.5 = center)
  OriginY: number;             // 0-1 fraction (0.5 = center)
}

export const DefaultTransform: Transform = {
  TranslateX: 0,
  TranslateY: 0,
  TranslateZ: 0,
  ScaleX: 1,
  ScaleY: 1,
  Rotation: 0,
  RotateX: 0,
  RotateY: 0,
  SkewX: 0,
  SkewY: 0,
  OriginX: 0.5,
  OriginY: 0.5,
};
