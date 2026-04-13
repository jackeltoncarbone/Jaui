/**
 * Jwift — Canvas-based UI rendering engine.
 * Entry point. Creates a WebGL2 context and runs the render loop.
 */

import { JivRenderer } from '../Jiv/Jiv.Renderer';
import { JivAnimator } from '../Jiv/Jiv.Animator';
import { AnimationManager } from '../Animation/Animation.Manager';
import { SolveLayout } from '../Layout/Layout.Solver';
import { ComputeIntrinsicSizes } from '../Layout/Layout.Intrinsic';
import { TextCache } from '../Text/Text.Cache';
import { TextRenderer } from '../Text/Text.Renderer';
import { MeasureText } from '../Text/Text.Measure';
import { TextAnimator } from '../Text/Text.Animator';
import { DirtyFlag } from './Types';
import { Jiv } from '../Jiv/Jiv';

export class Canvas {
  readonly Gl: WebGL2RenderingContext;
  readonly Element: HTMLCanvasElement;
  readonly Root: Jiv;

  private _width: number = 0;
  private _height: number = 0;
  private _dpr: number = 1;
  private _running: boolean = false;
  private _frameId: number = 0;
  private _lastTime: number = 0;
  private _jivRenderer!: JivRenderer;
  private _textRenderer!: TextRenderer;
  private _textCache!: TextCache;
  private _animationManager = new AnimationManager();
  private _animators = new Map<Jiv, JivAnimator>();
  private _textAnimators = new Map<Jiv, TextAnimator>();

