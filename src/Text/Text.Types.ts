import type { Color } from '../Core/Types';
import { Resolve, type ResolveContext } from '../Core/Length';
import { ParseColor } from '../Core/Color.Parse';

export type TextAlign = 'Left' | 'Center' | 'Right';
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
  TextOverflow: TextOverflow;
  MaxLines: number | null;
}

/** Resolve a TextStyle into its numeric/parsed form using the Jiv's ctx. */
export const ResolveTextStyle = (style: TextStyle, ctx: ResolveContext): ResolvedTextStyle => ({
  FontFamily: style.FontFamily,
  FontSize: Resolve(style.FontSize, ctx, 'W'),
  FontWeight: style.FontWeight,
  FontStyle: style.FontStyle,
  Color: ParseColor(style.Color),
  LineHeight: Resolve(style.LineHeight, ctx, 'W'),
  LetterSpacing: Resolve(style.LetterSpacing, ctx, 'W'),
  TextAlign: style.TextAlign,
  TextOverflow: style.TextOverflow,
  MaxLines: style.MaxLines,
});

export const DefaultTextStyle: TextStyle = {
  FontFamily: 'system-ui',
  FontSize: '16',
  FontWeight: 400,
  FontStyle: 'Normal',
  Color: 'rgba(255, 255, 255, 1)',
  LineHeight: '1.2',
  LetterSpacing: '0',
  TextAlign: 'Left',
  TextOverflow: 'Clip',
  MaxLines: null,
};

export interface TextMeasurement {
  Width: number;        // CSS px — widest line
  Height: number;       // CSS px — total height = lines * FontSize * LineHeight
  Lines: string[];      // text broken into lines
}

export interface TextConfig {
  Content: string;
  Style: TextStyle;
}

