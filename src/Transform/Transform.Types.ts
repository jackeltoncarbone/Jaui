export interface Transform {
  TranslateX: number;
  TranslateY: number;
  ScaleX: number;
  ScaleY: number;
  Rotation: number;            // degrees
  SkewX: number;               // degrees
  SkewY: number;               // degrees
  OriginX: number;             // 0-1 fraction (0.5 = center)
  OriginY: number;             // 0-1 fraction (0.5 = center)
}

export const DefaultTransform: Transform = {
  TranslateX: 0,
  TranslateY: 0,
  ScaleX: 1,
  ScaleY: 1,
  Rotation: 0,
  SkewX: 0,
  SkewY: 0,
  OriginX: 0.5,
  OriginY: 0.5,
};
