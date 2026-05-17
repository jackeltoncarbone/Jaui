import { Spring } from '../Animation/Spring';
import type { Animatable } from '../Animation/Animation.Manager';
import type { ResolvedTextStyle } from './Text.Types';
import { LayoutWords, Tokenize, type WordPosition } from './Text.WordLayout';

/**
 * Per-word animator. Each word has its own X/Y/Opacity springs so wrap changes,
 * content changes, and layout changes all animate continuously — no block fades,
 * no gated intervals. Matches the "instant target, smooth visual" principle.
 *
 * When content is identical but wrap changes (e.g. card width shrinks), each
 * word's position spring chases its new target continuously. Words that don't
 * move don't animate. Words that shift to a new line smoothly arc to it.
 *
 * When content changes, words are reconciled by (content, first-occurrence index):
 * identical tokens at matching indices keep their springs; others fade out, new
 * ones fade in.
 */

export interface AnimatedWord {
  Content: string;
  Style: ResolvedTextStyle;
  Width: number;           // CSS px (final measured width)
  Height: number;          // CSS px (line height)
  TargetX: number;
  TargetY: number;
  /** Inclusive char offset into the TextAnimator's source content. */
  CharStart: number;
  /** Exclusive char offset into the TextAnimator's source content. */
  CharEnd: number;
  SpringX: Spring;
  SpringY: Spring;
  Opacity: Spring;         // fade in/out
  /** Render-time scale around each word's center. Springs to 1.0. When a
   *  FontSize-only style change happens, rasterization snaps to the new
   *  size but Scale.Value is set to oldSize/newSize, so the glyph visually
   *  matches the old size on frame 0 and smoothly grows/shrinks to the
   *  new size. Keeps word-reconciliation out of the hot path for pure
   *  size changes — we don't fade old words out and new ones in. */
  Scale: Spring;
  /** Per-channel RGBA tint multiplier applied by the text shader. Settles
   *  at (1,1,1,1) for stable text. On a Color change, raster snaps to the
   *  new color but each channel spring is yanked to (oldChannel/newChannel)
   *  and targets 1.0, so the visible color matches the old color at frame 0
   *  and lerps to the new color as the springs settle. */
  TintR: Spring;
  TintG: Spring;
  TintB: Spring;
  TintA: Spring;
  Dying: boolean;          // true when opacity target is 0 (being removed)
}

export class TextAnimator implements Animatable {
  readonly Words: AnimatedWord[] = [];
  private _content: string = '';
  private _style: ResolvedTextStyle;
  private _maxWidth: number | null = null;

  /** Spring stiffness/damping for word position + opacity springs. */
  private _stiffness: number;
  private _damping: number;

  /** Block-level FontWeight spring. All words share this — when JSS / inline
   *  TextStyle resolves to a new weight, the spring lerps from the previous
   *  weight to the new one. Per-tick, the animator re-measures word positions
   *  at the snapped current weight so the atlas raster (which we fetch at the
   *  same snapped weight) always agrees with layout. Atlas churn is bounded
   *  by the 25-unit snap (12 entries max between 400..700). */
  private _weightSpring: Spring;
  /** Last weight at which positions were re-measured. Skip the re-measure
   *  when the snapped value hasn't actually moved across a 25-step boundary. */
  private _lastMeasuredWeight: number;
  /** Fired by `Tick` every frame the weight spring steps. Lets the Jaui
   *  core invalidate the owning node's TextMeasurement so the next layout
   *  pass re-measures intrinsic width at the new live weight — keeping
   *  the layout box's reported width in lockstep with the animating glyph
   *  metrics. Fired per-frame (not snap-gated) so layout reflows smoothly;
   *  snap is a renderer concern (atlas reuse), not a layout concern. */
  private _onWeightChange?: () => void;

  constructor(
    style: ResolvedTextStyle,
    stiffness: number = 260,
    damping: number = 30,
    onWeightChange?: () => void,
  ) {
    this._style = _cloneStyle(style);
    this._stiffness = stiffness;
    this._damping = damping;
    // Coerce in case the type contract slips and a string flows through —
    // Spring math on a string poisons the value to NaN.
    const w = Number(style.FontWeight);
    const initial = Number.isFinite(w) ? w : 400;
    this._weightSpring = new Spring(initial, stiffness, damping, 1);
    this._lastMeasuredWeight = initial;
    this._onWeightChange = onWeightChange;
  }

