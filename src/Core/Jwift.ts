/**
 * Jwift — Canvas-based UI rendering engine.
 * Entry point. Creates a WebGL2 context and runs the render loop.
 */

import { JivRenderer } from '../Jiv/Jiv.Renderer';
import { JivAnimator } from '../Jiv/Jiv.Animator';
import { AnimationManager } from '../Animation/Animation.Manager';
import { SolveLayout } from '../Layout/Layout.Solver';
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
  private _animationManager = new AnimationManager();
  private _animators = new Map<Jiv, JivAnimator>();

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

    // Animation manager triggers re-render when springs step
    this._animationManager.OnFrame(() => this.RequestFrame());

    this._resize();
    this._observeResize();
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
    if (this._hasDirtyLayout(this.Root)) {
      this._solveAndAnimate();
      this._clearDirty(this.Root);
    }

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
  };

  private _collectInstances = (node: Jiv): void => {
    if (node.Width > 0 && node.Height > 0 && node.Style.Visible) {
      this._jivRenderer.AddInstance(node, this._dpr);
    }
    for (const child of node.Children) {
      this._collectInstances(child);
    }
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
  };

  private _hasDirtyLayout = (node: Jiv): boolean => {
    if (node.Dirty & DirtyFlag.Layout) return true;
    for (const child of node.Children) {
      if (this._hasDirtyLayout(child)) return true;
    }
    return false;
  };

  private _clearDirty = (node: Jiv): void => {
    node.Dirty &= ~(DirtyFlag.Layout | DirtyFlag.Children);
    for (const child of node.Children) this._clearDirty(child);
  };

  private _resize = (): void => {
    this._dpr = Math.min(window.devicePixelRatio || 1, 2);
    this._width = this.Element.clientWidth;
    this._height = this.Element.clientHeight;
    this.Element.width = Math.round(this._width * this._dpr);
    this.Element.height = Math.round(this._height * this._dpr);

    // Mark root dirty so layout re-solves with new dimensions
    this.Root.Dirty |= DirtyFlag.Layout;

    // Re-render immediately so the buffer isn't blank between frames
    if (this._running) {
      if (this._hasDirtyLayout(this.Root)) {
        this._solveAndAnimate();
        this._clearDirty(this.Root);
      }
      this._render(0);
    }
  };

  private _observeResize = (): void => {
    const observer = new ResizeObserver(() => this._resize());
    observer.observe(this.Element);
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

// Transform
export type { Transform } from '../Transform/Transform.Types';

// Text
export type { TextStyle, TextAlign, TextOverflow, FontStyle } from '../Text/Text.Types';

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
