import type { TextStyle, TextMeasurement } from './Text.Types';

// Module-level shared measurement canvas (created lazily)
let _sharedCtx: CanvasRenderingContext2D | null = null;

const _getSharedContext = (): CanvasRenderingContext2D => {
  if (_sharedCtx) return _sharedCtx;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('[Jwift] Failed to get 2D context for text measurement');
  _sharedCtx = ctx;
  return ctx;
};

/** Apply style to a 2D context (matches browser font string syntax). */
export const ApplyTextStyle = (ctx: CanvasRenderingContext2D, style: TextStyle, dpr: number = 1): void => {
  const italic = style.FontStyle === 'Italic' ? 'italic ' : '';
  const size = style.FontSize * dpr;
  ctx.font = `${italic}${style.FontWeight} ${size}px ${style.FontFamily}`;
  ctx.textBaseline = 'top';
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
  style: TextStyle,
  maxWidth: number | null,
  ctx?: CanvasRenderingContext2D,
): TextMeasurement => {
  const c = ctx ?? _getSharedContext();
  ApplyTextStyle(c, style, 1);

  const lineHeightPx = style.FontSize * style.LineHeight;

  if (content === '') {
    return { Width: 0, Height: lineHeightPx, Lines: [''] };
  }

  // No wrap — single line (preserves explicit \n split)
  if (maxWidth === null || maxWidth === Infinity) {
    const rawLines = content.split('\n');
    const lines = _applyMaxLines(rawLines, style, c);
    let width = 0;
    for (const line of lines) {
      const w = c.measureText(line).width;
      if (w > width) width = w;
    }
    return { Width: width, Height: lines.length * lineHeightPx, Lines: lines };
  }

  // Word wrap
  const lines: string[] = [];
  for (const paragraph of content.split('\n')) {
    _wrapParagraph(paragraph, maxWidth, c, lines);
  }

  const clipped = _applyMaxLines(lines, style, c, maxWidth);
  let width = 0;
  for (const line of clipped) {
    const w = c.measureText(line).width;
    if (w > width) width = w;
  }
  return { Width: width, Height: clipped.length * lineHeightPx, Lines: clipped };
};

/** Wrap a single paragraph into lines, pushing into `out`. */
const _wrapParagraph = (
  paragraph: string,
  maxWidth: number,
  ctx: CanvasRenderingContext2D,
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
  style: TextStyle,
  ctx: CanvasRenderingContext2D,
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
  ctx: CanvasRenderingContext2D,
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