  get Content(): string { return this._content; }
  get Style(): ResolvedTextStyle { return this._style; }
  /** Current FontWeight to render at — the spring's value rounded to the
   *  nearest integer. Renderer uses this for the atlas fetch. Integer is
   *  the maximum granularity available (the canvas `font` shorthand parses
   *  fractional weights to integers anyway), and atlas LRU eviction (256
   *  entries cap) handles the transient churn during a transition (~18-30
   *  entries per spring at 60fps over a typical 300ms duration). A coarser
   *  snap produced perceptually discrete weight steps, which read as
   *  "rigid stepping" against the smooth layout reflow.
   *  Guards against non-finite values (style.FontWeight has slipped through
   *  as a string in some legacy code paths) by falling back to the style's
   *  declared weight — never NaN, which would corrupt the font string. */
  get EffectiveWeight(): number {
    const v = this._weightSpring.Value;
    if (!Number.isFinite(v)) return this._style.FontWeight;
    return Math.round(v);
  }

  /** Raw live spring value. Layout measurement reads this so the box's
   *  intrinsic width evolves continuously with the spring. Sub-pixel
   *  mismatch vs the integer-rounded raster width is well under a CSS
   *  pixel at normal font sizes. */
  get CurrentWeight(): number {
    const v = this._weightSpring.Value;
    if (!Number.isFinite(v)) return this._style.FontWeight;
    return v;
  }

  /**
   * Sync the animator to the current desired (content, style, maxWidth).
   * Returns true if any spring needs to animate (caller should Kick).
   */
  Update = (content: string, style: ResolvedTextStyle, maxWidth: number | null): boolean => {
    const contentChanged = content !== this._content;
    const styleChanged = _stylesDiffer(style, this._style);
    const sizeMorphPath = !contentChanged
      && styleChanged
      && this._style.FontSize !== style.FontSize;
    // Weight-only morph path (no content change, no size delta): the
    // _weightSpring lerps from the current weight to `style.FontWeight`.
    // Word positions are NOT snapped here — the per-tick remeasure inside
    // `Tick` updates positions to match the snapped current weight, so
    // layout stays in sync with the atlas raster throughout the
    // transition. Color changes still piggyback via the matched path's
    // tint setter if both change at once.
    const weightMorphPath = !contentChanged
      && styleChanged
      && !sizeMorphPath
      && this._style.FontWeight !== style.FontWeight;
    const wrapChanged = maxWidth !== this._maxWidth;

    let needsKick = false;

    if (sizeMorphPath) {
      needsKick = this._retargetFontSize(content, style, maxWidth) || needsKick;
      this._style = _cloneStyle(style);
      this._maxWidth = maxWidth;
    } else if (weightMorphPath) {
      needsKick = this._retargetWeight(style) || needsKick;
      this._style = _cloneStyle(style);
      this._maxWidth = maxWidth;
    } else if (contentChanged || styleChanged) {
      needsKick = this._reconcileContent(content, style, maxWidth) || needsKick;
      this._content = content;
      this._style = _cloneStyle(style);
      this._maxWidth = maxWidth;
      // Settling: reconcile owns measurement, so the weight spring's
      // settled value tracks the new style's weight directly. Coerce
      // defensively in case a stringly-typed weight slipped through.
      const w = Number(style.FontWeight);
      const safe = Number.isFinite(w) ? w : 400;
      this._weightSpring.Value = safe;
      this._weightSpring.Velocity = 0;
      this._weightSpring.Set(safe);
      this._lastMeasuredWeight = safe;
    } else if (wrapChanged) {
      needsKick = this._reflow(maxWidth) || needsKick;
      this._maxWidth = maxWidth;
    }

    // Prune dead words that finished fading out
    for (let i = this.Words.length - 1; i >= 0; i--) {
      const w = this.Words[i];
      if (w.Dying && w.Opacity.IsSettled && w.Opacity.Value < 0.01) {
        this.Words.splice(i, 1);
      }
    }

    return needsKick;
  };

  /**
   * Re-run word layout against current content/style/maxWidth without
   * touching per-word identities or springs. Used when font metrics
   * change after the first measurement — e.g. a web font finishes
   * loading. Word Opacity stays where it is (already visible words
   * stay visible; no fade-in pop), only Width/Height/positions refresh
   * to the new metrics. Returns true if any position spring needs to
   * animate (caller should Kick).
   */
  Resync = (): boolean => {
    return this._reflow(this._maxWidth);
  };

