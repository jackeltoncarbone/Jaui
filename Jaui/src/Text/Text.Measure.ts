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

/** A family name no font can be installed under, so the canvas is guaranteed to fall back. */
const _NO_SUCH_FAMILY = '__jaui_no_such_family__';
/** Wide enough that two different faces cannot measure the same by accident. */
const _PROBE_TEXT = 'ABCDEFGHIJKLM abcdefghijklm 0123456789';

/**
 * Whether `family` actually RESOLVES in the context the engine measures with — the direct answer
 * to "does this worker have the page's font", as opposed to "was it handed one".
 *
 * A canvas given a family it cannot find silently falls back to the default face, so a family that
 * measures the same as a name no font could possibly have is not installed here. Diagnostic only:
 * it is called from the font-install path behind `JauiTracing()`, never per frame. A face whose
 * advance widths matched the platform default across the whole probe string would read as missing,
 * which for any real webface against a system UI face does not happen.
 */
export const FamilyResolvesInMeasureCtx = (
  family: string,
  weight: string = '400',
  style: string = 'normal',
): boolean => {
  const ctx = _getSharedContext();
  const prev = ctx.font;
  try {
    ctx.font = `${style} ${weight} 72px "${_NO_SUCH_FAMILY}"`;
    const fallback = ctx.measureText(_PROBE_TEXT).width;
    ctx.font = `${style} ${weight} 72px "${family}"`;
    const actual = ctx.measureText(_PROBE_TEXT).width;
    return Math.abs(actual - fallback) > 0.01;
  } catch {
    return false;
  } finally {
    ctx.font = prev;
  }
};

// Chromium caches the resolved face per exact font string for the whole worker, and an entry resolved
// before a FontFace arrived keeps its fallback in every context. Each font install bumps this, and the
// bump rides in the size string, a tenth of a thousandth of a pixel at a time, so no string is reused.
let _fontGeneration = 0;
export const BumpFontGeneration = (): void => {
  _fontGeneration++;
  // Every cached measurement was shaped against the PREVIOUS generation's face.
  // The generation rides in the font string, so a surviving entry would be the
  // measurement of a font nobody is drawing with any more.
  _measureCache.clear();
};

/** Apply style to a 2D context (matches browser font string syntax). */
export const ApplyTextStyle = (ctx: Ctx2D, style: ResolvedTextStyle, dpr: number = 1): void => {
  const italic = style.FontStyle === 'Italic' ? 'italic ' : '';
  const size = style.FontSize * dpr + _fontGeneration * 1e-4;
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

// ─── The ellipsis law ─────────────────────────────────────────────

/** The character a truncated tail ends in. ONE definition: `Text.WordLayout` paints with it and
 *  this file sizes the box for it, and a box sized for one ellipsis and painted with another
 *  disagrees by exactly the glyph everybody is looking at. */
export const ELLIPSIS = '…';

/**
 * How much of `text` survives an ellipsis inside `maxWidth`. THE rule — the measurer below and
 * `LayoutWords`, which is what actually places the glyphs, both call this one function.
 *
 * CSS `text-overflow: ellipsis` (CSS Overflow Module Level 3, §5.2 "the ellipsis is placed so that
 * it fits within the line box, replacing content at the end of the line") keeps the longest prefix
 * whose advance INCLUDING the ellipsis fits, and it cuts at a character. UIKit's
 * `NSLineBreakMode.byTruncatingTail` does the same thing to the last line TextKit lays out.
 *
 * Jaui used to ellipsize the WORD-WRAPPED line instead, which silently threw away the whole of the
 * word the wrap had pushed onto the next line: `Rehearsal moved to the…` where Chrome and a UILabel
 * both write `Rehearsal moved to the t…`. The wrap decides how many LINES there are. It does not
 * get to decide where the ellipsis falls — so `text` here is the line's own words PLUS everything
 * the clamp dropped from that paragraph, and the cut is free to land inside a dropped word.
 *
 * Binary search, not a shrink loop: the advance is monotone in the prefix length, so a 300-character
 * remainder costs nine measures instead of two hundred and eighty — and the remainder is long now
 * precisely BECAUSE the rule reaches past the wrap.
 *
 * The answer is snapped off a lone surrogate (a cut between a pair paints a replacement box) and
 * stripped of trailing whitespace (a kept trailing space paints `the …`, where CSS hangs the space
 * and paints `the…`). Callers rely on that trim: it is what stops the cut ever landing on a space.
 */
export const FitWithEllipsis = (text: string, maxWidth: number, ctx: Ctx2D): string => {
  if (!(maxWidth < Infinity)) return text;
  const Fits = (n: number): boolean => ctx.measureText(text.slice(0, n) + ELLIPSIS).width <= maxWidth;
  if (Fits(text.length)) return text;

  let lo = 0;
  let hi = text.length;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (Fits(mid)) lo = mid; else hi = mid;
  }
  const trailing = lo > 0 ? text.charCodeAt(lo - 1) : 0;
  if (trailing >= 0xd800 && trailing <= 0xdbff) lo--;
  return text.slice(0, lo).replace(/\s+$/, '');
};

