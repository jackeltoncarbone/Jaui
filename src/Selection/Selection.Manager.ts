import type { Jiv } from '../Jiv/Jiv';
import type { TextAnimator } from '../Text/Text.Animator';
import type { JivStyle } from '../Jiv/Jiv.Types';

/**
 * Text selection — each selected LINE is its own Jiv, so selection highlights
 * are fully styleable like any other element. Default = iOS-like translucent
 * blue; can be overridden per-text-Jiv via Jiv.TextSelectionStyle.
 *
 * Model: a selection is (anchorJiv, anchorWord) → (extentJiv, extentWord).
 * MVP restricts to selection within a single text Jiv — cross-Jiv selection
 * is a later enhancement (requires a global word ordering across Jivs).
 *
 * Rebuilds on every selection change. Reuses existing highlight Jivs where
 * possible — creating a Jiv every pointermove would thrash the animator
 * registry. Line highlights are Placed children of the text Jiv, Y/X
 * relative to the text's content origin (accounts for padding + vertical
 * centering at emit time).
 */

export interface SelectionRange {
  TextJiv: Jiv;
  StartWord: number;
  EndWord: number;   // inclusive; StartWord ≤ EndWord
}

/** iOS-like selection color — subtle, readable on any backdrop. Chunky
 *  border radius reads as "highlight pill," not "text underline." Override
 *  any or all via Jiv.TextSelectionStyle — Material:'LiquidGlass' works for
 *  a glassy selection, BorderColor for an outline, Thickness for bevel. */
const DEFAULT_SELECTION_STYLE: Partial<JivStyle> = {
  Background: { R: 0.33, G: 0.56, B: 0.98, A: 0.38 },
  BorderRadius: [6, 6, 6, 6],
};

export class SelectionManager {
  private _selection: SelectionRange | null = null;
  private _highlights = new Map<Jiv, Jiv[]>();   // textJiv → per-line highlight Jivs
  private _Jiv: typeof import('../Jiv/Jiv').Jiv;
  private _getAnimator: (jiv: Jiv) => TextAnimator | undefined;

  constructor(
    JivClass: typeof import('../Jiv/Jiv').Jiv,
    getAnimator: (jiv: Jiv) => TextAnimator | undefined,
  ) {
    this._Jiv = JivClass;
    this._getAnimator = getAnimator;
  }

  get Current(): SelectionRange | null { return this._selection; }

  /** Set a new selection. Rebuilds highlight Jivs.
   *  Pass `null` to clear. */
  Set = (sel: SelectionRange | null): void => {
    // If target changed, clear old highlights on the previous text Jiv
    if (this._selection && this._selection.TextJiv !== sel?.TextJiv) {
      this._clearHighlights(this._selection.TextJiv);
    }
    this._selection = sel;
    if (sel) this._rebuild(sel);
  };

  /** Find the text Jiv nearest to (cssX, cssY). First tries the hit path
   *  (topmost Jiv's ancestor chain that has text); if nothing there has
   *  text, scans the whole tree for the Jiv whose bounding rect is closest
   *  (zero distance = inside). Matches web behavior: clicking in the margin
   *  near a paragraph still starts selection on that paragraph. */
  NearestTextJiv = (root: Jiv, hit: Jiv | null, cssX: number, cssY: number): Jiv | null => {
    // Prefer the hit target's text ancestor (click INTO text is unambiguous)
    let cur: Jiv | null = hit;
    while (cur) {
      if (this._hasText(cur)) return cur;
      cur = cur.Parent;
    }
    // Fallback: nearest by Euclidean distance to rect edge
    let best: Jiv | null = null;
    let bestDist = Infinity;
    this._walk(root, (j) => {
      if (!this._hasText(j)) return;
      const dx = cssX < j.X ? j.X - cssX : cssX > j.X + j.Width ? cssX - (j.X + j.Width) : 0;
      const dy = cssY < j.Y ? j.Y - cssY : cssY > j.Y + j.Height ? cssY - (j.Y + j.Height) : 0;
      const d = dx * dx + dy * dy;
      if (d < bestDist) { bestDist = d; best = j; }
    });
    return best;
  };

  private _hasText = (j: Jiv): boolean => {
    const a = this._getAnimator(j);
    return j.Text !== null && a !== undefined && a.Words.length > 0;
  };

  private _walk = (node: Jiv, fn: (j: Jiv) => void): void => {
    fn(node);
    for (const c of node.Children) this._walk(c, fn);
  };

  /** Word index of the line break after this word (used for line selection). */
  LineRangeFor = (textJiv: Jiv, wordIdx: number): [number, number] => {
    const anim = this._getAnimator(textJiv);
    if (!anim || wordIdx < 0 || wordIdx >= anim.Words.length) return [0, 0];
    const lineY = Math.round(anim.Words[wordIdx].TargetY);
    let start = wordIdx;
    while (start > 0 && Math.round(anim.Words[start - 1].TargetY) === lineY) start--;
    let end = wordIdx;
    while (end < anim.Words.length - 1 && Math.round(anim.Words[end + 1].TargetY) === lineY) end++;
    return [start, end];
  };

  /** Full text range (for triple-click-and-drag or Select-All). */
  FullRange = (textJiv: Jiv): [number, number] => {
    const anim = this._getAnimator(textJiv);
    if (!anim || anim.Words.length === 0) return [0, 0];
    return [0, anim.Words.length - 1];
  };

