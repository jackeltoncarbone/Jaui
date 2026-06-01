import type { ResolvedTextStyle } from './Text.Types';

/**
 * Fast hash for text + style + dpr.
 * Uses FNV-1a (32-bit) — stable, fast, low collision for typical UI strings.
 *
 * Takes a ResolvedTextStyle (numeric FontSize/LetterSpacing) — cache keys
 * need to be stable pixel values, not authored Length expressions.
 */
export const HashTextKey = (content: string, style: ResolvedTextStyle, dpr: number): string => {
  let h = 0x811c9dc5; // FNV-1a 32-bit offset basis

  // Hash content
  for (let i = 0; i < content.length; i++) {
    h ^= content.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }

  // Hash style fields — mixed via separator chars
  h = _hashString(h, '|');
  h = _hashString(h, style.FontFamily);
  h = _hashNumber(h, style.FontSize);
  h = _hashNumber(h, style.FontWeight);
  h = _hashString(h, style.FontStyle);
  h = _hashNumber(h, style.Color.R);
  h = _hashNumber(h, style.Color.G);
  h = _hashNumber(h, style.Color.B);
  h = _hashNumber(h, style.Color.A);
  h = _hashNumber(h, style.LineHeight);
  h = _hashNumber(h, style.LetterSpacing);
  h = _hashString(h, style.TextAlign);
  h = _hashString(h, style.TextAlignLast);
  h = _hashString(h, style.TextOverflow);
  h = _hashNumber(h, style.MaxLines === null ? -1 : style.MaxLines);
  h = _hashNumber(h, dpr);

  return (h >>> 0).toString(36);
};

const _hashString = (h: number, s: string): number => {
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h;
};

const _hashNumber = (h: number, n: number): number => {
  // Hash float as 32-bit int reinterpretation
  const buf = new ArrayBuffer(4);
  new Float32Array(buf)[0] = n;
  const i32 = new Uint32Array(buf)[0];
  h ^= i32 & 0xff;
  h = Math.imul(h, 0x01000193);
  h ^= (i32 >>> 8) & 0xff;
  h = Math.imul(h, 0x01000193);
  h ^= (i32 >>> 16) & 0xff;
  h = Math.imul(h, 0x01000193);
  h ^= (i32 >>> 24) & 0xff;
  h = Math.imul(h, 0x01000193);
  return h;
};