  Tick = (dt: number): boolean => {
    let active = false;
    // Advance the block-level weight spring. If it moved at all, re-measure
    // internal word positions at the raw current weight (NOT the snapped
    // `EffectiveWeight`) so word slots evolve smoothly — and notify the
    // host so the owning Jiv's intrinsic width re-measures at the same
    // raw weight on the next layout pass. Without this, surrounding boxes
    // would jump in 25-unit chunks (or all at once, before this work, when
    // they snapped straight to the target weight on frame 0).
    const stepped = this._weightSpring.Step(dt);
    if (stepped) {
      active = true;
      const raw = this._weightSpring.Value;
      if (Number.isFinite(raw)) {
        this._remeasureAtWeight(raw);
        this._lastMeasuredWeight = raw;
      }
      this._onWeightChange?.();
    }
    for (const w of this.Words) {
      if (w.SpringX.Step(dt)) active = true;
      if (w.SpringY.Step(dt)) active = true;
      if (w.Opacity.Step(dt)) active = true;
      if (w.Scale.Step(dt)) active = true;
      if (w.TintR.Step(dt)) active = true;
      if (w.TintG.Step(dt)) active = true;
      if (w.TintB.Step(dt)) active = true;
      if (w.TintA.Step(dt)) active = true;
    }
    return active;
  };

  // ─── Internal ───

  /** Style-only weight transition (no content change, no FontSize delta).
   *  Springs the block-level weight from current to `newStyle.FontWeight`.
   *  Word positions are not snapped — the per-tick `_remeasureAtWeight`
   *  inside `Tick` updates positions to match each step's snapped weight,
   *  keeping the atlas raster width and layout in sync throughout the
   *  transition. If color also changed in the same style swap, each word's
   *  Tint{R,G,B,A} spring is yanked the usual way so the color crossfade
   *  rides alongside the weight morph. */
  private _retargetWeight = (newStyle: ResolvedTextStyle): boolean => {
    let needsKick = false;
    const oldWeight = this._weightSpring.Value;
    const targetRaw = Number(newStyle.FontWeight);
    const target = Number.isFinite(targetRaw) ? targetRaw : oldWeight;
    this._weightSpring.Value = oldWeight;
    this._weightSpring.Velocity = 0;
    if (this._weightSpring.Set(target)) needsKick = true;
    // The renderer uses the snapped spring value; positions get re-measured
    // on Tick when the snap crosses a 25-unit boundary.
    for (const w of this.Words) {
      const oldStyle = w.Style;
      w.Style = _cloneStyle(newStyle);
      if (_setTintForColorChange(w, oldStyle.Color, newStyle.Color)) needsKick = true;
    }
    return needsKick;
  };

  /** Re-run word layout at a specific FontWeight, used during a weight
   *  morph to keep word positions in sync with the atlas. Caller is the
   *  per-tick spring stepper; it gates on snapped-value change so this
   *  isn't called every frame. Spring identity is preserved — only
   *  Width / TargetX / TargetY are updated; SpringX/Y are snapped to the
   *  new target so the smooth motion comes from the weight spring, not
   *  from compounded position chase.
   *
   *  `maxWidth` is intentionally passed as `null` here — during a weight
   *  transition the parent Jiv's allocated width often races the atlas
   *  raster (the box shrinks at the new style's intrinsic before the
   *  raster has settled), and wrapping inside `LayoutWords` against the
   *  intermediate width briefly re-flows the span onto a new line. With
   *  no wrap budget the words stay on one line regardless of weight; the
   *  Jiv layout's eventual re-solve handles any actual overflow. */
  private _remeasureAtWeight = (weight: number): void => {
    const measureStyle: ResolvedTextStyle = { ...this._style, FontWeight: weight };
    const positions = LayoutWords(this._content, measureStyle, null);
    const visible = Math.min(this.Words.length, positions.length);
    for (let i = 0; i < visible; i++) {
      const w = this.Words[i];
      const p = positions[i];
      w.Width = p.Width;
      w.Height = p.Height;
      w.SpringX.Value = p.X; w.SpringX.Velocity = 0; w.SpringX.Set(p.X);
      w.SpringY.Value = p.Y; w.SpringY.Velocity = 0; w.SpringY.Set(p.Y);
      w.TargetX = p.X;
      w.TargetY = p.Y;
    }
  };