  /** Map a canvas-space point to a word index within a text Jiv. Always
   *  returns a valid index — the nearest word even if the point is far
   *  outside the Jiv's bounds. Matches browser selection: drag past the
   *  bottom edge and you keep selecting toward the end. */
  WordIndexAt = (textJiv: Jiv, cssX: number, cssY: number): number | null => {
    const anim = this._getAnimator(textJiv);
    if (!anim || anim.Words.length === 0) return null;

    const padding = textJiv.Layout.Padding;
    const contentX = textJiv.X + padding[3];
    const contentY = textJiv.Y + padding[0];
    const contentH = textJiv.Height - padding[0] - padding[2];

    // Vertical centering offset (matches Canvas._emitTextFor)
    let totalH = 0;
    for (const w of anim.Words) {
      const bottom = w.TargetY + w.Height;
      if (bottom > totalH) totalH = bottom;
    }
    const yOff = (contentH - totalH) / 2;

    const localX = cssX - contentX;
    const localY = cssY - contentY - yOff;

    // Find best-match word: closest word on the nearest line
    let best = -1;
    let bestScore = Infinity;
    for (let i = 0; i < anim.Words.length; i++) {
      const w = anim.Words[i];
      const lineTop = w.TargetY;
      const lineBot = w.TargetY + w.Height;
      // If click is within the vertical span of this line, prefer it
      const yInLine = localY >= lineTop && localY < lineBot;
      const dy = yInLine ? 0 : Math.min(Math.abs(localY - lineTop), Math.abs(localY - lineBot));
      // Within the word horizontally, dx = 0; outside, distance to nearest edge
      const dx = localX < w.TargetX
        ? w.TargetX - localX
        : localX > w.TargetX + w.Width
          ? localX - (w.TargetX + w.Width)
          : 0;
      const score = dy * 1000 + dx;   // line match dominates
      if (score < bestScore) { bestScore = score; best = i; }
    }
    return best >= 0 ? best : null;
  };

  /** Drop all highlights attached to a given text Jiv. */
  private _clearHighlights = (textJiv: Jiv): void => {
    const existing = this._highlights.get(textJiv);
    if (!existing) return;
    for (const h of existing) textJiv.RemoveChild(h);
    this._highlights.delete(textJiv);
  };

  /** Compute line-grouped rectangles for the current selection range and
   *  reconcile against the existing highlight Jivs on the text Jiv. */
  private _rebuild = (sel: SelectionRange): void => {
    const anim = this._getAnimator(sel.TextJiv);
    if (!anim || anim.Words.length === 0) {
      this._clearHighlights(sel.TextJiv);
      return;
    }

    const lo = Math.max(0, Math.min(sel.StartWord, sel.EndWord));
    const hi = Math.min(anim.Words.length - 1, Math.max(sel.StartWord, sel.EndWord));

    // Group selected words by line. AnimatedWord doesn't carry a line index,
    // but TargetY uniquely identifies a line (same Y = same line). Round to
    // handle minor spring drift during a rebuild mid-animation.
    const lineMap = new Map<number, { minX: number; maxX: number; y: number; h: number }>();
    for (let i = lo; i <= hi; i++) {
      const w = anim.Words[i];
      const lineKey = Math.round(w.TargetY);
      const entry = lineMap.get(lineKey);
      const rx0 = w.TargetX;
      const rx1 = w.TargetX + w.Width;
      if (entry) {
        if (rx0 < entry.minX) entry.minX = rx0;
        if (rx1 > entry.maxX) entry.maxX = rx1;
      } else {
        lineMap.set(lineKey, { minX: rx0, maxX: rx1, y: w.TargetY, h: w.Height });
      }
    }

    // Content-origin offset — highlights are Placed (parent-relative) on the
    // text Jiv, so X/Y are relative to textJiv (0,0). We need padding + the
    // vertical-centering offset baked in.
    const padding = sel.TextJiv.Layout.Padding;
    const contentH = sel.TextJiv.Height - padding[0] - padding[2];
    let totalH = 0;
    for (let i = 0; i < anim.Words.length; i++) {
      const b = anim.Words[i].TargetY + anim.Words[i].Height;
      if (b > totalH) totalH = b;
    }
    const yOff = (contentH - totalH) / 2;

    // Pad the highlight rect slightly so it reads as a selection halo, not a
    // skin-tight wrap. 2 px horizontal, 1 px vertical feels native.
    const padX = 2;
    const padY = 1;

    const rectsPerLine = Array.from(lineMap.values()).sort((a, b) => a.y - b.y);
    const existing = this._highlights.get(sel.TextJiv) ?? [];
    const userStyle = sel.TextJiv.TextSelectionStyle ?? null;

    // Reconcile: reuse existing Jivs by index, add new, remove extra
    const out: Jiv[] = [];
    for (let i = 0; i < rectsPerLine.length; i++) {
      const r = rectsPerLine[i];
      const x = padding[3] + r.minX - padX;
      const y = padding[0] + yOff + r.y - padY;
      const w = (r.maxX - r.minX) + padX * 2;
      const h = r.h + padY * 2;

      let jiv = existing[i];
      if (!jiv) {
        jiv = new this._Jiv({
          Style: { ...DEFAULT_SELECTION_STYLE, ...(userStyle ?? {}) } as Partial<JivStyle>,
          ChildLayout: { Position: 'Placed', Width: w, Height: h },
          X: x, Y: y, Width: w, Height: h,
        });
        sel.TextJiv.AddChild(jiv);
      } else {
        jiv.X = x; jiv.Y = y; jiv.Width = w; jiv.Height = h;
        jiv.MarkLayoutDirty();
      }
      out.push(jiv);
    }
    // Prune extras from any previous larger selection
    for (let i = rectsPerLine.length; i < existing.length; i++) {
      sel.TextJiv.RemoveChild(existing[i]);
    }
    this._highlights.set(sel.TextJiv, out);
  };
}
