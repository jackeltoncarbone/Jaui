import type { Jiv } from '../Jiv/Jiv';
import type { TextAnimator } from '../Text/Text.Animator';
import type { JivStyle } from '../Jiv/Jiv.Types';
import type { Animatable, AnimationManager } from '../Animation/Animation.Manager';
import { ResolveLengthTuple4 } from '../Core/Length.Tuple';
import { ApplyTextStyle } from '../Text/Text.Measure';

// Shared OffscreenCanvas 2D context used to measureText word prefixes for
// per-char selection geometry. Lazy because OffscreenCanvas isn't on every
// hot path that imports this file.
let _measureCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
const _getMeasureCtx = (): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D => {
  if (_measureCtx) return _measureCtx;
  const ctx = new OffscreenCanvas(1, 1).getContext('2d');
  if (!ctx) throw new Error('[Jaui] Selection.Manager: no 2D context');
  _measureCtx = ctx;
  return ctx;
};

/**
 * Text selection — each selected LINE of each Jiv is its own Jiv, so
 * highlights are fully styleable like any other element. Default = iOS-like
 * translucent blue; override per-text-Jiv via Jiv.TextSelectionStyle.
 *
 * Model: raw (anchor, extent) endpoints pointing at (Jiv, word). Endpoints
 * can reference different text Jivs — selection flows across Jiv boundaries
 * exactly like web selection flows across <div>/<p>/<span>. Order is
 * determined by document (render) order of text Jivs, which we derive from a
 * DFS walk of the tree at rebuild time.
 *
 * Endpoints are stored raw — anchor is NOT always before extent. This lets
 * shift-arrow (later) extend in the original drag direction. Normalization
 * happens at rebuild time.
 *
 * Rebuilds reconcile existing highlight Jivs per text-Jiv. A text Jiv that
 * falls out of the selected range has all its highlights removed; one that
 * stays gets its line-rects reused by index.
 */

export interface SelectionRange {
  AnchorJiv: Jiv;
  /** Char offset into AnchorJiv's TextAnimator content. */
  AnchorChar: number;
  ExtentJiv: Jiv;
  /** Char offset into ExtentJiv's TextAnimator content. */
  ExtentChar: number;
}

/** Matches jinput's selection rect (Jinput.jss → JinputSelectionRect) so
 *  general text selection and text-input selection read as the same
 *  primitive. Override per-text-Jiv via Jiv.TextSelectionStyle. */
/** Background color of the rect. BorderRadius is set per-rect to
 *  `rectHeight × SELECTION_RADIUS_RATIO` so the curve scales with the
 *  text size — matches the same compute in Jinput.SelectionRects. */
const DEFAULT_SELECTION_STYLE: Partial<JivStyle> = {
  Background: 'rgba(120, 170, 255, 0.32)',
};
const SELECTION_RADIUS_RATIO = 0.4;

/** Halo padding around each selected line. Mirrored in Jinput.SelectionRects
 *  so the same N-px breathing room shows up in both the input rect and the
 *  plain-text rect. */
const SELECTION_PAD_X = 3;
const SELECTION_PAD_Y = 2;

export class SelectionManager implements Animatable {
  private _selection: SelectionRange | null = null;
  private _highlights = new Map<Jiv, Jiv[]>();   // textJiv → per-line LIVE highlight Jivs
  /** Highlights that are fading out — tree-attached until Opacity settles
   *  near 0, then detached. Kept in a flat list because they don't care
   *  which line/text-Jiv they came from anymore; the parent reference is
   *  all we need to RemoveChild on finish. */
  private _dying: { Parent: Jiv; Jiv: Jiv }[] = [];
  private _Jiv: typeof import('../Jiv/Jiv').Jiv;
  private _getAnimator: (jiv: Jiv) => TextAnimator | undefined;
  private _animationManager: AnimationManager;
  /** Last selection-text published. Suppresses redundant change posts when
   *  the selection geometry rebuilds but the resolved plaintext is identical. */
  private _lastEmittedText: string = '';
  /** External subscriber for plaintext-only changes — wired by Canvas so
   *  the bridge can mirror selection across to the main thread for native
   *  clipboard copy. */
  private _onSelectionTextChanged: ((text: string, root: Jiv) => void) | null = null;

