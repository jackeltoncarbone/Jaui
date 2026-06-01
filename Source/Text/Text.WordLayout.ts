import type { ResolvedTextStyle, TextAlign } from './Text.Types';
import { ResolveLastLineAlign } from './Text.Types';
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
  /** Inclusive char offset into the source content where this word starts. */
  CharStart: number;
  /** Exclusive char offset into the source content where this word ends. */
  CharEnd: number;
}

// Module-level shared measurement context. OffscreenCanvas works on main
// thread and in workers; the methods we need (measureText) are identical.
type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
let _sharedCtx: Ctx2D | null = null;

const _getCtx = (): Ctx2D => {
  if (_sharedCtx) return _sharedCtx;
  const ctx = new OffscreenCanvas(1, 1).getContext('2d');
  if (!ctx) throw new Error('[Jaui] Failed to get 2D context for word layout');
  _sharedCtx = ctx;
  return ctx;
};

/** Force a font into the shared measurement context's font registry.
 *  WebKit (iPad/iOS Safari) only binds a font to a canvas's font registry
 *  on first reference; FontFaceSet.add() alone isn't enough. After adding
 *  a FontFace to `self.fonts`, the bridge calls this to prime the *exact*
 *  context the engine measures against — without this step, measureText
 *  on iOS keeps returning fallback widths even though `self.fonts` has
 *  the loaded face. Idempotent and side-effect-free for Chromium. */
export const PrimeFontInSharedCtx = (
  family: string,
  weight: string = '400',
  style: string = 'normal',
): void => {
  const ctx = _getCtx();
  const prev = ctx.font;
  try {
    ctx.font = `${style} ${weight} 16px "${family}"`;
    ctx.measureText('Mg');
  } catch { /* invalid spec — skip */ }
  ctx.font = prev;
};

/**
 * Split content into individual words. Whitespace (including newlines for v1) is the separator.
 * Returns only non-empty word tokens.
 */
export const Tokenize = (content: string): string[] => {
  return content.split(/\s+/).filter((w) => w.length > 0);
};

/** Same as Tokenize, but also reports each word's char range in the
 *  original content — used by per-char selection so a char index can be
 *  mapped back to (word, offset-within-word). */
export const TokenizeWithOffsets = (content: string): { Content: string; CharStart: number; CharEnd: number }[] => {
  const out: { Content: string; CharStart: number; CharEnd: number }[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    out.push({ Content: m[0], CharStart: m.index, CharEnd: m.index + m[0].length });
  }
  return out;
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
  ctx?: Ctx2D,
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
  // Walk paragraphs (split on \n) so explicit newlines force a line break,
  // matching MeasureText. Without this, a span whose text carried a
  // trailing or embedded \n laid out as one rendered line while the layout
  // box was sized for two — the gap then got eaten by the text renderer's
  // vertical-centering, pushing glyphs visibly down ("132 counts"
  // half-row-down bug from tokenized inputs).
  const paragraphs = content.split('\n');
  // Bail when there's no rendered content at all (e.g. an empty string,
  // or a single trailing \n with nothing before it).
  let anyWord = false;
  for (const p of paragraphs) { if (/\S/.test(p)) { anyWord = true; break; } }
  if (!anyWord) return [];

  // Pass 1: lay out flush-left, recording word metrics + line groupings
  const positions: WordPosition[] = [];
  const lineRanges: { start: number; end: number; width: number }[] = [];
  let lineStart = 0;
  let currentX = 0;
  let currentY = 0;
  let currentLine = 0;
  let charBase = 0; // running offset into the original content
  let maxLinesHit = false;
  for (let p = 0; p < paragraphs.length; p++) {
    if (maxLinesHit) break;
    const paragraph = paragraphs[p];
    const words = TokenizeWithOffsets(paragraph);

    for (let i = 0; i < words.length; i++) {
      const tok = words[i];
      const word = tok.Content;
      const w = c.measureText(word).width;

      if (maxWidth !== null && currentX > 0 && currentX + w > maxWidth) {
        lineRanges.push({ start: lineStart, end: positions.length - 1, width: currentX - spaceWidth });
        lineStart = positions.length;
        currentX = 0;
        currentY += lineHeight;
        currentLine++;
      }

      if (style.MaxLines !== null && currentLine >= style.MaxLines) { maxLinesHit = true; break; }

      positions.push({
        Content: word,
        X: currentX,
        Y: currentY,
        Width: w,
        Height: lineHeight,
        Line: currentLine,
        CharStart: charBase + tok.CharStart,
        CharEnd: charBase + tok.CharEnd,
      });

      currentX += w + spaceWidth;
    }

    // Close out this paragraph's last line. The `+ 1` on charBase accounts
    // for the consumed '\n' separator between paragraphs. If this isn't
    // the trailing empty paragraph (i.e. the content didn't end with \n),
    // force a line break for the next paragraph; a trailing empty
    // paragraph contributes nothing rendered.
    if (p < paragraphs.length - 1) {
      const nextHasContent = paragraphs.slice(p + 1).some(s => /\S/.test(s));
      if (positions.length > lineStart) {
        lineRanges.push({ start: lineStart, end: positions.length - 1, width: currentX - spaceWidth });
        lineStart = positions.length;
      }
      if (nextHasContent) {
        if (style.MaxLines !== null && currentLine + 1 >= style.MaxLines) { maxLinesHit = true; }
        currentX = 0;
        currentY += lineHeight;
        currentLine++;
      }
      charBase += paragraph.length + 1;
    }
  }
  // Final line — only emit if any positions were laid out and the last
  // emitted lineRange doesn't already cover them (e.g. when the loop
  // closed it at a paragraph boundary).
  if (positions.length > lineStart) {
    lineRanges.push({ start: lineStart, end: positions.length - 1, width: currentX - spaceWidth });
  }

  // Pass 2: apply TextAlign per-line.
  //   Left      → no-op (already laid out flush-left).
  //   Center    → shift the line right by half the slack.
  //   Right     → shift the line right by the full slack.
  //   Justify   → distribute the slack across inter-word gaps in the line.
  // Last line uses TextAlignLast (resolved via ResolveLastLineAlign — `Auto`
  // for Justify falls back to Left so the final ragged line doesn't stretch).
  if (maxWidth !== null && lineRanges.length > 0) {
    const lastLineAlign = ResolveLastLineAlign(style);
    for (let li = 0; li < lineRanges.length; li++) {
      const line = lineRanges[li];
      const isLast = li === lineRanges.length - 1;
      const align = isLast ? lastLineAlign : style.TextAlign;
      if (align === 'Left') continue;

      if (align === 'Justify') {
        // Single-word lines have no inter-word gap to grow into; leave them
        // flush-left rather than dividing by zero / pushing the lone word
        // to the right edge.
        const wordCount = line.end - line.start + 1;
        if (wordCount < 2) continue;
        const slack = maxWidth - line.width;
        if (slack <= 0) continue;
        const extraPerGap = slack / (wordCount - 1);
        for (let i = line.start + 1; i <= line.end; i++) {
          positions[i].X += extraPerGap * (i - line.start);
        }
        continue;
      }

      const offset = _alignOffset(align, line.width, maxWidth);
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
