import type { ResolvedTextStyle, TextMeasurement } from './Text.Types';

// Worker-safe 2D context: OffscreenCanvas's context shares every method we
// touch (measureText, fillText, fillStyle, font) with HTMLCanvasElement's.
type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

// Module-level shared measurement canvas (created lazily)
let _sharedCtx: Ctx2D | null = null;

const _getSharedContext = (): Ctx2D => {
  if (_sharedCtx) return _sharedCtx;
  const ctx = new OffscreenCanvas(1, 1).getContext('2d');
  if (!ctx) throw new Error('[Jaui] Failed to get 2D context for text measurement');
  _sharedCtx = ctx;
  return ctx;
};

/** Force a font into this module's shared measurement ctx. See
 *  Text.WordLayout.PrimeFontInSharedCtx for the WebKit rationale —
 *  this measurement ctx and the WordLayout ctx are *separate* canvas
 *  font registries, so iOS Safari needs both primed independently. */
export const PrimeFontInMeasureCtx = (
  family: string,
  weight: string = '400',
  style: string = 'normal',
): void => {
  const ctx = _getSharedContext();
  const prev = ctx.font;
  try {
    ctx.font = `${style} ${weight} 16px "${family}"`;
    ctx.measureText('Mg');
  } catch { /* invalid spec — skip */ }
  ctx.font = prev;
};

/** Apply style to a 2D context (matches browser font string syntax). */
export const ApplyTextStyle = (ctx: Ctx2D, style: ResolvedTextStyle, dpr: number = 1): void => {
  const italic = style.FontStyle === 'Italic' ? 'italic ' : '';
  const size = style.FontSize * dpr;
  ctx.font = `${italic}${style.FontWeight} ${size}px ${style.FontFamily}`;
  // 'middle' centers the glyph on the draw y-coordinate using the font's
  // em-square middle (midpoint of ascender + descender). Callers pass
  // `y = lineIndex * lineHeight + lineHeight / 2` so each line's visual
  // center lines up with the center of its line-height box — which is
  // what flex cross-axis centering expects. 'top' produced ascender-biased
  // rasters where Latin glyphs sat high in the box, leaving descent space
  // empty below and making flex-centered text look baseline-aligned.
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  // letterSpacing — Chrome 94+, Safari 16.4+; fallback: ignored
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ctx as any).letterSpacing = `${style.LetterSpacing * dpr}px`;
};

/**
 * Measure text with optional word-wrapping at maxWidth.
 * Returns width (widest line), height (lines × lineHeight), and the wrapped lines.
 *
 * The `ctx` parameter is injectable for testing — if omitted, uses a shared module-level context.
 */
export const MeasureText = (
  content: string,
  style: ResolvedTextStyle,
  maxWidth: number | null,
  ctx?: Ctx2D,
): TextMeasurement => {
  const c = ctx ?? _getSharedContext();
  ApplyTextStyle(c, style, 1);

  const lineHeightPx = style.FontSize * style.LineHeight;

  if (content === '') {
    return { Width: 0, MinWidth: 0, Height: lineHeightPx, Lines: [''] };
  }

  const minWidth = _measureLongestWord(content, c);

  // Trailing-newline trim: a span carrying "abc\n" or "abc\n\n" should
  // measure as 1 visible line. A trailing \n is a separator with no
  // paragraph after it — counting it would size the box for a phantom
  // line and LayoutWords (which renders) wouldn't fill it, leaving the
  // text renderer's vertical-centering pushing glyphs down by half a
  // line. Embedded \n between content (e.g. "Line 1\nLine 2") still
  // produces two lines, matching the documented behavior.
  let rawLines = content.split('\n');
  while (rawLines.length > 1 && rawLines[rawLines.length - 1] === '') {
    rawLines.pop();
  }

  // No wrap — single line (preserves explicit \n split)
  if (maxWidth === null || maxWidth === Infinity) {
    const lines = _applyMaxLines(rawLines, style, c);
    let width = 0;
    for (const line of lines) {
      const w = c.measureText(line).width;
      if (w > width) width = w;
    }
    return { Width: width, MinWidth: minWidth, Height: lines.length * lineHeightPx, Lines: lines };
  }

  // Word wrap
  const lines: string[] = [];
  for (const paragraph of rawLines) {
    _wrapParagraph(paragraph, maxWidth, c, lines);
  }

  const clipped = _applyMaxLines(lines, style, c, maxWidth);
  let width = 0;
  for (const line of clipped) {
    const w = c.measureText(line).width;
    if (w > width) width = w;
  }
  return { Width: width, MinWidth: minWidth, Height: clipped.length * lineHeightPx, Lines: clipped };
};

/** Longest individual word's width. Drives min-content sizing — the smallest
 *  width the text can take without a word overflowing. */
const _measureLongestWord = (content: string, ctx: Ctx2D): number => {
  let max = 0;
  for (const paragraph of content.split('\n')) {
    for (const word of paragraph.split(/\s+/)) {
      if (word.length === 0) continue;
      const w = ctx.measureText(word).width;
      if (w > max) max = w;
    }
  }
  return max;
};

/** Wrap a single paragraph into lines, pushing into `out`. */
const _wrapParagraph = (
  paragraph: string,
  maxWidth: number,
  ctx: Ctx2D,
  out: string[],
): void => {
  if (paragraph === '') {
    out.push('');
    return;
  }
  const words = paragraph.split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) {
    out.push('');
    return;
  }

  let currentLine = '';
  for (const word of words) {
    const candidate = currentLine === '' ? word : currentLine + ' ' + word;
    const width = ctx.measureText(candidate).width;
    if (width <= maxWidth || currentLine === '') {
      currentLine = candidate;
    } else {
      out.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine !== '') out.push(currentLine);
};

/** Apply MaxLines + TextOverflow (Ellipsis) to the line list. */
const _applyMaxLines = (
  lines: string[],
  style: ResolvedTextStyle,
  ctx: Ctx2D,
  maxWidth: number | null = null,
): string[] => {
  if (style.MaxLines === null || lines.length <= style.MaxLines) return lines;

  const clipped = lines.slice(0, style.MaxLines);
  if (style.TextOverflow === 'Ellipsis' && clipped.length > 0) {
    const lastIdx = clipped.length - 1;
    clipped[lastIdx] = _truncateWithEllipsis(clipped[lastIdx], ctx, maxWidth);
  }
  return clipped;
};

/** Truncate a line and append ellipsis so it fits in maxWidth. */
const _truncateWithEllipsis = (
  line: string,
  ctx: Ctx2D,
  maxWidth: number | null,
): string => {
  const ellipsis = '…';
  if (maxWidth === null) return line + ellipsis;

  let truncated = line;
  while (truncated.length > 0 && ctx.measureText(truncated + ellipsis).width > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return truncated + ellipsis;
};