  constructor(
    JivClass: typeof import('../Jiv/Jiv').Jiv,
    getAnimator: (jiv: Jiv) => TextAnimator | undefined,
    animationManager: AnimationManager,
  ) {
    this._Jiv = JivClass;
    this._getAnimator = getAnimator;
    this._animationManager = animationManager;
    animationManager.Register(this);
  }

  /** Register a plaintext-change subscriber. Fires once after each `Set`
   *  with the concatenated selected text (empty string when cleared).
   *  Used by the worker bridge to mirror selection to main for native
   *  clipboard copy (`navigator.clipboard` writes inside the worker fail
   *  silently because user-gesture activation doesn't survive postMessage). */
  OnSelectionTextChanged = (cb: ((text: string, root: Jiv) => void) | null): void => {
    this._onSelectionTextChanged = cb;
  };

  get Current(): SelectionRange | null { return this._selection; }

  /** Per-frame tick — reap dying highlights whose fade-out has completed.
   *  Returns true while anything is still fading so the animation loop stays
   *  alive. Live Jivs keep their own Opacity springs on JivStyleAnimator. */
  Tick = (_dt: number): boolean => {
    let anyActive = false;
    for (let i = this._dying.length - 1; i >= 0; i--) {
      const d = this._dying[i];
      if (d.Jiv.RenderStyle.Opacity < 0.02) {
        d.Parent.RemoveChild(d.Jiv);
        this._dying.splice(i, 1);
      } else {
        anyActive = true;
      }
    }
    return anyActive;
  };

  /** Set a new selection. Rebuilds highlight Jivs across all involved text
   *  Jivs; any Jiv that was previously highlighted but is no longer in range
   *  has its highlights removed. Pass `null` to clear everything. */
  Set = (sel: SelectionRange | null, root: Jiv): void => {
    this._selection = sel;
    if (sel === null) {
      this._clearAll();
    } else {
      this._rebuild(sel, root);
    }
    this._emitTextChanged(root);
  };

  /** Compute the current selected plaintext and notify the external
   *  subscriber if it differs from the last emission. Called from `Set`
   *  so any selection mutation (drag, shift-arrow, select-all, clear)
   *  flows through this single chokepoint. */
  private _emitTextChanged = (root: Jiv): void => {
    if (!this._onSelectionTextChanged) return;
    const text = this._selection ? this.GetSelectedText(root) : '';
    if (text === this._lastEmittedText) return;
    this._lastEmittedText = text;
    this._onSelectionTextChanged(text, root);
  };

  /** Web-style user-select cascade — walk up from the candidate text Jiv;
   *  if any ancestor declares UserSelect:'None', selection is forbidden.
   *  (We don't model the rare 'contain' / 'all' values — Auto/None is the
   *  practical 99 % use case.) */
  IsSelectable = (textJiv: Jiv): boolean => {
    let cur: Jiv | null = textJiv;
    while (cur) {
      if (cur.UserSelect === 'None') return false;
      cur = cur.Parent as Jiv | null;
    }
    return true;
  };

