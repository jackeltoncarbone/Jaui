/**
 * Jwift — Canvas-based UI rendering engine.
 * Entry point. Creates a WebGL2 context and runs the render loop.
 */

import { JivRenderer } from '../Jiv/Jiv.Renderer';
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

    this._resize();
    this._observeResize();
  }

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

  private _tick = (time: number): void => {
    if (!this._running) return;
    this._frameId = requestAnimationFrame(this._tick);

    const dt = this._lastTime === 0 ? 0.016 : Math.min((time - this._lastTime) / 1000, 0.033);
    this._lastTime = time;

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

    // Render all Jivs in tree order
    this._renderNode(this.Root, w, h, this._dpr);
  };

  private _renderNode = (node: Jiv, w: number, h: number, dpr: number): void => {
    // Render this node if it has any visual presence
    if (node.Width > 0 && node.Height > 0 && node.Style.Visible) {
      this._jivRenderer.Render(node, w, h, dpr);
    }

    // Render children
    for (const child of node.Children) {
      this._renderNode(child, w, h, dpr);
    }
  };

  private _resize = (): void => {
    this._dpr = Math.min(window.devicePixelRatio || 1, 2);
    this._width = this.Element.clientWidth;
    this._height = this.Element.clientHeight;
    this.Element.width = Math.round(this._width * this._dpr);
    this.Element.height = Math.round(this._height * this._dpr);

    // Re-render immediately so the buffer isn't blank between frames
    if (this._running) this._render(0);
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

// Jiv
export type { JivStyle, CornerShape, BlendMode } from '../Jiv/Jiv.Types';

// Layout
export type {
  LayoutMode, FlexDirection, FlexWrap, JustifyContent, AlignItems, AlignContent,
  PositionMode, Overflow, LayoutConfig, ChildLayout, LayoutResult,
  GridConfig, GridTrack,
} from '../Layout/Layout.Types';

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

// Accessibility
export type { AccessibilityConfig } from '../Accessibility/Accessibility.Types';
