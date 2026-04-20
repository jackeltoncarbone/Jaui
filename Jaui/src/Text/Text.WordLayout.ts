import type { ResolvedTextStyle, TextAlign } from './Text.Types';
import { ApplyTextStyle } from './Text.Measure';

export interface WordPosition {
  /** Word text (no trailing space). */
  Content: string;
  /** X position in CSS px, relative to text container's content origin. */
  X: number;
  /** Y position in CSS px. */
  Y: number;
  /** Measured word width in CSS px. */
  Width: number;
  /** Line height — each word's drawn height. */
  Height: number;
  /** Line index this word belongs to. */
  Line: number;
}

// Module-level shared measurement context
let _sharedCtx: CanvasRenderingContext2D | null = null;

const _getCtx = (): CanvasRenderingContext2D => {
  if (_sharedCtx) return _sharedCtx;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('[Jaui] Failed to get 2D context for word layout');
  _sharedCtx = ctx;
  return ctx;
};

/**
 * Split content into individual words. Whitespace (including newlines for v1) is the separator.
 * Returns only non-empty word tokens.
 */
export const Tokenize = (content: string): string[] => {
  return content.split(/\s+/).filter((w) => w.length > 0);
};

/**
 * Compute per-word positions given content + style + optional wrap width.
 * Positions are relative to the text container's content box (0,0 = top-left).
 * Pure function — injectable `ctx` for tests.
 */
export const LayoutWords = (
  content: string,
  style: ResolvedTextStyle,
  maxWidth: number | null,
  ctx?: CanvasRenderingContext2D,
): WordPosition[] => {
  const c = ctx ?? _getCtx();
  ApplyTextStyle(c, style, 1);

  const lineHeight = style.FontSize * style.LineHeight;
  // If the font isn't yet available to the 2D context, measureText(' ')
  // can return 0 — causing words to render touching each other. Fall back
  // to a quarter-em gap so the text remains readable. Text.Cache is flushed
  // when fonts finish loading, so correct metrics replace this soon after.
  const rawSpace = c.measureText(' ').width;
  const spaceWidth = rawSpace > 0 && Number.isFinite(rawSpace)
    ? rawSpace
    : style.FontSize * 0.25;
  const words = Tokenize(content);
  if (words.length === 0) return [];

  // Pass 1: lay out flush-left, recording word metrics + line groupings
  const positions: WordPosition[] = [];
  const lineRanges: { start: number; end: number; width: number }[] = [];
  let lineStart = 0;
  let currentX = 0;
  let currentY = 0;
  let currentLine = 0;

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const w = c.measureText(word).width;

    if (maxWidth !== null && currentX > 0 && currentX + w > maxWidth) {
      // Finalize previous line
      lineRanges.push({ start: lineStart, end: i - 1, width: currentX - spaceWidth });
      // Wrap
      lineStart = i;
      currentX = 0;
      currentY += lineHeight;
      currentLine++;
    }

    positions.push({
      Content: word,
      X: currentX,
      Y: currentY,
      Width: w,
      Height: lineHeight,
      Line: currentLine,
    });

    currentX += w + spaceWidth;
  }
  // Final line
  lineRanges.push({ start: lineStart, end: words.length - 1, width: currentX - spaceWidth });

  // Pass 2: apply TextAlign per-line (Center/Right shift)
  if (maxWidth !== null && style.TextAlign !== 'Left') {
    for (const line of lineRanges) {
      const offset = _alignOffset(style.TextAlign, line.width, maxWidth);
      if (offset === 0) continue;
      for (let i = line.start; i <= line.end; i++) {
        positions[i].X += offset;
      }
    }
  }

  return positions;
};

const _alignOffset = (align: TextAlign, lineWidth: number, maxWidth: number): number => {
  if (align === 'Center') return (maxWidth - lineWidth) / 2;
  if (align === 'Right') return maxWidth - lineWidth;
  return 0;
};