  /** Find the text Jiv under (cssX, cssY). Matches native browser behavior:
   *    • If the hit path has a text ancestor → use it.
   *    • Else pick the text Jiv with the SMALLEST bounding rect that still
   *      contains the point — the most specific match. (Without this, a
   *      full-viewport page/tab Jiv like "Home" wins over an inline title
   *      whose rect is also inside it.)
   *    • Still nothing → fall back to NEAREST text Jiv by Euclidean distance
   *      to its rect (web: drag past the last paragraph still selects into
   *      it). Returns null only when the tree has zero text Jivs. */
  NearestTextJiv = (root: Jiv, hit: Jiv | null, cssX: number, cssY: number): Jiv | null => {
    let cur: Jiv | null = hit;
    while (cur) {
      if (this._hasText(cur)) return cur;
      cur = cur.Parent as Jiv | null;
    }
    let bestInside: Jiv | null = null;
    let bestArea = Infinity;
    let bestNear: Jiv | null = null;
    let bestDist = Infinity;
    this._walk(root, (j) => {
      if (!this._hasText(j)) return;
      const inside = cssX >= j.X && cssX < j.X + j.Width
        && cssY >= j.Y && cssY < j.Y + j.Height;
      if (inside) {
        const area = j.Width * j.Height;
        if (area < bestArea) { bestArea = area; bestInside = j; }
      } else {
        const dx = cssX < j.X ? j.X - cssX : cssX > j.X + j.Width ? cssX - (j.X + j.Width) : 0;
        const dy = cssY < j.Y ? j.Y - cssY : cssY > j.Y + j.Height ? cssY - (j.Y + j.Height) : 0;
        const d = dx * dx + dy * dy;
        if (d < bestDist) { bestDist = d; bestNear = j; }
      }
    });
    return bestInside ?? bestNear;
  };

  /** First text Jiv in document order — used by Cmd+A and fallbacks. */
  FirstTextJiv = (root: Jiv): Jiv | null => {
    const all = this._collectTextJivs(root);
    return all.length > 0 ? all[0] : null;
  };

  /** Last text Jiv in document order — used by Cmd+A select-all. */
  LastTextJiv = (root: Jiv): Jiv | null => {
    const all = this._collectTextJivs(root);
    return all.length > 0 ? all[all.length - 1] : null;
  };

  /** Compare two text Jivs in document (render) order.
   *  Returns -1 if `a` comes before `b`, 1 if after, 0 if equal or missing. */
  DocOrder = (a: Jiv, b: Jiv, root: Jiv): number => {
    if (a === b) return 0;
    const order = this._collectTextJivs(root);
    const ai = order.indexOf(a);
    const bi = order.indexOf(b);
    if (ai < 0 || bi < 0) return 0;
    return ai < bi ? -1 : 1;
  };

  /** Char range of the word containing char `idx`. If `idx` lands between
   *  words (whitespace), returns the char range of the nearest preceding
   *  word, or the next one if there's none before. */
  WordCharRangeAt = (textJiv: Jiv, idx: number): [number, number] => {
    const anim = this._getAnimator(textJiv);
    if (!anim || anim.Words.length === 0) return [0, 0];
    // Word containing idx
    for (const w of anim.Words) {
      if (idx >= w.CharStart && idx <= w.CharEnd) return [w.CharStart, w.CharEnd];
    }
    // Between words — find nearest
    let best = anim.Words[0];
    let bestDist = Math.abs(idx - best.CharStart);
    for (const w of anim.Words) {
      const d = Math.min(Math.abs(idx - w.CharStart), Math.abs(idx - w.CharEnd));
      if (d < bestDist) { bestDist = d; best = w; }
    }
    return [best.CharStart, best.CharEnd];
  };

