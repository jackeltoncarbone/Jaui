import { White, type Color } from '../Core/Types';

export type TextAlign = 'Left' | 'Center' | 'Right';
export type TextOverflow = 'Clip' | 'Ellipsis';
export type FontStyle = 'Normal' | 'Italic';

export interface TextStyle {
  FontFamily: string;
  FontSize: number;
  FontWeight: number;          // 100-900
  FontStyle: FontStyle;
  Color: Color;
  LineHeight: number;          // multiplier (1.0 = normal)
  LetterSpacing: number;       // px
  TextAlign: TextAlign;
  TextOverflow: TextOverflow;
  MaxLines: number | null;     // null = unlimited
}

export const DefaultTextStyle: TextStyle = {
  FontFamily: 'system-ui',
  FontSize: 16,
  FontWeight: 400,
  FontStyle: 'Normal',
  Color: White,
  LineHeight: 1.2,
  LetterSpacing: 0,
  TextAlign: 'Left',
  TextOverflow: 'Clip',
  MaxLines: null,
};