// ─── Shared measurement cache ────────────────────────────────────────────────
//
// `MeasureText` is a pure function of (content, the style's METRIC fields,
// maxWidth) plus the font registry's current generation — and the layout
// pipeline asks it the same question several times in the same frame about the
// same node. `_measureDirtyText` takes the unbounded measure; then
// `Layout.Intrinsic._compute` re-measures at the wrap budget and deliberately
// throws the answer away ("DO NOT persist `wrapped`", Layout.Intrinsic.ts:129);
// then `Layout.Solver` re-measures at the allocated cross size and throws that
// one away too. Nothing in the tree changed between the three.
//
// Any page whose layout is dirty every frame — a pan, a scroll, a live spring —
// therefore re-shapes every paragraph in the whole tree on every frame. That is
// exactly the ground Blink wins this comparison on: it shapes a run once into a
// persistent cache, and a transform pan never re-shapes anything. This is our
// copy of that cache.
//
// Keyed on the METRIC fields only. Colour and alignment reach neither a line
// break nor an advance width, so a hover tint or a centre/left flip reuses the
// measurement instead of re-shaping the paragraph.
const _MEASURE_CACHE_MAX = 2048;
const _measureCache = new Map<string, TextMeasurement>();

const _measureKey = (content: string, s: ResolvedTextStyle, maxWidth: number | null): string =>
  s.FontFamily + '|' + s.FontSize + '|' + s.FontWeight + '|' + s.FontStyle
  + '|' + s.LineHeight + '|' + s.LetterSpacing + '|' + (s.MaxLines ?? -1)
  + '|' + s.TextOverflow + '|' + (maxWidth ?? -1) + '|' + content;

/** Drop the oldest quarter. Map iteration is insertion order and `MeasureText`
 *  re-inserts on every hit, so the front of the map is the least recently used. */
const _evictMeasurements = (): void => {
  const drop = Math.ceil(_measureCache.size * 0.25);
  let i = 0;
  for (const key of _measureCache.keys()) {
    _measureCache.delete(key);
    if (++i >= drop) break;
  }
};

/**
 * Measure text with optional word-wrapping at maxWidth.
 * Returns width (widest line), height (lines × lineHeight), and the wrapped lines.
 *
 * The returned object is CACHED AND SHARED — treat it as immutable. Two nodes
 * carrying the same words at the same metrics get the same object back.
 *
 * The `ctx` parameter is injectable for testing — passing one bypasses the
 * cache entirely, so a test that drives its own context always measures.
 */
export const MeasureText = (
  content: string,
  style: ResolvedTextStyle,
  maxWidth: number | null,
  ctx?: Ctx2D,
): TextMeasurement => {
  if (ctx !== undefined) return _measure(content, style, maxWidth, ctx);

  const key = _measureKey(content, style, maxWidth);
  const hit = _measureCache.get(key);
  if (hit !== undefined) {
    // Re-insert to move it to the back — keeps the eviction sweep honest LRU.
    _measureCache.delete(key);
    _measureCache.set(key, hit);
    return hit;
  }

  const measured = _measure(content, style, maxWidth, _getSharedContext());
  _measureCache.set(key, measured);
  if (_measureCache.size > _MEASURE_CACHE_MAX) _evictMeasurements();
  return measured;
};