  /** Char range of the line containing char `idx`. Lines don't cross Jiv
   *  boundaries — triple-click stays inside one paragraph. */
  LineCharRangeAt = (textJiv: Jiv, idx: number): [number, number] => {
    const anim = this._getAnimator(textJiv);
    if (!anim || anim.Words.length === 0) return [0, 0];
    // Locate the word for idx, then expand to all words on that line.
    let wordIdx = -1;
    for (let i = 0; i < anim.Words.length; i++) {
      const w = anim.Words[i];
      if (idx >= w.CharStart && idx <= w.CharEnd) { wordIdx = i; break; }
    }
    if (wordIdx < 0) {
      // Find nearest by index
      let best = 0, bestDist = Math.abs(idx - anim.Words[0].CharStart);
      for (let i = 0; i < anim.Words.length; i++) {
        const d = Math.min(Math.abs(idx - anim.Words[i].CharStart), Math.abs(idx - anim.Words[i].CharEnd));
        if (d < bestDist) { bestDist = d; best = i; }
      }
      wordIdx = best;
    }
    const lineY = Math.round(anim.Words[wordIdx].TargetY);
    let start = wordIdx;
    while (start > 0 && Math.round(anim.Words[start - 1].TargetY) === lineY) start--;
    let end = wordIdx;
    while (end < anim.Words.length - 1 && Math.round(anim.Words[end + 1].TargetY) === lineY) end++;
    return [anim.Words[start].CharStart, anim.Words[end].CharEnd];
  };

  /** [0, content.length] for one text Jiv. */
  FullRange = (textJiv: Jiv): [number, number] => {
    const anim = this._getAnimator(textJiv);
    if (!anim) return [0, 0];
    return [0, anim.Content.length];
  };

  /** Plain-text representation of the current selection across Jivs.
   *  Slices each Jiv's source content by char range; Jiv boundaries join
   *  with a newline. */
  GetSelectedText = (root: Jiv): string => {
    const sel = this._selection;
    if (!sel) return '';
    const order = this._collectTextJivs(root);
    const idxOf = new Map<Jiv, number>();
    for (let i = 0; i < order.length; i++) idxOf.set(order[i], i);
    const aIdx = idxOf.get(sel.AnchorJiv);
    const eIdx = idxOf.get(sel.ExtentJiv);
    if (aIdx === undefined || eIdx === undefined) return '';
    let loIdx: number, hiIdx: number, loChar: number, hiChar: number;
    if (aIdx < eIdx || (aIdx === eIdx && sel.AnchorChar <= sel.ExtentChar)) {
      loIdx = aIdx; hiIdx = eIdx; loChar = sel.AnchorChar; hiChar = sel.ExtentChar;
    } else {
      loIdx = eIdx; hiIdx = aIdx; loChar = sel.ExtentChar; hiChar = sel.AnchorChar;
    }
    const lines: string[] = [];
    for (let i = loIdx; i <= hiIdx; i++) {
      const j = order[i];
      const anim = this._getAnimator(j);
      if (!anim) continue;
      const content = anim.Content;
      const a = i === loIdx ? loChar : 0;
      const b = i === hiIdx ? hiChar : content.length;
      lines.push(content.slice(Math.max(0, Math.min(a, b)), Math.min(content.length, Math.max(a, b))));
    }
    return lines.join('\n');
  };

