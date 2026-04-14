/**
 * Jwift — Canvas-based UI rendering engine.
 * Entry point. Creates a WebGL2 context and runs the render loop.
 */

import { JivAnimator } from '../Jiv/Jiv.Animator';
import { AnimationManager } from '../Animation/Animation.Manager';
import { SolveLayout } from '../Layout/Layout.Solver';
import { ComputeIntrinsicSizes } from '../Layout/Layout.Intrinsic';
import { TextCache } from '../Text/Text.Cache';
import { TextRenderer } from '../Text/Text.Renderer';
import { MeasureText } from '../Text/Text.Measure';
import { TextAnimator } from '../Text/Text.Animator';
// Single unified Jiv renderer. Every Jiv flows through here regardless of Material.
// Material controls whether the backdrop is sampled + graded; "Glass" is just a
// styling preset (LiquidGlass, SolidGlass) — never a special code path.
import { JivRenderer } from '../Jiv/Jiv.Renderer';
import { Framebuffer } from './Framebuffer';
import { BlitRenderer } from './Blit';
import { BlurPass } from './BlurPass';
import { DirtyFlag } from './Types';
import { Jiv } from '../Jiv/Jiv';
import { ScrollManager } from '../Scroll/Scroll.Manager';

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
  private _panelRenderer!: JivRenderer;
  private _textRenderer!: TextRenderer;
  private _textCache!: TextCache;
  private _sceneFbo!: Framebuffer;
  private _blit!: BlitRenderer;
  private _blur!: BlurPass;
  private _animationManager = new AnimationManager();
  private _animators = new Map<Jiv, JivAnimator>();
  private _textAnimators = new Map<Jiv, TextAnimator>();
  private _scrollManager!: ScrollManager;
  /** Largest FrostBlur of any glass collected this frame (CSS px). Drives the dual-filter pyramid. */
  private _maxFrostBlur: number = 0;

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

    this._panelRenderer = new JivRenderer(gl);
    this._textRenderer = new TextRenderer(gl);
    this._textCache = new TextCache(gl);
    this._sceneFbo = new Framebuffer(gl);
    this._blit = new BlitRenderer(gl);
    this._blur = new BlurPass(gl);

    // Animation manager triggers re-render when springs step
    this._animationManager.OnFrame(() => this.RequestFrame());

    // Scroll manager is itself an Animatable — registers with the animation manager
    this._scrollManager = new ScrollManager(this.Root);
    this._animationManager.Register(this._scrollManager);

    this._resize();
    this._observeResize();
    this._watchDpr();
    this._listenForScroll();
    // NOTE: pointer-driven specular tilt is intentionally NOT wired. It felt
    // like a "glow follows cursor" gimmick — the wrong abstraction for the
    // Jiv material. Real gyro input (DeviceOrientation) will drive this on
    // mobile; any "cursor highlight" effect belongs in a separate composited
    // overlay layer, not baked into the core material.
    //   this._listenForSpecularTilt();
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

    // The scene FBO captures the "background" that Liquid Glass panels refract
    // through. One Jiv renderer handles ALL panels — Material='None' branches
    // skip the backdrop sample in the shader.
    this._sceneFbo.Resize(w, h);

    // ─── Pass 1: non-glass panels + text into sceneFbo ───
    this._sceneFbo.Bind();
    gl.viewport(0, 0, w, h);
    gl.clearColor(0.04, 0.04, 0.04, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    this._panelRenderer.BeginFrame();
    this._collectNonGlass(this.Root);
    // null backdrop — we're writing INTO sceneFbo; feedback loop if we also sample it.
    this._panelRenderer.DrawAll(w, h, null);

    this._textCache.BeginFrame();
    this._textRenderer.BeginFrame();
    this._collectTextInstancesForNonGlass(this.Root);
    this._textRenderer.DrawAll(w, h);

    // ─── Pass 2: blur sceneFbo with a Dual Filter pyramid ───
    // Dual Filtering (Bjørge 2015) — downsample/upsample chain that gives
    // Gaussian-equivalent blur in O(log N) sample count and never bands the way
    // a single 5-tap pass does at large radii. Blur radius driven by the max
    // FrostBlur (CSS px) of any glass on screen — one shared blurred FBO is
    // sampled by all glass instances. Scan first, then blur.
    this._maxFrostBlur = 0;
    this._scanFrostBlur(this.Root);
    const blurCssPx = Math.max(1, this._maxFrostBlur);
    const blurredScene = this._blur.Blur(this._sceneFbo.Texture, w, h, blurCssPx * this._dpr);
    // Mipmap the BLURRED FBO so the glass shader can sample at higher LODs near
    // the rim — gives Apple's signature "blur stronger at the edge" behavior.
    this._blur.GenerateOutputMipmap();
    // Also keep the unblurred scene mipmap'd for rim backdrop samples that want
    // crisp-ish color pickup (edge lighting uses LOD 0.5 for a light touch of blur).
    this._sceneFbo.GenerateMipmap();

    // ─── Pass 3: blit sceneFbo (UNBLURRED) to screen as base ───
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    this._blit.Draw(this._sceneFbo.Texture);

    // ─── Pass 4: glass panels — sample the BLURRED backdrop for soft refraction ───
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    this._panelRenderer.BeginFrame();
    this._collectGlass(this.Root);
    this._panelRenderer.DrawAll(w, h, blurredScene);

    // ─── Pass 5: non-glass descendants of glass nodes, on top of the glass ───
    this._panelRenderer.BeginFrame();
    this._collectNonGlassUnderGlass(this.Root);
    this._panelRenderer.DrawAll(w, h, blurredScene);

    // ─── Pass 6: text belonging to glass subtree, on top of everything ───
    this._textRenderer.BeginFrame();
    this._collectTextInstancesForGlass(this.Root);
    this._textRenderer.DrawAll(w, h);
  };

  private _collectNonGlass = (node: Jiv, offsetX: number = 0, offsetY: number = 0): void => {
    if (node.Width > 0 && node.Height > 0 && node.Style.Visible
        && node.Style.Material === 'None' && !this._hasGlassAncestor(node)) {
      this._panelRenderer.AddInstance(node, this._dpr, offsetX, offsetY);
    }
    const [dx, dy] = this._descendOffset(node, offsetX, offsetY);
    for (const child of node.Children) this._collectNonGlass(child, dx, dy);
  };

  private _collectGlass = (node: Jiv, offsetX: number = 0, offsetY: number = 0): void => {
    if (node.Width > 0 && node.Height > 0 && node.Style.Visible && node.Style.Material !== 'None') {
      this._panelRenderer.AddInstance(node, this._dpr, offsetX, offsetY);
    }
    const [dx, dy] = this._descendOffset(node, offsetX, offsetY);
    for (const child of node.Children) this._collectGlass(child, dx, dy);
  };

  /** Compute the offset descendants see when descending past a scroll container. */
  private _descendOffset = (node: Jiv, offsetX: number, offsetY: number): [number, number] => {
    if (node.Style.Overflow === 'Scroll') {
      return [offsetX - node.ScrollX, offsetY - node.ScrollY];
    }
    return [offsetX, offsetY];
  };

  /** Walk the tree before the blur pass to find the largest FrostBlur (CSS px). */
  private _scanFrostBlur = (node: Jiv): void => {
    if (node.Width > 0 && node.Height > 0 && node.Style.Visible
        && node.Style.Material === 'LiquidGlass'
        && node.Style.BackdropFrostBlur > this._maxFrostBlur) {
      this._maxFrostBlur = node.Style.BackdropFrostBlur;
    }
    for (const child of node.Children) this._scanFrostBlur(child);
  };

  /** Non-glass panels that live inside a glass subtree — rendered on top of the glass pass. */
  private _collectNonGlassUnderGlass = (node: Jiv, offsetX: number = 0, offsetY: number = 0): void => {
    if (node.Width > 0 && node.Height > 0 && node.Style.Visible
        && node.Style.Material === 'None' && this._isUnderGlass(node) && node !== this.Root) {
      if (this._hasGlassAncestor(node)) {
        this._panelRenderer.AddInstance(node, this._dpr, offsetX, offsetY);
      }
    }
    const [dx, dy] = this._descendOffset(node, offsetX, offsetY);
    for (const child of node.Children) this._collectNonGlassUnderGlass(child, dx, dy);
  };

  /** True if any STRICT ancestor of node has Material != 'None'. */
  private _hasGlassAncestor = (node: Jiv): boolean => {
    let p = node.Parent;
    while (p) {
      if (p.Style.Material !== 'None') return true;
      p = p.Parent;
    }
    return false;
  };

  /** True if node itself or any ancestor is glass — text inside glass renders in pass 5. */
  private _isUnderGlass = (node: Jiv): boolean => {
    let cur: Jiv | null = node;
    while (cur) {
      if (cur.Style.Material !== 'None') return true;
      cur = cur.Parent;
    }
    return false;
  };

  private _collectTextInstancesForNonGlass = (node: Jiv, offsetX: number = 0, offsetY: number = 0): void => {
    if (!this._isUnderGlass(node)) this._emitTextFor(node, offsetX, offsetY);
    const [dx, dy] = this._descendOffset(node, offsetX, offsetY);
    for (const child of node.Children) this._collectTextInstancesForNonGlass(child, dx, dy);
  };

  private _collectTextInstancesForGlass = (node: Jiv, offsetX: number = 0, offsetY: number = 0): void => {
    if (this._isUnderGlass(node)) this._emitTextFor(node, offsetX, offsetY);
    const [dx, dy] = this._descendOffset(node, offsetX, offsetY);
    for (const child of node.Children) this._collectTextInstancesForGlass(child, dx, dy);
  };

  private _emitTextFor = (node: Jiv, offsetX: number = 0, offsetY: number = 0): void => {
    if (node.Width <= 0 || node.Height <= 0 || !node.Style.Visible) return;
    const anim = this._textAnimators.get(node);
    if (!anim || anim.Words.length === 0) return;

    const padding = node.Layout.Padding;
    const contentX = node.X + offsetX + padding[3];
    const contentY = node.Y + offsetY + padding[0];
    const contentH = node.Height - padding[0] - padding[2];

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
        // First layout for this Jiv — synthesize animator, snap to the solved
        // target immediately (no spring-in from 0,0). Subsequent layouts will
        // spring normally via SetTargets. An explicit entry animation (enter
        // opacity/scale), when we add it, plugs in here with a different
        // initial spring state + separate entry targets.
        animator = new JivAnimator(node);
        animator.SetTargets({
          X: result.X,
          Y: result.Y,
          Width: result.Width,
          Height: result.Height,
        });
        animator.SnapToTargets();
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

  /** Pointer tracking → specular tilt. Simulates Apple's gyro-driven catchlight:
   *  as the user moves the cursor, the specular highlight slides across the
   *  rim. `SpecularTilt` is only applied to specular math (Blinn-Phong catchlight
   *  + rim-spec highlight) — not to ambient, edge light, or border directionality,
   *  which stay anchored to the stylesheet-set `LightAngle`. */
  // @ts-expect-error — retained for future mobile gyro wiring; see constructor note
  private _listenForSpecularTilt = (): void => {
    const updateFromEvent = (clientX: number, clientY: number): void => {
      const r = this.Element.getBoundingClientRect();
      // Map pointer to [-1, +1] relative to canvas center, then scale to a
      // modest tilt magnitude (Apple's gyro tilt rarely exceeds ~30°, which
      // in light-direction space is about 0.5 unit). Clamp to ±0.5.
      const tx = ((clientX - r.left) / Math.max(r.width, 1) - 0.5) * 2;
      const ty = ((clientY - r.top) / Math.max(r.height, 1) - 0.5) * 2;
      this._panelRenderer.SpecularTiltX = Math.max(-0.5, Math.min(0.5, tx * 0.5));
      // Y note: screen Y grows downward, but LightAngle's y convention has
      // "up" as negative in screen space (matches the instance buffer's
      // `lightY = -sin(rad)`). So mouse moving DOWN should shift the
      // specular origin DOWN in the light source, i.e. tilt.y positive.
      this._panelRenderer.SpecularTiltY = Math.max(-0.5, Math.min(0.5, ty * 0.5));
      this.RequestFrame();
    };

    this.Element.addEventListener('pointermove', (e: PointerEvent) => {
      updateFromEvent(e.clientX, e.clientY);
    }, { passive: true });

    this.Element.addEventListener('pointerleave', () => {
      this._panelRenderer.SpecularTiltX = 0;
      this._panelRenderer.SpecularTiltY = 0;
      this.RequestFrame();
    }, { passive: true });
  };

  /** Wheel + touch/pointer drag — both route through ScrollManager which
   *  handles physics (momentum, rubber-band for drag). Wheel clamps; drag
   *  rubber-bands past bounds. */
  private _listenForScroll = (): void => {
    // ─── Wheel ───
    this.Element.addEventListener('wheel', (e: WheelEvent) => {
      this._measureScrollContents(this.Root);

      const rect = this.Element.getBoundingClientRect();
      const cssX = e.clientX - rect.left;
      const cssY = e.clientY - rect.top;
      const target = this._scrollManager.ResolveScrollTarget(cssX, cssY);
      if (!target) return;

      let dx = e.deltaX, dy = e.deltaY;
      if (e.deltaMode === 1) { dx *= 16; dy *= 16; }
      else if (e.deltaMode === 2) { dx *= target.Width; dy *= target.Height; }

      this._scrollManager.ApplyDelta(target, dx, dy);
      this._animationManager.Kick();
      e.preventDefault();
    }, { passive: false });

    // ─── Pointer drag (touch + trackpad + mouse) ───
    // Only consume drag for touch/pen; mouse drag stays available for selection
    // once we have selection. Track per pointer id so multi-touch doesn't collide.
    interface DragCtx { target: Jiv; lastX: number; lastY: number; lastT: number; }
    const drags = new Map<number, DragCtx>();

    this.Element.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return; // reserve mouse-drag for future selection

      this._measureScrollContents(this.Root);
      const rect = this.Element.getBoundingClientRect();
      const cssX = e.clientX - rect.left;
      const cssY = e.clientY - rect.top;
      const target = this._scrollManager.ResolveScrollTarget(cssX, cssY);
      if (!target) return;

      this.Element.setPointerCapture(e.pointerId);
      this._scrollManager.DragStart(target);
      drags.set(e.pointerId, { target, lastX: e.clientX, lastY: e.clientY, lastT: performance.now() });
    });

    this.Element.addEventListener('pointermove', (e: PointerEvent) => {
      const ctx = drags.get(e.pointerId);
      if (!ctx) return;
      const now = performance.now();
      const dt = Math.max(1e-3, (now - ctx.lastT) / 1000);
      // Dragging pulls content the opposite direction of finger motion (finger
      // moves up → content scrolls down, same as native).
      const dx = -(e.clientX - ctx.lastX);
      const dy = -(e.clientY - ctx.lastY);
      this._scrollManager.DragMove(ctx.target, dx, dy, dt);
      this._animationManager.Kick();
      ctx.lastX = e.clientX;
      ctx.lastY = e.clientY;
      ctx.lastT = now;
      e.preventDefault();
    }, { passive: false });

    const finish = (e: PointerEvent): void => {
      const ctx = drags.get(e.pointerId);
      if (!ctx) return;
      this._scrollManager.DragEnd(ctx.target);
      this._animationManager.Kick();
      drags.delete(e.pointerId);
      if (this.Element.hasPointerCapture(e.pointerId)) {
        this.Element.releasePointerCapture(e.pointerId);
      }
    };
    this.Element.addEventListener('pointerup', finish);
    this.Element.addEventListener('pointercancel', finish);
  };

  /** Walk the tree, compute ContentWidth/Height for each Overflow:Scroll Jiv from
   *  the bounding box of its children. Cheap; needed for clamping scroll target. */
  private _measureScrollContents = (node: Jiv): void => {
    if (node.Style.Overflow === 'Scroll') {
      let maxRight = 0;
      let maxBottom = 0;
      for (const c of node.Children) {
        // Only Flow children contribute to scroll content size.
        // Placed/Fixed/Sticky are out-of-flow and don't extend the scroll bounds.
        if (c.ChildLayout.Position !== 'Flow' && c.ChildLayout.Position !== 'Offset') continue;
        const right = (c.X - node.X) + c.Width;
        const bottom = (c.Y - node.Y) + c.Height;
        if (right > maxRight) maxRight = right;
        if (bottom > maxBottom) maxBottom = bottom;
      }
      // Add bottom padding so last item doesn't sit flush against the edge
      const pad = node.Layout.Padding;
      node.ContentWidth = maxRight + pad[1];
      node.ContentHeight = maxBottom + pad[2];
    }
    for (const c of node.Children) this._measureScrollContents(c);
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
export type { JivStyle, CornerShape, BlendMode, MaterialType } from '../Jiv/Jiv.Types';

// Glass presets
export { LiquidGlass, SolidGlass, ClearGlass } from '../Glass/Glass.Presets';

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
