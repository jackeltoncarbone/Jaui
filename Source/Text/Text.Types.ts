import type { Color } from '../Core/Types';
import { Resolve, ResolveScalar, type ResolveContext } from '../Core/Length';
import { ParseColor } from '../Core/Color.Parse';

export type TextAlign = 'Left' | 'Center' | 'Right' | 'Justify';
/** Per-line override for the *last* line — mirrors CSS `text-align-last`.
 *  `'Auto'` = inherit from `TextAlign`, except `Justify` falls back to `Left`
 *  (the typographic default — never stretch the last line). */
export type TextAlignLast = 'Auto' | 'Left' | 'Center' | 'Right' | 'Justify';
export type TextOverflow = 'Clip' | 'Ellipsis';
export type FontStyle = 'Normal' | 'Italic';

/**
 * Authorable text style. Every dimensional / color field is a CSS-string.
 * LineHeight is a unitless multiplier (authored as string for consistency
 * with the rest of the style system).
 */
export interface TextStyle {
  FontFamily: string;
  FontSize: string;
  FontWeight: number;          // 100-900
  FontStyle: FontStyle;
  Color: string;
  LineHeight: string;          // multiplier (1.0 = normal)
  LetterSpacing: string;
  TextAlign: TextAlign;
  TextAlignLast: TextAlignLast;
  TextOverflow: TextOverflow;
  MaxLines: number | null;     // null = unlimited
}

/** Fully resolved TextStyle — numbers + parsed Color object. What the text
 *  measurement/layout/render pipeline consumes. */
export interface ResolvedTextStyle {
  FontFamily: string;
  FontSize: number;
  FontWeight: number;
  FontStyle: FontStyle;
  Color: Color;
  LineHeight: number;
  LetterSpacing: number;
  TextAlign: TextAlign;
  TextAlignLast: TextAlignLast;
  TextOverflow: TextOverflow;
  MaxLines: number | null;
  /** Coordinate space of the owning element. Screen-space text (the default)
   *  rasterizes crisp at 1:1 — matching the WebGL2 reference at every size and
   *  dpr. Only World-space text (scaled / Z-pushed in 3D) is SDF-ified so it
   *  stays sharp under magnification (raster would blur). Optional: callers that
   *  don't set it get crisp raster. */
  Space?: 'Screen' | 'World';
}

/** Resolve a TextStyle into its numeric/parsed form using the Jiv's ctx. */
export const ResolveTextStyle = (style: TextStyle, ctx: ResolveContext): ResolvedTextStyle => ({
  FontFamily: style.FontFamily,
  FontSize: Resolve(style.FontSize, ctx, 'W'),
  FontWeight: style.FontWeight,
  FontStyle: style.FontStyle,
  Color: ParseColor(style.Color),
  LineHeight: ResolveScalar(style.LineHeight, ctx, 'W'),
  LetterSpacing: Resolve(style.LetterSpacing, ctx, 'W'),
  TextAlign: style.TextAlign,
  TextAlignLast: style.TextAlignLast,
  TextOverflow: style.TextOverflow,
  MaxLines: style.MaxLines,
  // World-space text opts into SDF (sharp under 3D scaling). Screen-space (the
  // default, and anything that doesn't carry Space) stays crisp raster.
  Space: (style as { Space?: 'Screen' | 'World' }).Space ?? 'Screen',
});

/** Resolve `TextAlignLast: 'Auto'` to a concrete TextAlign value. Justified
 *  text falls back to Left (don't stretch the last line — typographic
 *  default); other modes inherit from the base alignment. */
export const ResolveLastLineAlign = (style: ResolvedTextStyle): TextAlign => {
  if (style.TextAlignLast === 'Auto') {
    return style.TextAlign === 'Justify' ? 'Left' : style.TextAlign;
  }
  return style.TextAlignLast;
};

export const DefaultTextStyle: TextStyle = {
  FontFamily: 'system-ui',
  FontSize: '16',
  FontWeight: 400,
  FontStyle: 'Normal',
  Color: 'rgba(255, 255, 255, 1)',
  LineHeight: '1.2',
  LetterSpacing: '0',
  TextAlign: 'Left',
  TextAlignLast: 'Auto',
  TextOverflow: 'Clip',
  MaxLines: null,
};

export interface TextMeasurement {
  Width: number;        // CSS px — widest line (max-content width of the text)
  /** Longest unbreakable word's width — the min-content width of the text. */
  MinWidth: number;
  Height: number;       // CSS px — total height = lines * FontSize * LineHeight
  Lines: string[];      // text broken into lines
}

export interface TextConfig {
  Content: string;
  Style: TextStyle;
}

