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

  constructor(style: ResolvedTextStyle, stiffness: number = 260, damping: number = 30) {
    this._style = _cloneStyle(style);
    this._stiffness = stiffness;
    this._damping = damping;
  }

  get Content(): string { return this._content; }
  get Style(): ResolvedTextStyle { return this._style; }

  /**
   * Sync the animator to the current desired (content, style, maxWidth).
   * Returns true if any spring needs to animate (caller should Kick).
   */
  Update = (content: string, style: ResolvedTextStyle, maxWidth: number | null): boolean => {
    const contentChanged = content !== this._content;
    const styleChanged = _stylesDiffer(style, this._style);
    const fontSizeOnlyChanged = !contentChanged
      && styleChanged
      && _onlyFontSizeDiffers(this._style, style);
    const wrapChanged = maxWidth !== this._maxWidth;

    let needsKick = false;

    if (fontSizeOnlyChanged) {
      // Pure size change — skip the fade-out/in reconcile. Keep the same
      // words, retarget their Scale spring so the NEW-size raster visually
      // matches the OLD size on frame 0 and springs to 1.0. Re-measure
      // widths/positions with the new style so layout settles.
      needsKick = this._retargetFontSize(content, style, maxWidth) || needsKick;
      this._style = _cloneStyle(style);
      this._maxWidth = maxWidth;
    } else if (contentChanged || styleChanged) {
      needsKick = this._reconcileContent(content, style, maxWidth) || needsKick;
      this._content = content;
      this._style = _cloneStyle(style);
      this._maxWidth = maxWidth;
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

  Tick = (dt: number): boolean => {
    let active = false;
    for (const w of this.Words) {
      if (w.SpringX.Step(dt)) active = true;
      if (w.SpringY.Step(dt)) active = true;
      if (w.Opacity.Step(dt)) active = true;
      if (w.Scale.Step(dt)) active = true;
    }
    return active;
  };

  // ─── Internal ───

  /** Retarget existing words for a pure FontSize change. Raster snaps to
   *  the new size (via Style update), but each word's Scale spring is
   *  yanked to `oldSize/newSize` so the visible glyph matches the old
   *  size on frame 0 and smoothly springs back to 1.0 at the new size.
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
      w.Style = _cloneStyle(newStyle);
      w.Width = p.Width;
      w.Height = p.Height;
      if (w.TargetX !== p.X) {
        if (w.SpringX.Set(p.X)) needsKick = true;
        w.TargetX = p.X;
      }
      if (w.TargetY !== p.Y) {
        if (w.SpringY.Set(p.Y)) needsKick = true;
        w.TargetY = p.Y;
      }
      // Snap the scale spring to the old/new ratio so visuals match the
      // pre-change size, then target 1.0 so it springs to real size.
      w.Scale.Value = ratio;
      w.Scale.Velocity = 0;
      if (w.Scale.Set(1)) needsKick = true;
    }
    return needsKick;
  };

  private _reflow = (maxWidth: number | null): boolean => {
    // Content + style unchanged — just reposition living words to new targets.
    const living = this.Words.filter((w) => !w.Dying);
    const positions = LayoutWords(this._content, this._style, maxWidth);

    let needsKick = false;
    for (let i = 0; i < living.length && i < positions.length; i++) {
      const w = living[i];
      const p = positions[i];
      // Refresh metrics every reflow — if the last LayoutWords ran before
      // fonts were ready and returned bad Widths, the reflow that fires
      // once fonts load is what recovers them.
      w.Width = p.Width;
      w.Height = p.Height;
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

    // Match new tokens against living words by content — first-occurrence greedy match.
    const living = this.Words.filter((w) => !w.Dying);
    const usedLiving = new Set<AnimatedWord>();
    const matched: (AnimatedWord | null)[] = newTokens.map(() => null);

    for (let i = 0; i < newTokens.length; i++) {
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

    // Update matched words (position change + style update)
    for (let i = 0; i < newTokens.length; i++) {
      const existing = matched[i];
      const p = newPositions[i];
      if (existing) {
        existing.Style = _cloneStyle(newStyle);
        existing.Width = p.Width;
        existing.Height = p.Height;
        if (existing.TargetX !== p.X) {
          if (existing.SpringX.Set(p.X)) needsKick = true;
          existing.TargetX = p.X;
        }
        if (existing.TargetY !== p.Y) {
          if (existing.SpringY.Set(p.Y)) needsKick = true;
          existing.TargetY = p.Y;
        }
        // Ensure fully visible in case it was fading
        if (existing.Opacity.Set(1)) needsKick = true;
      } else {
        // New word — fade in at target position
        const word: AnimatedWord = {
          Content: newTokens[i],
          Style: _cloneStyle(newStyle),
          Width: p.Width,
          Height: p.Height,
          TargetX: p.X,
          TargetY: p.Y,
          SpringX: new Spring(p.X, this._stiffness, this._damping, 1),
          SpringY: new Spring(p.Y, this._stiffness, this._damping, 1),
          Opacity: new Spring(0, this._stiffness, this._damping, 1),
          Scale: new Spring(1, this._stiffness, this._damping, 1),
          Dying: false,
        };
        word.Opacity.Set(1);
        this.Words.push(word);
        needsKick = true;
      }
    }

    // Words not matched → fade out
    for (const w of living) {
      if (!usedLiving.has(w)) {
        if (w.Opacity.Set(0)) needsKick = true;
        w.Dying = true;
      }
    }

    return needsKick;
  };
}

// ─── Helpers ───

/** True if ONLY FontSize changed between a and b (everything else equal). */
const _onlyFontSizeDiffers = (a: ResolvedTextStyle, b: ResolvedTextStyle): boolean => {
  if (a.FontSize === b.FontSize) return false;
  return a.FontFamily === b.FontFamily
    && a.FontWeight === b.FontWeight
    && a.FontStyle === b.FontStyle
    && a.LineHeight === b.LineHeight
    && a.LetterSpacing === b.LetterSpacing
    && a.TextAlign === b.TextAlign
    && a.TextOverflow === b.TextOverflow
    && a.MaxLines === b.MaxLines
    && a.Color.R === b.Color.R && a.Color.G === b.Color.G
    && a.Color.B === b.Color.B && a.Color.A === b.Color.A;
};

const _stylesDiffer = (a: ResolvedTextStyle, b: ResolvedTextStyle): boolean => {
  return a.FontFamily !== b.FontFamily
    || a.FontSize !== b.FontSize
    || a.FontWeight !== b.FontWeight
    || a.FontStyle !== b.FontStyle
    || a.LineHeight !== b.LineHeight
    || a.LetterSpacing !== b.LetterSpacing
    || a.TextAlign !== b.TextAlign
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