  /** Map a canvas-space point to a CHAR INDEX in the text Jiv's source
   *  content. Per-glyph hit-test: locate the line, then the nearest word
   *  on that line, then walk char-by-char via measureText to pick the
   *  glyph edge closest to the cursor. Always returns a valid index. */
  CharIndexAt = (textJiv: Jiv, cssX: number, cssY: number): number | null => {
    const anim = this._getAnimator(textJiv);
    if (!anim || anim.Words.length === 0) return null;

    const ctx = textJiv.ResolveCtx!;
    const [padT, , padB, padL] = ResolveLengthTuple4(textJiv.Layout.Padding, ctx, ['H', 'W', 'H', 'W']);
    const contentX = textJiv.X + padL;
    const contentY = textJiv.Y + padT;
    const contentH = textJiv.Height - padT - padB;

    let totalH = 0;
    for (const w of anim.Words) {
      const bottom = w.TargetY + w.Height;
      if (bottom > totalH) totalH = bottom;
    }
    const yOff = (contentH - totalH) / 2;

    const localX = cssX - contentX;
    const localY = cssY - contentY - yOff;

    // Pick the closest WORD by (line distance, then horizontal distance).
    let bestWord = anim.Words[0];
    let bestScore = Infinity;
    for (const w of anim.Words) {
      const lineTop = w.TargetY;
      const lineBot = w.TargetY + w.Height;
      const yInLine = localY >= lineTop && localY < lineBot;
      const dy = yInLine ? 0 : Math.min(Math.abs(localY - lineTop), Math.abs(localY - lineBot));
      const dx = localX < w.TargetX
        ? w.TargetX - localX
        : localX > w.TargetX + w.Width
          ? localX - (w.TargetX + w.Width)
          : 0;
      const score = dy * 1000 + dx;
      if (score < bestScore) { bestScore = score; bestWord = w; }
    }

    // Past the right of the picked word's line — pin to its end.
    if (localX >= bestWord.TargetX + bestWord.Width) return bestWord.CharEnd;
    // Before the left of the picked word — pin to its start.
    if (localX <= bestWord.TargetX) return bestWord.CharStart;

    // Inside the word — walk glyph offsets to find the nearest edge.
    const c = _getMeasureCtx();
    ApplyTextStyle(c, bestWord.Style, 1);
    const within = localX - bestWord.TargetX;
    const text = bestWord.Content;
    let prevW = 0;
    for (let i = 1; i <= text.length; i++) {
      const w = c.measureText(text.substring(0, i)).width;
      if (w >= within) {
        const pickRight = (w - within) <= (within - prevW);
        return bestWord.CharStart + (pickRight ? i : i - 1);
      }
      prevW = w;
    }
    return bestWord.CharEnd;
  };

  /** Collect every text Jiv in document (render) order. DFS, top-down,
   *  parent before children, children in declaration order. This is the
   *  ordering used to decide which endpoint comes first. */
  private _collectTextJivs = (root: Jiv): Jiv[] => {
    const out: Jiv[] = [];
    this._walk(root, (j) => { if (this._hasText(j)) out.push(j); });
    return out;
  };

  private _hasText = (j: Jiv): boolean => {
    const a = this._getAnimator(j);
    return j.Text !== null && a !== undefined && a.Words.length > 0;
  };

  private _walk = (node: Jiv, fn: (j: Jiv) => void): void => {
    fn(node);
    for (const c of node.Children as Jiv[]) this._walk(c, fn);
  };

  /** Fade out all highlights across all text Jivs. */
  private _clearAll = (): void => {
    for (const [textJiv, children] of this._highlights) {
      for (const h of children) this._kill(textJiv, h);
    }
    this._highlights.clear();
  };

  /** Fade out every highlight attached to a single text Jiv. */
  private _clearHighlights = (textJiv: Jiv): void => {
    const existing = this._highlights.get(textJiv);
    if (!existing) return;
    for (const h of existing) this._kill(textJiv, h);
    this._highlights.delete(textJiv);
  };

  /** Begin fade-out of a highlight: set Style.Opacity = 0 so the style
   *  animator springs toward 0, and track it in _dying so Tick can
   *  RemoveChild once the spring settles near 0. */
  private _kill = (parent: Jiv, jiv: Jiv): void => {
    jiv.Style.Opacity = '0';
    this._dying.push({ Parent: parent, Jiv: jiv });
    this._animationManager.Kick();
  };