  constructor(canvas: HTMLCanvasElement) {
    this.Element = canvas;
    this.Root = new Jiv();

    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });

    if (!gl) throw new Error('[Jwift] WebGL2 not supported');
    this.Gl = gl;

    this._jivRenderer = new JivRenderer(gl);
    this._textRenderer = new TextRenderer(gl);
    this._textCache = new TextCache(gl);

    // Animation manager triggers re-render when springs step
    this._animationManager.OnFrame(() => this.RequestFrame());

    this._resize();
    this._observeResize();
    this._watchDpr();
  }

  /** The internal AnimationManager — exposed for external use (e.g. manual animators). */
  get Animations(): AnimationManager { return this._animationManager; }

  Start = (): void => {
    if (this._running) return;
    this._running = true;
    this._lastTime = 0;
    this._frameId = requestAnimationFrame(this._tick);
  };

  Stop = (): void => {
    this._running = false;
    if (this._frameId) {
      cancelAnimationFrame(this._frameId);
      this._frameId = 0;
    }
  };

  get Width(): number { return this._width; }
  get Height(): number { return this._height; }
  get Dpr(): number { return this._dpr; }

  /** Request an immediate re-render (called by animation manager). */
  RequestFrame = (): void => {
    if (this._running) this._render(0);
  };

  private _tick = (time: number): void => {
    if (!this._running) return;
    this._frameId = requestAnimationFrame(this._tick);

    const dt = this._lastTime === 0 ? 0.016 : Math.min((time - this._lastTime) / 1000, 0.033);
    this._lastTime = time;

    // Check if layout needs re-solving
    if (this._hasDirtyLayout(this.Root) || this._hasDirtyText(this.Root)) {
      this._measureDirtyText(this.Root);
      ComputeIntrinsicSizes(this.Root);
      this._solveAndAnimate();
      this._clearDirty(this.Root);
    }

    // Wrap-change detection runs every frame — spring-animated width can cross
    // wrap thresholds continuously, and each crossing should cross-fade.
    this._processTextTransitions(this.Root);

    this._render(dt);
  };

  private _render = (_dt: number): void => {
    const gl = this.Gl;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;

    gl.viewport(0, 0, w, h);
    gl.clearColor(0.04, 0.04, 0.04, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Enable blending for alpha compositing
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // Collect all visible Jivs into the instance buffer, then draw once
    this._jivRenderer.BeginFrame();
    this._collectInstances(this.Root);
    this._jivRenderer.DrawAll(w, h);

    // Text pass (on top of panels)
    this._textCache.BeginFrame();
    this._textRenderer.BeginFrame();
    this._collectTextInstances(this.Root);
    this._textRenderer.DrawAll(w, h);
  };

  private _collectInstances = (node: Jiv): void => {
    if (node.Width > 0 && node.Height > 0 && node.Style.Visible) {
      this._jivRenderer.AddInstance(node, this._dpr);
    }
    for (const child of node.Children) {
      this._collectInstances(child);
    }
  };

  private _collectTextInstances = (node: Jiv): void => {
    if (node.Width > 0 && node.Height > 0 && node.Style.Visible) {
      const anim = this._textAnimators.get(node);
      if (anim && anim.Words.length > 0) {
        const padding = node.Layout.Padding;
        const contentX = node.X + padding[3];
        const contentY = node.Y + padding[0];
        const contentH = node.Height - padding[0] - padding[2];

        // Vertical centering within the content box (based on total text block height)
        let totalTextHeight = 0;
        for (const w of anim.Words) {
          const bottom = w.TargetY + w.Height;
          if (bottom > totalTextHeight) totalTextHeight = bottom;
        }
        const yOffset = (contentH - totalTextHeight) / 2;

        for (const w of anim.Words) {
          const opacity = node.Style.Opacity * w.Opacity.Value;
          if (opacity <= 0.001) continue;

          const entry = this._textCache.Get(w.Content, w.Style, null, this._dpr);
          const wx = contentX + w.SpringX.Value;
          const wy = contentY + yOffset + w.SpringY.Value;
          this._textRenderer.AddText({
            Texture: entry.Texture,
            X: wx * this._dpr,
            Y: wy * this._dpr,
            Width: entry.Width,
            Height: entry.Height,
            Opacity: opacity,
          });
        }
      }
    }
    for (const child of node.Children) {
      this._collectTextInstances(child);
    }
  };

  private _processTextTransitions = (node: Jiv): void => {
    const padding = node.Layout.Padding;
    const contentW = node.Width - padding[3] - padding[1];
    const maxWidth = contentW > 0 ? contentW : null;

    if (node.Text !== null) {
      let anim = this._textAnimators.get(node);
      if (!anim) {
        anim = new TextAnimator(node.TextStyle);
        this._textAnimators.set(node, anim);
        this._animationManager.Register(anim);
      }
      if (anim.Update(node.Text, node.TextStyle, maxWidth)) {
        this._animationManager.Kick();
      }
    } else {
      const anim = this._textAnimators.get(node);
      if (anim && anim.Content !== '') {
        if (anim.Update('', node.TextStyle, maxWidth)) {
          this._animationManager.Kick();
        }
      }
    }
    for (const child of node.Children) this._processTextTransitions(child);
  };

  private _hasDirtyText = (node: Jiv): boolean => {
    if (node.Dirty & DirtyFlag.Text) return true;
    for (const child of node.Children) {
      if (this._hasDirtyText(child)) return true;
    }
    return false;
  };

  private _measureDirtyText = (node: Jiv): void => {
    if (node.Text !== null && (node.Dirty & DirtyFlag.Text || node.TextMeasurement === null)) {
      // Unbounded measurement — intrinsic sizing with padding is handled by ComputeIntrinsicSizes
      node.TextMeasurement = MeasureText(node.Text, node.TextStyle, null);
    } else if (node.Text === null) {
      node.TextMeasurement = null;
      node.IntrinsicWidth = null;
      node.IntrinsicHeight = null;
    }
    for (const child of node.Children) this._measureDirtyText(child);
  };

  // ─── Layout Integration ───

  private _solveAndAnimate = (): void => {
    // Root fills the canvas
    this.Root.Width = this._width;
    this.Root.Height = this._height;

    const results = SolveLayout(this.Root);

    for (const [node, result] of results) {
      // Skip the root — it doesn't animate to its own position
      if (node === this.Root) continue;

      let animator = this._animators.get(node);
      if (!animator) {
        // First layout: set position THEN create animator so springs init at correct values
        node.X = result.X;
        node.Y = result.Y;
        node.Width = result.Width;
        node.Height = result.Height;

        animator = new JivAnimator(node);
        this._animators.set(node, animator);
        this._animationManager.Register(animator);
      } else {
        const needsKick = animator.SetTargets({
          X: result.X,
          Y: result.Y,
          Width: result.Width,
          Height: result.Height,
        });
        if (needsKick) this._animationManager.Kick();
      }
    }

    // Clean up animators for removed nodes
    for (const [node, animator] of this._animators) {
      if (!results.has(node)) {
        this._animationManager.Unregister(animator);
        this._animators.delete(node);
      }
    }
    for (const [node, tAnim] of this._textAnimators) {
      if (!results.has(node)) {
        this._animationManager.Unregister(tAnim);
        this._textAnimators.delete(node);
      }
    }
  };

  private _hasDirtyLayout = (node: Jiv): boolean => {
    if (node.Dirty & DirtyFlag.Layout) return true;
    for (const child of node.Children) {
      if (this._hasDirtyLayout(child)) return true;
    }
    return false;
  };

  private _clearDirty = (node: Jiv): void => {
    node.Dirty &= ~(DirtyFlag.Layout | DirtyFlag.Children | DirtyFlag.Text);
    for (const child of node.Children) this._clearDirty(child);
  };

  private _resize = (): void => {
    // Use native DPR uncapped — browser zoom increases DPR above 2 (e.g. 125% zoom on a
    // 1.5x display = DPR 1.875), and capping would render at lower res than the display,
    // producing blurry text/edges. Text cache naturally invalidates because its hash
    // includes DPR; higher DPR costs more memory/fill but keeps strokes crisp.
    this._dpr = window.devicePixelRatio || 1;
    this._width = this.Element.clientWidth;
    this._height = this.Element.clientHeight;
    this.Element.width = Math.round(this._width * this._dpr);
    this.Element.height = Math.round(this._height * this._dpr);

    // Mark root dirty so layout re-solves with new dimensions
    this.Root.Dirty |= DirtyFlag.Layout;

    // Re-render immediately so the buffer isn't blank between frames
    if (this._running) {
      if (this._hasDirtyLayout(this.Root) || this._hasDirtyText(this.Root)) {
        this._measureDirtyText(this.Root);
        ComputeIntrinsicSizes(this.Root);
        this._solveAndAnimate();
        this._clearDirty(this.Root);
      }
      this._processTextTransitions(this.Root);
      this._render(0);
    }
  };

  private _observeResize = (): void => {
    const observer = new ResizeObserver(() => this._resize());
    observer.observe(this.Element);
  };

  private _watchDpr = (): void => {
    // matchMedia only fires when the specified dpr condition changes (e.g. on browser zoom).
    // We register a one-shot listener, then re-register with the new dpr.
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(`(resolution: ${this._dpr}dppx)`);
    const handler = (): void => {
      this._resize();
      this._watchDpr();
    };
    if (mql.addEventListener) {
      mql.addEventListener('change', handler, { once: true } as AddEventListenerOptions);
    }
  };
}