const _measure = (
  content: string,
  style: ResolvedTextStyle,
  maxWidth: number | null,
  c: Ctx2D,
): TextMeasurement => {
  ApplyTextStyle(c, style, 1);

  const lineHeightPx = style.FontSize * style.LineHeight;

  if (content === '') {
    return { Width: 0, MinWidth: 0, Height: lineHeightPx, Lines: [''] };
  }

  // Trailing-newline trim: a span carrying "abc\n" or "abc\n\n" should
  // measure as 1 visible line. A trailing \n is a separator with no
  // paragraph after it — counting it would size the box for a phantom
  // line and LayoutWords (which renders) wouldn't fill it, leaving the
  // text renderer's vertical-centering pushing glyphs down by half a
  // line. Embedded \n between content (e.g. "Line 1\nLine 2") still
  // produces two lines, matching the documented behavior.
  const rawLines = content.split('\n');
  while (rawLines.length > 1 && rawLines[rawLines.length - 1] === '') {
    rawLines.pop();
  }

  // ONE shaping pass over the span: every DISTINCT word is measured once, and
  // everything downstream — min-content width, where the lines break, how wide
  // each line ends up — is arithmetic over those numbers.
  //
  // What this replaces: the wrap loop used to measure `currentLine + ' ' + word`
  // once per word, which re-shapes the line from its first character every time.
  // A 58-word paragraph shaped roughly 1,700 words' worth of text and built ~9KB
  // of throwaway strings to answer 58 questions, and two separate passes
  // (min-content, then per-line) re-shaped every word again after that.
  const widths = new Map<string, number>();
  let minWidth = 0;
  for (const paragraph of rawLines) {
    for (const word of paragraph.split(/\s+/)) {
      if (word.length === 0 || widths.has(word)) continue;
      const w = c.measureText(word).width;
      widths.set(word, w);
      if (w > minWidth) minWidth = w;
    }
  }

  // If the font isn't yet available to the 2D context, measureText(' ') can
  // return 0. Same quarter-em fallback LayoutWords uses — the caches are flushed
  // on font load, so correct metrics replace this shortly after.
  const rawSpace = c.measureText(' ').width;
  const spaceWidth = rawSpace > 0 && Number.isFinite(rawSpace) ? rawSpace : style.FontSize * 0.25;

  // No wrap — one line per paragraph (preserves explicit \n split). Each paragraph is its own
  // tail: with no budget there is nothing for the ellipsis rule to cut back to.
  if (maxWidth === null || maxWidth === Infinity) {
    const lines = _applyMaxLines(rawLines.map(_wholeLine), style, c, Infinity);
    return {
      Width: _widestLine(lines, widths, spaceWidth, c),
      MinWidth: minWidth,
      Height: lines.length * lineHeightPx,
      Lines: lines,
    };
  }

  // Word wrap. The break rule is LayoutWords' rule verbatim: a word starts a new
  // line when the running pen position (the words so far, plus one space each)
  // plus that word's own advance passes the budget. LayoutWords is what actually
  // PLACES the glyphs, so measuring by any other rule lets the box disagree with
  // the words inside it — the disagreement `_lineWidth`'s max(whole, sum) below
  // exists to absorb.
  const lines: WrappedLine[] = [];
  for (const paragraph of rawLines) {
    _wrapParagraph(paragraph, maxWidth, widths, spaceWidth, c, lines);
  }

  const clipped = _applyMaxLines(lines, style, c, maxWidth);
  return {
    Width: _widestLine(clipped, widths, spaceWidth, c),
    MinWidth: minWidth,
    Height: clipped.length * lineHeightPx,
    Lines: clipped,
  };
};

const _widestLine = (
  lines: string[], widths: Map<string, number>, spaceWidth: number, ctx: Ctx2D,
): number => {
  let max = 0;
  for (const line of lines) {
    const w = _lineWidth(line, widths, spaceWidth, ctx);
    if (w > max) max = w;
  }
  return max;
};