  /** Retarget existing words for a content-unchanged style change that
   *  includes a FontSize delta. Raster snaps to the new style; each word's
   *  Scale spring is yanked to `oldSize/newSize` so the visible glyph
   *  matches the old size on frame 0 and smoothly springs to 1.0 at the
   *  new size. If Color also changed, each word's Tint{R,G,B,A} spring is
   *  yanked to `oldColor/newColor` per channel and targets 1.0 — the new
   *  raster has the new baked color, the tint multiplies it back to the
   *  old visible color at frame 0, then lerps to passthrough.
   *  Positions are re-measured against the new style so layout settles
   *  at the new width; SpringX/Y smoothly chase the new positions. */
  private _retargetFontSize = (
    newContent: string,
    newStyle: ResolvedTextStyle,
    maxWidth: number | null,
  ): boolean => {
    const ratio = this._style.FontSize > 0 ? this._style.FontSize / newStyle.FontSize : 1;
    const positions = LayoutWords(newContent, newStyle, maxWidth);
    const living = this.Words.filter((w) => !w.Dying);

    let needsKick = false;
    for (let i = 0; i < living.length && i < positions.length; i++) {
      const w = living[i];
      const p = positions[i];
      const oldStyle = w.Style;
      w.Style = _cloneStyle(newStyle);
      w.Width = p.Width;
      w.Height = p.Height;
      w.CharStart = p.CharStart;
      w.CharEnd = p.CharEnd;
      if (w.TargetX !== p.X) {
        if (w.SpringX.Set(p.X)) needsKick = true;
        w.TargetX = p.X;
      }
      if (w.TargetY !== p.Y) {
        if (w.SpringY.Set(p.Y)) needsKick = true;
        w.TargetY = p.Y;
      }
      w.Scale.Value = ratio;
      w.Scale.Velocity = 0;
      if (w.Scale.Set(1)) needsKick = true;
      if (_setTintForColorChange(w, oldStyle.Color, newStyle.Color)) needsKick = true;
    }
    return needsKick;
  };

  private _reflow = (maxWidth: number | null): boolean => {
    const living = this.Words.filter((w) => !w.Dying);
    const positions = LayoutWords(this._content, this._style, maxWidth);

    let needsKick = false;
    for (let i = 0; i < living.length && i < positions.length; i++) {
      const w = living[i];
      const p = positions[i];
      w.Width = p.Width;
      w.Height = p.Height;
      w.CharStart = p.CharStart;
      w.CharEnd = p.CharEnd;
      if (w.TargetX !== p.X) {
        if (w.SpringX.Set(p.X)) needsKick = true;
        w.TargetX = p.X;
      }
      if (w.TargetY !== p.Y) {
        if (w.SpringY.Set(p.Y)) needsKick = true;
        w.TargetY = p.Y;
      }
    }
    return needsKick;
  };

  private _reconcileContent = (
    newContent: string,
    newStyle: ResolvedTextStyle,
    maxWidth: number | null,
  ): boolean => {
    const newTokens = Tokenize(newContent);
    const newPositions = LayoutWords(newContent, newStyle, maxWidth);
    // LayoutWords may clip trailing tokens (e.g. MaxLines reached), so the
    // visible token set is whatever has a position — anything past that is
    // dropped from the animated word list.
    const visibleCount = newPositions.length;

    // Match new tokens against living words by content — first-occurrence greedy match.
    const living = this.Words.filter((w) => !w.Dying);
    const usedLiving = new Set<AnimatedWord>();
    const matched: (AnimatedWord | null)[] = new Array(visibleCount).fill(null);

    for (let i = 0; i < visibleCount; i++) {
      const token = newTokens[i];
      for (const w of living) {
        if (!usedLiving.has(w) && w.Content === token) {
          matched[i] = w;
          usedLiving.add(w);
          break;
        }
      }
    }

    let needsKick = false;

    // Build the new Words array in newTokens order. Reusing matched words
    // keeps their springs (smooth motion), creating new ones for unmatched
    // positions, and dying ones (no longer in the new content) get appended
    // at the end so they fade out without disturbing the live word order.
    // Critical: Words[i] must correspond to newTokens[i] for the lifetime
    // of the animator — _reflow zips positions by index, so any drift here
    // causes words to render at the wrong x positions on the next reflow.
    const reordered: AnimatedWord[] = [];

    // Update matched words (position change + style update)
    for (let i = 0; i < visibleCount; i++) {
      const existing = matched[i];
      const p = newPositions[i];
      if (existing) {
        const oldStyle = existing.Style;
        existing.Style = _cloneStyle(newStyle);
        existing.Width = p.Width;
        existing.Height = p.Height;
        existing.CharStart = p.CharStart;
        existing.CharEnd = p.CharEnd;
        if (existing.TargetX !== p.X) {
          existing.SpringX.Set(p.X);
          existing.SpringX.Snap();
          existing.TargetX = p.X;
        }
        if (existing.TargetY !== p.Y) {
          existing.SpringY.Set(p.Y);
          existing.SpringY.Snap();
          existing.TargetY = p.Y;
        }
        if (existing.Opacity.Set(1)) needsKick = true;
        if (_setTintForColorChange(existing, oldStyle.Color, newStyle.Color)) needsKick = true;
        reordered.push(existing);
      } else {
        const word: AnimatedWord = {
          Content: newTokens[i],
          Style: _cloneStyle(newStyle),
          Width: p.Width,
          Height: p.Height,
          TargetX: p.X,
          TargetY: p.Y,
          CharStart: p.CharStart,
          CharEnd: p.CharEnd,
          SpringX: new Spring(p.X, this._stiffness, this._damping, 1),
          SpringY: new Spring(p.Y, this._stiffness, this._damping, 1),
          Opacity: new Spring(0, this._stiffness, this._damping, 1),
          Scale: new Spring(1, this._stiffness, this._damping, 1),
          TintR: new Spring(1, this._stiffness, this._damping, 1),
          TintG: new Spring(1, this._stiffness, this._damping, 1),
          TintB: new Spring(1, this._stiffness, this._damping, 1),
          TintA: new Spring(1, this._stiffness, this._damping, 1),
          Dying: false,
        };
        word.Opacity.Set(1);
        reordered.push(word);
        needsKick = true;
      }
    }

    // Words not matched → fade out (kept in array but marked dying so the
    // prune step after Update() can remove them once their opacity settles)
    for (const w of living) {
      if (!usedLiving.has(w)) {
        if (w.Opacity.Set(0)) needsKick = true;
        w.Dying = true;
        reordered.push(w);
      }
    }
    // Preserve any already-dying words (they haven't finished fading yet).
    for (const w of this.Words) {
      if (w.Dying && !reordered.includes(w)) reordered.push(w);
    }

    this.Words.length = 0;
    this.Words.push(...reordered);

    return needsKick;
  };
}