  /** Compute the full set of (text-Jiv → char-slice) ranges covered by the
   *  current selection, then reconcile highlight children per Jiv. */
  private _rebuild = (sel: SelectionRange, root: Jiv): void => {
    const order = this._collectTextJivs(root);
    const idxOf = new Map<Jiv, number>();
    for (let i = 0; i < order.length; i++) idxOf.set(order[i], i);

    const aIdx = idxOf.get(sel.AnchorJiv);
    const eIdx = idxOf.get(sel.ExtentJiv);
    if (aIdx === undefined || eIdx === undefined) {
      this._clearAll();
      return;
    }

    let loJiv: Jiv, hiJiv: Jiv, loChar: number, hiChar: number;
    if (aIdx < eIdx || (aIdx === eIdx && sel.AnchorChar <= sel.ExtentChar)) {
      loJiv = sel.AnchorJiv; loChar = sel.AnchorChar;
      hiJiv = sel.ExtentJiv; hiChar = sel.ExtentChar;
    } else {
      loJiv = sel.ExtentJiv; loChar = sel.ExtentChar;
      hiJiv = sel.AnchorJiv; hiChar = sel.AnchorChar;
    }
    const lo = idxOf.get(loJiv)!;
    const hi = idxOf.get(hiJiv)!;

    const touched = new Set<Jiv>();
    for (let i = lo; i <= hi; i++) {
      const j = order[i];
      if (!this.IsSelectable(j)) {
        this._clearHighlights(j);
        continue;
      }
      const anim = this._getAnimator(j);
      if (!anim) continue;
      const len = anim.Content.length;

      let sChar: number, eChar: number;
      if (i === lo && i === hi) { sChar = loChar; eChar = hiChar; }
      else if (i === lo) { sChar = loChar; eChar = len; }
      else if (i === hi) { sChar = 0; eChar = hiChar; }
      else { sChar = 0; eChar = len; }

      this._rebuildOne(j, sChar, eChar);
      touched.add(j);
    }

    for (const textJiv of Array.from(this._highlights.keys())) {
      if (!touched.has(textJiv)) this._clearHighlights(textJiv);
    }
  };