/** A line's width as the renderer will lay it: LayoutWords places word by word and adds a space width
 *  between them, and that sum can exceed the whole-line measure by a fraction of a pixel (kerning across
 *  the boundaries, per-word rounding). A box sized from the whole-line measure then wraps its last word.
 *  The box takes whichever is wider so the words always fit. One shaped run per LINE, not per word — the
 *  per-word half comes out of the `widths` map the caller already filled. */
const _lineWidth = (
  line: string, widths: Map<string, number>, spaceWidth: number, ctx: Ctx2D,
): number => {
  const whole = ctx.measureText(line).width;
  const words = line.split(/\s+/).filter((w) => w.length > 0);
  if (words.length < 2) return whole;
  let sum = spaceWidth * (words.length - 1);
  for (const word of words) sum += _wordWidth(word, widths, ctx);
  return Math.max(whole, sum);
};

/** Words in `widths` were measured in the caller's single pass. An ellipsis-
 *  truncated line introduces one token that was never in the source content
 *  ("scatt…"), so anything unseen falls back to a measure of its own. */
const _wordWidth = (word: string, widths: Map<string, number>, ctx: Ctx2D): number => {
  let w = widths.get(word);
  if (w === undefined) { w = ctx.measureText(word).width; widths.set(word, w); }
  return w;
};

/**
 * A wrapped line, and the paragraph TAIL it was cut from: this line's own words plus every word the
 * wrap pushed onto a later line. `Text` is the line as it wraps; the tail is what the ellipsis rule
 * measures against, because a character-granular cut is allowed to reach into the word the wrap
 * dropped. See `FitWithEllipsis`.
 *
 * `Words` is the paragraph's word list, SHARED by every line of that paragraph rather than sliced —
 * only the one line that ends up carrying an ellipsis ever materialises its tail.
 */
interface WrappedLine {
  Text: string;
  Words: readonly string[] | null;
  From: number;
}

/** A line with no wrap behind it, and therefore its own tail. */
const _wholeLine = (text: string): WrappedLine => ({ Text: text, Words: null, From: 0 });

const _tail = (line: WrappedLine): string =>
  line.Words === null ? line.Text : line.Words.slice(line.From).join(' ');

/** Wrap a single paragraph into lines, pushing into `out`. */
const _wrapParagraph = (
  paragraph: string,
  maxWidth: number,
  widths: Map<string, number>,
  spaceWidth: number,
  ctx: Ctx2D,
  out: WrappedLine[],
): void => {
  if (paragraph === '') {
    out.push(_wholeLine(''));
    return;
  }
  const words = paragraph.split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) {
    out.push(_wholeLine(''));
    return;
  }

  let lineStart = 0;
  let pen = 0;
  for (let i = 0; i < words.length; i++) {
    const w = _wordWidth(words[i], widths, ctx);
    if (pen > 0 && pen + w > maxWidth) {
      out.push({ Text: words.slice(lineStart, i).join(' '), Words: words, From: lineStart });
      lineStart = i;
      pen = 0;
    }
    pen += w + spaceWidth;
  }
  out.push({ Text: words.slice(lineStart).join(' '), Words: words, From: lineStart });
};

/**
 * Apply MaxLines + TextOverflow (Ellipsis) to the line list.
 *
 * The last surviving line is re-cut from its TAIL, not from itself: `FitWithEllipsis` owns where the
 * ellipsis falls and it may keep part of a word the wrap had already pushed away. Sizing the box
 * from the wrapped line while `LayoutWords` paints by the tail rule would put the ellipsis in two
 * different places on the same card.
 */
const _applyMaxLines = (
  lines: readonly WrappedLine[],
  style: ResolvedTextStyle,
  ctx: Ctx2D,
  maxWidth: number,
): string[] => {
  const text = lines.map((l) => l.Text);
  if (style.MaxLines === null || lines.length <= style.MaxLines) return text;

  const clipped = text.slice(0, style.MaxLines);
  if (style.TextOverflow === 'Ellipsis' && clipped.length > 0) {
    const last = lines[clipped.length - 1];
    clipped[clipped.length - 1] = FitWithEllipsis(_tail(last), maxWidth, ctx) + ELLIPSIS;
  }
  return clipped;
};