// ─── Helpers ───

/** When a word's color is changing, snap each Tint{R,G,B,A} spring to the
 *  oldChannel/newChannel ratio (so the tinted new-color raster looks like
 *  the old color on frame 0) and target 1.0 so it lerps to passthrough.
 *  Channels where the new value is 0 fall back to ratio=1 — multiplying by
 *  0 is already 0 regardless of tint, and the after-settle visual is the
 *  intended new color. Returns true if anything changed. */
const _setTintForColorChange = (
  word: AnimatedWord,
  oldColor: import('../Core/Types').Color,
  newColor: import('../Core/Types').Color,
): boolean => {
  if (oldColor.R === newColor.R && oldColor.G === newColor.G
      && oldColor.B === newColor.B && oldColor.A === newColor.A) {
    return false;
  }
  const r = newColor.R > 0 ? oldColor.R / newColor.R : 1;
  const g = newColor.G > 0 ? oldColor.G / newColor.G : 1;
  const b = newColor.B > 0 ? oldColor.B / newColor.B : 1;
  const a = newColor.A > 0 ? oldColor.A / newColor.A : 1;
  word.TintR.Value = r; word.TintR.Velocity = 0; word.TintR.Set(1);
  word.TintG.Value = g; word.TintG.Velocity = 0; word.TintG.Set(1);
  word.TintB.Value = b; word.TintB.Velocity = 0; word.TintB.Set(1);
  word.TintA.Value = a; word.TintA.Velocity = 0; word.TintA.Set(1);
  return true;
};

const _stylesDiffer = (a: ResolvedTextStyle, b: ResolvedTextStyle): boolean => {
  return a.FontFamily !== b.FontFamily
    || a.FontSize !== b.FontSize
    || a.FontWeight !== b.FontWeight
    || a.FontStyle !== b.FontStyle
    || a.LineHeight !== b.LineHeight
    || a.LetterSpacing !== b.LetterSpacing
    || a.TextAlign !== b.TextAlign
    // Nullish-safe — JSS-derived partial styles can omit TextAlignLast,
    // so a missing value on either side reads as the default 'Auto'
    // instead of triggering a false-positive style diff every frame.
    || (a.TextAlignLast ?? 'Auto') !== (b.TextAlignLast ?? 'Auto')
    || a.TextOverflow !== b.TextOverflow
    || a.MaxLines !== b.MaxLines
    || a.Color.R !== b.Color.R || a.Color.G !== b.Color.G
    || a.Color.B !== b.Color.B || a.Color.A !== b.Color.A;
};

const _cloneStyle = (s: ResolvedTextStyle): ResolvedTextStyle => ({
  ...s,
  Color: { ...s.Color },
});

// Re-exported helper for tests
export { type WordPosition };