  /** Build line-grouped highlight Jivs for one text Jiv covering char
   *  range [sChar..eChar]. Walks anim.Words, partitions any word whose
   *  char range partially overlaps the selection by measuring the prefix
   *  glyph widths so the highlight's left/right edges land at exact
   *  character boundaries — not snapped to word boundaries. */
  private _rebuildOne = (textJiv: Jiv, sChar: number, eChar: number): void => {
    const anim = this._getAnimator(textJiv);
    if (!anim || anim.Words.length === 0) {
      this._clearHighlights(textJiv);
      return;
    }
    const lo = Math.max(0, Math.min(sChar, eChar));
    const hi = Math.max(0, Math.max(sChar, eChar));
    if (hi <= lo) {
      this._clearHighlights(textJiv);
      return;
    }

    const c = _getMeasureCtx();
    const lineMap = new Map<number, { minX: number; maxX: number; y: number; h: number }>();
    for (const w of anim.Words) {
      // Skip words entirely outside the selected char range.
      if (w.CharEnd <= lo || w.CharStart >= hi) continue;

      // Compute the X range INSIDE this word that's selected.
      let leftOffset = 0;
      let rightOffset = w.Width;
      if (lo > w.CharStart || hi < w.CharEnd) {
        ApplyTextStyle(c, w.Style, 1);
        const charsBeforeStart = Math.max(0, lo - w.CharStart);
        const charsBeforeEnd = Math.max(0, Math.min(hi, w.CharEnd) - w.CharStart);
        leftOffset = charsBeforeStart > 0
          ? c.measureText(w.Content.substring(0, charsBeforeStart)).width
          : 0;
        rightOffset = charsBeforeEnd > 0
          ? c.measureText(w.Content.substring(0, charsBeforeEnd)).width
          : 0;
      }
      const rx0 = w.TargetX + leftOffset;
      const rx1 = w.TargetX + rightOffset;
      // Whitespace gap between this word and the next is ALSO part of the
      // selection when the selection extends past this word's end into the
      // gap. Extend rx1 forward to the next-on-line word's TargetX in that
      // case so the highlight reads continuously across the space.
      let rx1Extended = rx1;
      if (hi > w.CharEnd) {
        const lineY = w.TargetY;
        let nextOnLine: typeof w | null = null;
        for (const w2 of anim.Words) {
          if (w2 === w) continue;
          if (Math.round(w2.TargetY) !== Math.round(lineY)) continue;
          if (w2.CharStart <= w.CharEnd) continue;
          if (!nextOnLine || w2.CharStart < nextOnLine.CharStart) nextOnLine = w2;
        }
        if (nextOnLine && nextOnLine.CharStart <= hi) {
          rx1Extended = nextOnLine.TargetX;
        }
      }
      const lineKey = Math.round(w.TargetY);
      const entry = lineMap.get(lineKey);
      if (entry) {
        if (rx0 < entry.minX) entry.minX = rx0;
        if (rx1Extended > entry.maxX) entry.maxX = rx1Extended;
      } else {
        lineMap.set(lineKey, { minX: rx0, maxX: rx1Extended, y: w.TargetY, h: w.Height });
      }
    }
    if (lineMap.size === 0) {
      this._clearHighlights(textJiv);
      return;
    }

    // Content-origin offset — highlights are Placed (parent-relative) on the
    // text Jiv, so X/Y are relative to textJiv (0,0). We need padding + the
    // vertical-centering offset baked in.
    const ctx = textJiv.ResolveCtx!;
    const [padT, , padB, padL] = ResolveLengthTuple4(textJiv.Layout.Padding, ctx, ['H', 'W', 'H', 'W']);
    const contentH = textJiv.Height - padT - padB;
    let totalH = 0;
    for (let i = 0; i < anim.Words.length; i++) {
      const b = anim.Words[i].TargetY + anim.Words[i].Height;
      if (b > totalH) totalH = b;
    }
    const yOff = (contentH - totalH) / 2;

    const padX = SELECTION_PAD_X;
    const padY = SELECTION_PAD_Y;

    const rectsPerLine = Array.from(lineMap.values()).sort((a, b) => a.y - b.y);
    const existing = this._highlights.get(textJiv) ?? [];
    const userStyle = textJiv.TextSelectionStyle ?? null;

    const out: Jiv[] = [];
    for (let i = 0; i < rectsPerLine.length; i++) {
      const r = rectsPerLine[i];
      const x = padL + r.minX - padX;
      const y = padT + yOff + r.y - padY;
      const w = (r.maxX - r.minX) + padX * 2;
      const h = r.h + padY * 2;

      let jiv = existing[i];
      const radiusPx = h * SELECTION_RADIUS_RATIO;
      if (!jiv) {
        jiv = new this._Jiv({
          Style: {
            PointerEvents: 'None',
            ...DEFAULT_SELECTION_STYLE,
            BorderRadius: radiusPx + 'px',
            ...(userStyle ?? {}),
            Opacity: '0',
          } as Partial<JivStyle>,
          // Position via ChildLayout.Left/Top — the solver writes Placed
          // children to (offsetX + Left, offsetY + Top) and ignores the
          // jiv's own X/Y (those are the animator's post-spring value).
          // Mutating Left/Top each frame is how the inline childLayout
          // pattern (jinput's selection rect) drives per-frame position.
          ChildLayout: {
            Position: 'Placed',
            Left: x + 'px',
            Top: y + 'px',
            Width: w + 'px',
            Height: h + 'px',
          },
          // SnapLayout intentionally false — JivAnimator's default spring
          // smooths the rect's Width / Height when the selection grows or
          // shrinks, matching jinput's @Transition Width/Height feel.
        });
        textJiv.AddChild(jiv);
        const born = jiv;
        requestAnimationFrame(() => {
          born.Style.Opacity = '1';
          this._animationManager.Kick();
        });
      } else {
        jiv.ChildLayout.Left = x + 'px';
        jiv.ChildLayout.Top = y + 'px';
        jiv.ChildLayout.Width = w + 'px';
        jiv.ChildLayout.Height = h + 'px';
        jiv.Style.BorderRadius = radiusPx + 'px';
        jiv.MarkLayoutDirty();
      }
      out.push(jiv);
    }
    // Tail of the previous list that no longer has a matching line → fade out.
    for (let i = rectsPerLine.length; i < existing.length; i++) {
      this._kill(textJiv, existing[i]);
    }
    this._highlights.set(textJiv, out);
  };
}