// ─── Re-exports by slice ───

export { Jath } from './Jath';
export { Jiv } from '../Jiv/Jiv';

// Core
export type { Vec2, Vec4, Rect, Color, DeviceTier, DirtyFlags } from './Types';
export { DirtyFlag } from './Types';

// Jiv
export type { JivStyle, CornerShape, BlendMode } from '../Jiv/Jiv.Types';

// Layout
export type {
  LayoutMode, FlexDirection, FlexWrap, JustifyContent, AlignItems, AlignContent,
  PositionMode, Overflow, LayoutConfig, ChildLayout, LayoutResult,
  GridConfig, GridTrack,
} from '../Layout/Layout.Types';
export { SolveFlex, type FlexContainer, type FlexChild } from '../Layout/Layout.Flex';
export { SolveLayout } from '../Layout/Layout.Solver';
export { ComputeIntrinsicSizes } from '../Layout/Layout.Intrinsic';

// Transform
export type { Transform } from '../Transform/Transform.Types';

// Text
export type { TextStyle, TextAlign, TextOverflow, FontStyle, TextMeasurement, TextConfig } from '../Text/Text.Types';
export { DefaultTextStyle } from '../Text/Text.Types';
export { MeasureText } from '../Text/Text.Measure';
export { HashTextKey } from '../Text/Text.Hash';
export { TextCache } from '../Text/Text.Cache';

// Image
export type { ImageStyle, ObjectFit } from '../Image/Image.Types';

// Scroll
export type { ScrollConfig } from '../Scroll/Scroll.Types';

// Animation
export type { SpringConfig, TransitionConfig } from '../Animation/Animation.Types';
export { AnimationManager } from '../Animation/Animation.Manager';
export { JivAnimator } from '../Jiv/Jiv.Animator';

// Accessibility
export type { AccessibilityConfig } from '../Accessibility/Accessibility.Types';
