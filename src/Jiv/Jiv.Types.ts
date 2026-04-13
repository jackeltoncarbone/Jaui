import type { Color } from '../Core/Types';
import type { Transform } from '../Transform/Transform.Types';
import type { Overflow } from '../Layout/Layout.Types';

export type CornerShape = 'Round' | 'Squircle' | 'Bevel' | 'Scoop' | 'Notch' | number;

export type BlendMode =
  | 'Normal' | 'Multiply' | 'Screen' | 'Overlay'
  | 'Darken' | 'Lighten' | 'ColorDodge' | 'ColorBurn'
  | 'SoftLight' | 'HardLight' | 'Difference' | 'Exclusion';

export interface JivStyle {
  // Shape
  BorderRadius: [number, number, number, number]; // tl, tr, br, bl
  CornerShape: [CornerShape, CornerShape, CornerShape, CornerShape];
  Smoothness: number;
  Overflow: Overflow;

  // Fill
  Background: Color;
  BlendMode: BlendMode;

  // Physical material — the Jiv is a slab with measurable properties
  Frost: number;               // backdrop blur intensity (0 = clear, 1 = full frost)
  FrostBlur: number;           // blur radius in px when Frost > 0
  Thickness: number;           // Z-depth of the slab — drives edge light, refraction, bulge
  Fillet: number;              // edge rounding in Z — sharp = hard catchlight, large = soft glow
  Refraction: number;          // how much light bends through the material
  Brightness: number;          // material brightness multiplier
  Saturation: number;          // material color saturation
  Contrast: number;            // material contrast

  // Transform
  Transform: Transform;

  // Border
  BorderColor: Color;
  BorderWidth: number;
  BorderBlur: number;          // soft glow border
  BorderOffset: number;        // inward/outward shift from edge
  ContainBorder: boolean;      // clip border glow to shape interior

  // Shadow
  ShadowColor: Color;
  ShadowBlur: number;
  ShadowOffsetX: number;
  ShadowOffsetY: number;
  InnerShadow: boolean;

  // Appearance
  Opacity: number;
  Visible: boolean;            // false = hidden but still takes layout space

  // Interaction
  Cursor: 'Default' | 'Pointer' | 'Text' | 'Move' | 'None';
  Interactive: boolean;
  PointerEvents: 'Auto' | 'None';
}
