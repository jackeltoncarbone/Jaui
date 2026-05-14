import type { Jiv } from '../Jiv/Jiv';
import type { TextAnimator } from '../Text/Text.Animator';
import type { JivStyle } from '../Jiv/Jiv.Types';
import type { Animatable, AnimationManager } from '../Animation/Animation.Manager';
import { ResolveLengthTuple4 } from '../Core/Length.Tuple';

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
  AnchorWord: number;
  ExtentJiv: Jiv;
  ExtentWord: number;
}

/** Matches jinput's selection rect (Jinput.jss → JinputSelectionRect) so
 *  general text selection and text-input selection read as the same
 *  primitive. Override per-text-Jiv via Jiv.TextSelectionStyle. */
const DEFAULT_SELECTION_STYLE: Partial<JivStyle> = {
  Background: 'rgba(120, 170, 255, 0.32)',
  BorderRadius: '4pt',
};

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
      return;
    }
    this._rebuild(sel, root);
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

  /** Word range of the line containing `wordIdx` within `textJiv`. Lines
   *  don't cross Jiv boundaries — triple-click stays inside one paragraph. */
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

  /** Word-count range [0, N-1] for one text Jiv (used by single-Jiv full
   *  select; Cmd+A across the document uses FirstTextJiv/LastTextJiv). */
  FullRange = (textJiv: Jiv): [number, number] => {
    const anim = this._getAnimator(textJiv);
    if (!anim || anim.Words.length === 0) return [0, 0];
    return [0, anim.Words.length - 1];
  };

  /** Plain-text representation of the current selection. Spans all Jivs
   *  between the (normalized) anchor and extent; words on the same Jiv join
   *  with a single space, Jiv-boundary joins use a newline. Returns '' when
   *  there's no selection. */
  GetSelectedText = (root: Jiv): string => {
    const sel = this._selection;
    if (!sel) return '';
    const order = this._collectTextJivs(root);
    const idxOf = new Map<Jiv, number>();
    for (let i = 0; i < order.length; i++) idxOf.set(order[i], i);
    const aIdx = idxOf.get(sel.AnchorJiv);
    const eIdx = idxOf.get(sel.ExtentJiv);
    if (aIdx === undefined || eIdx === undefined) return '';
    let loIdx: number, hiIdx: number, loWord: number, hiWord: number;
    if (aIdx < eIdx || (aIdx === eIdx && sel.AnchorWord <= sel.ExtentWord)) {
      loIdx = aIdx; hiIdx = eIdx; loWord = sel.AnchorWord; hiWord = sel.ExtentWord;
    } else {
      loIdx = eIdx; hiIdx = aIdx; loWord = sel.ExtentWord; hiWord = sel.AnchorWord;
    }
    const lines: string[] = [];
    for (let i = loIdx; i <= hiIdx; i++) {
      const j = order[i];
      const anim = this._getAnimator(j);
      if (!anim || anim.Words.length === 0) continue;
      const sWord = i === loIdx ? loWord : 0;
      const eWord = i === hiIdx ? hiWord : anim.Words.length - 1;
      const lo = Math.max(0, Math.min(sWord, eWord));
      const hi = Math.min(anim.Words.length - 1, Math.max(sWord, eWord));
      const words: string[] = [];
      for (let k = lo; k <= hi; k++) words.push(anim.Words[k].Content);
      lines.push(words.join(' '));
    }
    return lines.join('\n');
  };

  /** Map a canvas-space point to a word index within a text Jiv. Always
   *  returns a valid index — the nearest word even if the point is far
   *  outside the Jiv's bounds. Matches browser selection: drag past the
   *  bottom edge and you keep selecting toward the end. */
  WordIndexAt = (textJiv: Jiv, cssX: number, cssY: number): number | null => {
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

    let best = -1;
    let bestScore = Infinity;
    for (let i = 0; i < anim.Words.length; i++) {
      const w = anim.Words[i];
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
      if (score < bestScore) { bestScore = score; best = i; }
    }
    return best >= 0 ? best : null;
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

  /** Compute the full set of (text-Jiv → word-slice) ranges covered by the
   *  current selection, then reconcile highlight children per Jiv. */
  private _rebuild = (sel: SelectionRange, root: Jiv): void => {
    const order = this._collectTextJivs(root);
    const idxOf = new Map<Jiv, number>();
    for (let i = 0; i < order.length; i++) idxOf.set(order[i], i);

    const aIdx = idxOf.get(sel.AnchorJiv);
    const eIdx = idxOf.get(sel.ExtentJiv);
    if (aIdx === undefined || eIdx === undefined) {
      // Either endpoint's Jiv is no longer in the tree — clear everything.
      this._clearAll();
      return;
    }

    // Normalize (lo, hi) by document order — anchor may be after extent
    // when the user drags backward; we still store raw in _selection.
    let loJiv: Jiv, hiJiv: Jiv, loWord: number, hiWord: number;
    if (aIdx < eIdx || (aIdx === eIdx && sel.AnchorWord <= sel.ExtentWord)) {
      loJiv = sel.AnchorJiv; loWord = sel.AnchorWord;
      hiJiv = sel.ExtentJiv; hiWord = sel.ExtentWord;
    } else {
      loJiv = sel.ExtentJiv; loWord = sel.ExtentWord;
      hiJiv = sel.AnchorJiv; hiWord = sel.AnchorWord;
    }
    const lo = idxOf.get(loJiv)!;
    const hi = idxOf.get(hiJiv)!;

    // Walk every text Jiv in [lo..hi] and rebuild its per-line highlights.
    // Jivs outside the range that still carry highlights get cleared below.
    const touched = new Set<Jiv>();
    for (let i = lo; i <= hi; i++) {
      const j = order[i];
      if (!this.IsSelectable(j)) {
        this._clearHighlights(j);
        continue;
      }
      const anim = this._getAnimator(j);
      if (!anim || anim.Words.length === 0) continue;

      let sWord: number, eWord: number;
      if (i === lo && i === hi) { sWord = loWord; eWord = hiWord; }
      else if (i === lo) { sWord = loWord; eWord = anim.Words.length - 1; }
      else if (i === hi) { sWord = 0; eWord = hiWord; }
      else { sWord = 0; eWord = anim.Words.length - 1; }

      this._rebuildOne(j, sWord, eWord);
      touched.add(j);
    }

    // Clear any previously-highlighted Jiv that's no longer in the range.
    for (const textJiv of Array.from(this._highlights.keys())) {
      if (!touched.has(textJiv)) this._clearHighlights(textJiv);
    }
  };

  /** Build line-grouped highlight Jivs for one text Jiv covering words
   *  [sWord..eWord] inclusive. Reuses existing highlight Jivs by index. */
  private _rebuildOne = (textJiv: Jiv, sWord: number, eWord: number): void => {
    const anim = this._getAnimator(textJiv);
    if (!anim || anim.Words.length === 0) {
      this._clearHighlights(textJiv);
      return;
    }
    const lo = Math.max(0, Math.min(sWord, eWord));
    const hi = Math.min(anim.Words.length - 1, Math.max(sWord, eWord));

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
    const ctx = textJiv.ResolveCtx!;
    const [padT, , padB, padL] = ResolveLengthTuple4(textJiv.Layout.Padding, ctx, ['H', 'W', 'H', 'W']);
    const contentH = textJiv.Height - padT - padB;
    let totalH = 0;
    for (let i = 0; i < anim.Words.length; i++) {
      const b = anim.Words[i].TargetY + anim.Words[i].Height;
      if (b > totalH) totalH = b;
    }
    const yOff = (contentH - totalH) / 2;

    // Tight rect — no halo padding, matching jinput's per-char rect so the
    // bounding box across both selection mechanisms reads the same.
    const padX = 0;
    const padY = 0;

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
      if (!jiv) {
        // Born invisible (Opacity 0) so the first layout pass snaps the
        // style animator's Opacity spring to 0. We then flip Style.Opacity
        // to 1 on the next frame — the spring springs 0→1 and the highlight
        // fades in. Matches "Everything animates" default.
        jiv = new this._Jiv({
          // PointerEvents:'None' so the highlight never blocks the text Jiv
          // beneath it from receiving subsequent pointerdowns / hits.
          Style: {
            PointerEvents: 'None',
            ...DEFAULT_SELECTION_STYLE,
            ...(userStyle ?? {}),
            Opacity: '0',
          } as Partial<JivStyle>,
          // ChildLayout sizes are 'Auto' so the solver falls through to
          // jiv.Width/Height — which we mutate every drag tick. Otherwise
          // the solver would snap the highlight back to its original word
          // bounds on the next layout pass.
          ChildLayout: { Position: 'Placed', Width: 'Auto', Height: 'Auto' },
          X: x, Y: y, Width: w, Height: h,
          // Snap layout every frame — the highlight's position/size are
          // driven imperatively on each pointermove. Spring-chasing would
          // lag the highlight behind the cursor by a handful of frames.
          SnapLayout: true,
        });
        textJiv.AddChild(jiv);
        // After the first layout pass snaps the style animator to Opacity 0,
        // raise the target to 1 so the spring eases in.
        const born = jiv;
        requestAnimationFrame(() => {
          born.Style.Opacity = '1';
          this._animationManager.Kick();
        });
      } else {
        jiv.X = x; jiv.Y = y; jiv.Width = w; jiv.Height = h;
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
