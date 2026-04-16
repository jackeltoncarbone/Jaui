/**
 * Jwift — Canvas-based UI rendering engine.
 * Entry point. Creates a WebGL2 context and runs the render loop.
 */

import { JivAnimator } from '../Jiv/Jiv.Animator';
import { JivStyleAnimator } from '../Jiv/Jiv.StyleAnimator';
import { AnimationManager } from '../Animation/Animation.Manager';
import { SolveLayout } from '../Layout/Layout.Solver';
import { ComputeIntrinsicSizes, CascadePointScale } from '../Layout/Layout.Intrinsic';
import { TextCache } from '../Text/Text.Cache';
import { MeasureText } from '../Text/Text.Measure';
import { TextAnimator } from '../Text/Text.Animator';
import { ResolveTextStyle } from '../Text/Text.Types';
import { ResolveLengthTuple4 } from '../Core/Length.Tuple';
import { JivInstanceBuffer, JIV_FLOATS_PER_INSTANCE } from '../Jiv/Jiv.InstanceBuffer';
import { TextInstanceBuffer, TEXT_FLOATS_PER_INSTANCE } from '../Text/Text.InstanceBuffer';
import type { Renderer, GpuTextureHandle } from './Renderer';
import { WebGPURenderer } from './WebGPU.Renderer';
import { WebGL2Renderer } from './WebGL2.Renderer';
import type { MaterialType } from '../Jiv/Jiv.Types';

/** True for glass panel materials (LiquidGlass, SolidGlass). Other non-None
 *  materials like ProgressiveBlur are compositing overlays — they don't have
 *  a backdrop sample, border, or specular, and they render in their own pass. */
const _isGlass = (m: MaterialType): boolean => m === 'LiquidGlass';
import { DirtyFlag } from './Types';
import { Element as JwiftElement } from '../Element/Element';
import { Jiv } from '../Jiv/Jiv';
import { ScrollManager } from '../Scroll/Scroll.Manager';
import { SelectionManager } from '../Selection/Selection.Manager';

export class Canvas {
  readonly Element: HTMLCanvasElement;
  readonly Root: Jiv;

  private _renderer!: Renderer;
  private _width: number = 0;
  private _height: number = 0;
  private _dpr: number = 1;
  private _running: boolean = false;
  private _frameId: number = 0;
  private _lastTime: number = 0;
  private _panelBuffer = new JivInstanceBuffer();
  private _textBuffer = new TextInstanceBuffer();
  private _textCache!: TextCache;
  /** Specular tilt offset — added to lightDir for specular computations only. */
  private _specTiltX: number = 0;
  private _specTiltY: number = 0;
  private _animationManager = new AnimationManager();
  private _animators = new Map<JwiftElement, JivAnimator>();
  private _styleAnimators = new Map<Jiv, JivStyleAnimator>();
  private _textAnimators = new Map<JwiftElement, TextAnimator>();
  private _scrollManager!: ScrollManager;
  private _selectionManager!: SelectionManager;
  private _maxFrostBlur: number = 0;

  // ─── Debug HUD ───
  private _dprOverride: number | null = null;
  private _debugHud: HTMLDivElement | null = null;
  private _hudDeltas: Float32Array = new Float32Array(30);
  private _hudIdx: number = 0;
  private _hudCount: number = 0;
  private _hudLastWrite: number = 0;

  /** Async factory — tries WebGPU first, falls back to WebGL2 automatically. */
  static Create = async (canvas: HTMLCanvasElement): Promise<Canvas> => {
    let renderer: Renderer;

    // Try WebGPU first — better performance on capable hardware
    if (typeof navigator !== 'undefined' && navigator.gpu) {
      try {
        const webgpu = new WebGPURenderer();
        await webgpu.Init(canvas);
        renderer = webgpu;
        console.log('[Jwift] Using WebGPU renderer');
      } catch (e) {
        console.warn('[Jwift] WebGPU failed, falling back to WebGL2:', (e as Error).message);
        const webgl2 = new WebGL2Renderer();
        await webgl2.Init(canvas);
        renderer = webgl2;
        console.log('[Jwift] Using WebGL2 renderer');
      }
    } else {
      const webgl2 = new WebGL2Renderer();
      await webgl2.Init(canvas);
      renderer = webgl2;
      console.log('[Jwift] Using WebGL2 renderer (WebGPU not available)');
    }

    return new Canvas(canvas, renderer);
  };

  /** Synchronous constructor — always uses WebGL2. For WebGPU with automatic
   *  fallback, use the async `Canvas.Create()` factory instead. */
  constructor(canvas: HTMLCanvasElement, renderer?: Renderer) {
    if (!renderer) {
      const webgl2 = new WebGL2Renderer();
      // WebGL2 init is synchronous internally — the Promise resolves immediately.
      // We call it here and trust that it completes synchronously for WebGL2.
      // This is safe because WebGL2.Renderer.Init only does synchronous GL calls.
      void webgl2.Init(canvas);
      renderer = webgl2;
    }
    this.Element = canvas;
    this.Root = new Jiv();
    this._renderer = renderer;

    this.Element.style.touchAction = 'none';
    this._initDebugFromUrl();

    this._textCache = new TextCache(renderer);

    this._animationManager.OnFrame(() => this.RequestFrame());
    this._scrollManager = new ScrollManager(this.Root);
    this._animationManager.Register(this._scrollManager);
    this._selectionManager = new SelectionManager(Jiv, (jiv) => this._textAnimators.get(jiv), this._animationManager);

    this._resize();
    this._observeResize();
    this._watchDpr();
    this._listenForScroll();
    this._listenForInteractionStates();
    this._listenForTextSelection();
    this._listenForSelectionKeys();
    void this._listenForSpecularTilt;
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

  /** Viewport passed to layout passes for Length resolution — `vw`/`vh`
   *  resolve against these dims, and `%` on root-level placed children
   *  falls back here when there's no parent rect. */
  private _viewport = (): { Width: number; Height: number } => ({
    Width: this._width,
    Height: this._height,
  });
  get Dpr(): number { return this._dpr; }

  /** Request a re-render. When the loop is running, _tick already renders
   *  every frame — no extra render needed. */
  RequestFrame = (): void => {
  };

  private _tick = (time: number): void => {
    if (!this._running) return;
    this._frameId = requestAnimationFrame(this._tick);

    // Feed the HUD BEFORE we overwrite _lastTime — the HUD uses it to derive
    // the rAF-to-rAF delta (which, on iOS, includes time the main thread spent
    // blocked — a better signal than render-only dt for "is the browser
    // actually waking us at 60Hz?").
    this._updateHud(time);

    const dt = this._lastTime === 0 ? 0.016 : Math.min((time - this._lastTime) / 1000, 0.033);
    this._lastTime = time;

    // Check if layout needs re-solving
    if (this._hasDirtyLayout(this.Root) || this._hasDirtyText(this.Root)) {
      // Cascade PointScale first so _measureDirtyText can resolve FontSize
      // against each Jiv's ResolveCtx before layout sizes are known.
      CascadePointScale(this.Root, this._viewport());
      this._measureDirtyText(this.Root);
      ComputeIntrinsicSizes(this.Root, this._viewport());
      this._solveAndAnimate();
      this._clearDirty(this.Root);
    }

    // Wrap-change detection runs every frame — spring-animated width can cross
    // wrap thresholds continuously, and each crossing should cross-fade.
    this._processTextTransitions(this.Root);

    this._render(dt);
  };

  private _render = (_dt: number): void => {
    const r = this._renderer;
    const w = Math.round(this._width * this._dpr);
    const h = Math.round(this._height * this._dpr);

    r.Resize(w, h, this._dpr);
    r.BeginFrame();

    // ─── Pass 1: non-glass panels + text into scene texture ───
    r.BeginScenePass(0.04, 0.04, 0.04);

    this._panelBuffer.Begin();
    this._collectNonGlass(this.Root);
    r.PanelBeginBatch();
    if (this._panelBuffer.Count > 0) {
      r.PanelAddInstance(this._panelBuffer.Data, 0, this._panelBuffer.Count * JIV_FLOATS_PER_INSTANCE);
    }
    r.PanelDrawBatch(w, h, null, 0, this._specTiltX, this._specTiltY);

    this._textCache.BeginFrame();
    this._textBuffer.Begin();
    this._collectTextInstancesForNonGlass(this.Root);
    r.TextBeginBatch();
    if (this._textBuffer.Count > 0) {
      r.TextAddInstance(this._textBuffer.Data, 0, this._textBuffer.Count * TEXT_FLOATS_PER_INSTANCE);
    }
    const atlas = this._textCache.Atlas;
    if (atlas) r.TextDrawBatch(w, h, atlas);

    r.EndScenePass();

    // ─── Pass 2: blur scene with a compute-shader pyramid ───
    this._maxFrostBlur = 0;
    this._scanFrostBlur(this.Root);
    const baseBlurCssPx = 1;
    const maxFeatherSigma = this._maxProgressiveBlurSigma(this.Root);
    const blurredScene = r.ComputeBlur(r.SceneTexture, w, h, baseBlurCssPx * this._dpr);
    const baseFrostLod = Math.log2(Math.max(1, baseBlurCssPx * this._dpr));
    r.GenerateBlurMipmap();

    // ─── Pass 3: blit scene to screen ───
    r.BindDefaultTarget();
    r.DisableBlend();
    r.Blit(r.SceneTexture);

    // ─── Pass 1.5: progressive blur overlays (drawn to screen, reads from
    // scene texture + blur pyramid — no feedback since we're writing to the
    // default framebuffer, not the scene FBO) ───
    if (maxFeatherSigma > 0) {
      const baseSigmaDevice = baseBlurCssPx * this._dpr;
      const targetSigmaDevice = maxFeatherSigma * this._dpr;
      const maxLod = Math.max(1, Math.log2(Math.max(1, targetSigmaDevice / baseSigmaDevice)));
      r.EnableBlend();
      this._drawProgressiveBlur(this.Root, 0, 0, blurredScene, maxLod);
    }

    // ─── Pass 4: glass panels — sample the blurred backdrop ───
    r.EnableBlend();
    this._panelBuffer.Begin();
    this._collectGlass(this.Root);
    r.PanelBeginBatch();
    if (this._panelBuffer.Count > 0) {
      r.PanelAddInstance(this._panelBuffer.Data, 0, this._panelBuffer.Count * JIV_FLOATS_PER_INSTANCE);
    }
    r.PanelDrawBatch(w, h, blurredScene, baseFrostLod, this._specTiltX, this._specTiltY);

    // ─── Pass 5: non-glass descendants of glass nodes ───
    this._panelBuffer.Begin();
    this._collectNonGlassUnderGlass(this.Root);
    r.PanelBeginBatch();
    if (this._panelBuffer.Count > 0) {
      r.PanelAddInstance(this._panelBuffer.Data, 0, this._panelBuffer.Count * JIV_FLOATS_PER_INSTANCE);
    }
    r.PanelDrawBatch(w, h, blurredScene, baseFrostLod, this._specTiltX, this._specTiltY);

    // ─── Pass 6: text belonging to glass subtree ───
    this._textBuffer.Begin();
    this._collectTextInstancesForGlass(this.Root);
    r.TextBeginBatch();
    if (this._textBuffer.Count > 0) {
      r.TextAddInstance(this._textBuffer.Data, 0, this._textBuffer.Count * TEXT_FLOATS_PER_INSTANCE);
    }
    if (atlas) r.TextDrawBatch(w, h, atlas);

    r.EndFrame();
  };

  private _collectNonGlass = (node: Jiv, offsetX: number = 0, offsetY: number = 0, clip: { x: number; y: number; w: number; h: number } | null = null): void => {
    if (!this._isInsideClip(node, offsetX, offsetY, clip)) return;
    if (node.Width > 0 && node.Height > 0 && node.Visible
        && node.RenderStyle.Material === 'None' && !this._hasGlassAncestor(node)) {
      this._panelBuffer.Push(node, this._dpr, offsetX, offsetY);
    }
    const childClip = this._enterClip(node, offsetX, offsetY, clip);
    const [dx, dy] = this._descendOffset(node, offsetX, offsetY);
    for (const child of node.Children as Jiv[]) this._collectNonGlass(child, dx, dy, childClip);
  };

  private _collectGlass = (node: Jiv, offsetX: number = 0, offsetY: number = 0, clip: { x: number; y: number; w: number; h: number } | null = null): void => {
    if (!this._isInsideClip(node, offsetX, offsetY, clip)) return;
    if (node.Width > 0 && node.Height > 0 && node.Visible && _isGlass(node.RenderStyle.Material)) {
      this._panelBuffer.Push(node, this._dpr, offsetX, offsetY);
    }
    const childClip = this._enterClip(node, offsetX, offsetY, clip);
    const [dx, dy] = this._descendOffset(node, offsetX, offsetY);
    for (const child of node.Children as Jiv[]) this._collectGlass(child, dx, dy, childClip);
  };

  /** Walk the tree to find the max `BackdropFrostBlur` across all visible
   *  ProgressiveBlur Jivs — this is the sigma the shared Gaussian chain's
   *  fully-blurred level will be built at. Returns 0 when there are none
   *  (callers skip the chain rebuild + compositing pass). */
  private _maxProgressiveBlurSigma = (node: Jiv): number => {
    let max = 0;
    if (node.RenderStyle.Material === 'ProgressiveBlur' && node.Visible
        && node.Width > 0 && node.Height > 0) {
      max = node.RenderStyle.BackdropFrostBlur;
    }
    for (const child of node.Children as Jiv[]) {
      const childMax = this._maxProgressiveBlurSigma(child);
      if (childMax > max) max = childMax;
    }
    return max;
  };

  /** Recursive draw for progressive-blur overlays. Unlike glass/text, these
   *  aren't batched — each Jiv does one draw. We descend past scroll
   *  containers the same way the other collect passes do.
   *  @param pyramid  mipmapped blur pyramid texture (shared with glass)
   *  @param maxLod   highest LOD to sample (ramp = 1.0 maps here) */
  private _drawProgressiveBlur = (
    node: Jiv,
    offsetX: number,
    offsetY: number,
    pyramid: GpuTextureHandle,
    maxLod: number,
  ): void => {
    if (node.RenderStyle.Material === 'ProgressiveBlur' && node.Visible) {
      const d = this._dpr;
      this._renderer.DrawProgressiveBlur({
        Rect: {
          X: (node.X + offsetX) * d,
          Y: (node.Y + offsetY) * d,
          W: node.Width * d,
          H: node.Height * d,
        },
        Scene: this._renderer.SceneTexture,
        Pyramid: pyramid,
        MaxLod: maxLod,
        Direction: { ToTop: 0, ToBottom: 1, ToLeft: 2, ToRight: 3 }[node.RenderStyle.ProgressiveBlurDirection] ?? 0,
        Opacity: node.RenderStyle.Opacity,
        Background: node.RenderStyle.Background,
        Grading: {
          Brightness: node.RenderStyle.BackdropBrightness,
          Saturation: node.RenderStyle.BackdropSaturation,
          Contrast: node.RenderStyle.BackdropContrast,
        },
      });
    }
    const [dx, dy] = this._descendOffset(node, offsetX, offsetY);
    for (const child of node.Children as Jiv[]) this._drawProgressiveBlur(child, dx, dy, pyramid, maxLod);
  };

  /** Compute the offset descendants see when descending past a scroll container. */
  private _descendOffset = (node: Jiv, offsetX: number, offsetY: number): [number, number] => {
    if (node.Overflow === 'Scroll') {
      return [offsetX - node.ScrollX, offsetY - node.ScrollY];
    }
    return [offsetX, offsetY];
  };

  /** Check if a node at (offsetX + node.X, offsetY + node.Y) is inside the
   *  current clip rect. Returns true if visible (should render). Null clip
   *  means no clipping (root level). */
  private _isInsideClip = (
    node: Jiv, offsetX: number, offsetY: number,
    clip: { x: number; y: number; w: number; h: number } | null,
  ): boolean => {
    if (!clip) return true;
    const nx = node.X + offsetX;
    const ny = node.Y + offsetY;
    // AABB intersection test — skip if completely outside clip rect
    return nx + node.Width > clip.x && nx < clip.x + clip.w
        && ny + node.Height > clip.y && ny < clip.y + clip.h;
  };

  /** Update clip rect when entering a scroll container. */
  private _enterClip = (
    node: Jiv, offsetX: number, offsetY: number,
    parentClip: { x: number; y: number; w: number; h: number } | null,
  ): { x: number; y: number; w: number; h: number } | null => {
    if (node.Overflow !== 'Scroll') return parentClip;
    const cx = node.X + offsetX;
    const cy = node.Y + offsetY;
    const clip = { x: cx, y: cy, w: node.Width, h: node.Height };
    // Intersect with parent clip
    if (parentClip) {
      const x1 = Math.max(clip.x, parentClip.x);
      const y1 = Math.max(clip.y, parentClip.y);
      const x2 = Math.min(clip.x + clip.w, parentClip.x + parentClip.w);
      const y2 = Math.min(clip.y + clip.h, parentClip.y + parentClip.h);
      clip.x = x1; clip.y = y1;
      clip.w = Math.max(0, x2 - x1);
      clip.h = Math.max(0, y2 - y1);
    }
    return clip;
  };

  /** Walk the tree before the blur pass to find the largest FrostBlur (CSS px).
   *  Reads from RenderStyle (resolved px), not Style (authorable string) so the
   *  blur pass picks the actually-rendered value. */
  private _scanFrostBlur = (node: Jiv): void => {
    if (node.Width > 0 && node.Height > 0 && node.Visible
        && node.RenderStyle.Material === 'LiquidGlass'
        && node.RenderStyle.BackdropFrostBlur > this._maxFrostBlur) {
      this._maxFrostBlur = node.RenderStyle.BackdropFrostBlur;
    }
    for (const child of node.Children as Jiv[]) this._scanFrostBlur(child);
  };

  /** Non-glass panels that live inside a glass subtree — rendered on top of the glass pass. */
  private _collectNonGlassUnderGlass = (node: Jiv, offsetX: number = 0, offsetY: number = 0, clip: { x: number; y: number; w: number; h: number } | null = null): void => {
    if (!this._isInsideClip(node, offsetX, offsetY, clip)) return;
    if (node.Width > 0 && node.Height > 0 && node.Visible
        && node.RenderStyle.Material === 'None' && this._isUnderGlass(node) && node !== this.Root) {
      if (this._hasGlassAncestor(node)) {
        this._panelBuffer.Push(node, this._dpr, offsetX, offsetY);
      }
    }
    const childClip = this._enterClip(node, offsetX, offsetY, clip);
    const [dx, dy] = this._descendOffset(node, offsetX, offsetY);
    for (const child of node.Children as Jiv[]) this._collectNonGlassUnderGlass(child, dx, dy, childClip);
  };

  /** True if any STRICT ancestor of node is a glass panel. ProgressiveBlur
   *  Jivs are NOT glass — they're a compositing overlay — so descendants of
   *  a progressive-blur Jiv shouldn't be re-routed to the over-glass pass. */
  private _hasGlassAncestor = (node: Jiv): boolean => {
    let p = node.Parent as Jiv | null;
    while (p) {
      if (_isGlass(p.RenderStyle.Material)) return true;
      p = p.Parent as Jiv | null;
    }
    return false;
  };

  /** True if node itself or any ancestor is glass — text inside glass renders in pass 5. */
  private _isUnderGlass = (node: Jiv): boolean => {
    let cur: Jiv | null = node;
    while (cur) {
      if (_isGlass(cur.RenderStyle.Material)) return true;
      cur = cur.Parent as Jiv | null;
    }
    return false;
  };

  private _collectTextInstancesForNonGlass = (node: Jiv, offsetX: number = 0, offsetY: number = 0, clip: { x: number; y: number; w: number; h: number } | null = null): void => {
    if (!this._isInsideClip(node, offsetX, offsetY, clip)) return;
    if (!this._isUnderGlass(node)) this._emitTextFor(node, offsetX, offsetY);
    const childClip = this._enterClip(node, offsetX, offsetY, clip);
    const [dx, dy] = this._descendOffset(node, offsetX, offsetY);
    for (const child of node.Children as Jiv[]) this._collectTextInstancesForNonGlass(child, dx, dy, childClip);
  };

  private _collectTextInstancesForGlass = (node: Jiv, offsetX: number = 0, offsetY: number = 0, clip: { x: number; y: number; w: number; h: number } | null = null): void => {
    if (!this._isInsideClip(node, offsetX, offsetY, clip)) return;
    if (this._isUnderGlass(node)) this._emitTextFor(node, offsetX, offsetY);
    const childClip = this._enterClip(node, offsetX, offsetY, clip);
    const [dx, dy] = this._descendOffset(node, offsetX, offsetY);
    for (const child of node.Children as Jiv[]) this._collectTextInstancesForGlass(child, dx, dy, childClip);
  };

  private _emitTextFor = (node: Jiv, offsetX: number = 0, offsetY: number = 0): void => {
    if (node.Width <= 0 || node.Height <= 0 || !node.Visible) return;
    const anim = this._textAnimators.get(node);
    if (!anim || anim.Words.length === 0) return;

    // Padding is a Length — resolve against this Jiv's ctx (populated by
    // the layout pass). ctx always exists post-layout; fall back to the
    // root's ctx if something went sideways to avoid NaN in the render.
    const ctx = node.ResolveCtx ?? this.Root.ResolveCtx!;
    const [padT, , padB, padL] = ResolveLengthTuple4(node.Layout.Padding, ctx, ['H', 'W', 'H', 'W']);
    const contentX = node.X + offsetX + padL;
    const contentY = node.Y + offsetY + padT;
    const contentH = node.Height - padT - padB;

    let totalTextHeight = 0;
    for (const w of anim.Words) {
      const bottom = w.TargetY + w.Height;
      if (bottom > totalTextHeight) totalTextHeight = bottom;
    }
    const yOffset = (contentH - totalTextHeight) / 2;

    for (const w of anim.Words) {
      const opacity = node.RenderStyle.Opacity * w.Opacity.Value;
      if (opacity <= 0.001) continue;
      const entry = this._textCache.Get(w.Content, w.Style, null, this._dpr);
      const wx = contentX + w.SpringX.Value;
      const wy = contentY + yOffset + w.SpringY.Value;
      this._textBuffer.Push({
        X: wx * this._dpr,
        Y: wy * this._dpr,
        Width: entry.Width,
        Height: entry.Height,
        Uv: entry.Uv,
        Opacity: opacity,
      });
    }
  };

  private _processTextTransitions = (node: Jiv): void => {
    const ctx = node.ResolveCtx ?? this.Root.ResolveCtx!;
    const [, padR, , padL] = ResolveLengthTuple4(node.Layout.Padding, ctx, ['H', 'W', 'H', 'W']);
    const contentW = node.Width - padL - padR;
    const maxWidth = contentW > 0 ? contentW : null;
    const resolvedStyle = ResolveTextStyle(node.TextStyle, ctx);

    if (node.Text !== null) {
      let anim = this._textAnimators.get(node);
      if (!anim) {
        anim = new TextAnimator(resolvedStyle);
        this._textAnimators.set(node, anim);
        this._animationManager.Register(anim);
      }
      if (anim.Update(node.Text, resolvedStyle, maxWidth)) {
        this._animationManager.Kick();
      }
    } else {
      const anim = this._textAnimators.get(node);
      if (anim && anim.Content !== '') {
        if (anim.Update('', resolvedStyle, maxWidth)) {
          this._animationManager.Kick();
        }
      }
    }
    for (const child of node.Children as Jiv[]) this._processTextTransitions(child);
  };

  private _hasDirtyText = (node: Jiv): boolean => {
    if (node.Dirty & DirtyFlag.Text) return true;
    for (const child of node.Children as Jiv[]) {
      if (this._hasDirtyText(child)) return true;
    }
    return false;
  };

  private _measureDirtyText = (node: Jiv): void => {
    if (node.Text !== null && (node.Dirty & DirtyFlag.Text || node.TextMeasurement === null)) {
      // Unbounded measurement — intrinsic sizing with padding is handled by ComputeIntrinsicSizes.
      // TextStyle holds Length fields (FontSize, LetterSpacing) — resolve against this Jiv's ctx.
      const ctx = node.ResolveCtx ?? this.Root.ResolveCtx!;
      const resolved = ResolveTextStyle(node.TextStyle, ctx);
      node.TextMeasurement = MeasureText(node.Text, resolved, null);
    } else if (node.Text === null) {
      node.TextMeasurement = null;
      node.IntrinsicWidth = null;
      node.IntrinsicHeight = null;
    }
    for (const child of node.Children as Jiv[]) this._measureDirtyText(child);
  };

  // ─── Layout Integration ───

  private _solveAndAnimate = (): void => {
    // Root fills the canvas
    this.Root.Width = this._width;
    this.Root.Height = this._height;

    const results = SolveLayout(this.Root, this._viewport());

    for (const [node, result] of results) {
      // Skip the root — it doesn't animate to its own position
      if (node === this.Root) continue;

      let animator = this._animators.get(node);
      if (!animator) {
        // First layout — create layout animator, snap to targets (no entry
        // animation). JivAnimator works with any Element (X/Y/W/H springs).
        animator = new JivAnimator(node);
        animator.SetTargets({
          X: result.X, Y: result.Y, Width: result.Width, Height: result.Height,
        });
        animator.SnapToTargets();
        this._animators.set(node, animator);
        this._animationManager.Register(animator);

        // Style animator is Jiv-specific — it springs every animatable
        // JivStyle field toward EffectiveStyle. Only created for Jivs.
        if (node instanceof Jiv) {
          const styleAnim = new JivStyleAnimator(node);
          styleAnim.SnapToTargets();
          this._styleAnimators.set(node, styleAnim);
          this._animationManager.Register(styleAnim);
        }
      } else {
        const needsKick = animator.SetTargets({
          X: result.X, Y: result.Y, Width: result.Width, Height: result.Height,
        });
        if (node.SnapLayout) {
          animator.SnapToTargets();
        } else if (needsKick) {
          this._animationManager.Kick();
        }
      }
    }

    // Clean up animators for removed nodes
    for (const [node, animator] of this._animators) {
      if (!results.has(node)) {
        this._animationManager.Unregister(animator);
        this._animators.delete(node);
      }
    }
    for (const [node, sAnim] of this._styleAnimators) {
      if (!results.has(node)) {
        this._animationManager.Unregister(sAnim);
        this._styleAnimators.delete(node);
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
    for (const child of node.Children as Jiv[]) {
      if (this._hasDirtyLayout(child)) return true;
    }
    return false;
  };

  private _clearDirty = (node: Jiv): void => {
    node.Dirty &= ~(DirtyFlag.Layout | DirtyFlag.Children | DirtyFlag.Text);
    for (const child of node.Children as Jiv[]) this._clearDirty(child);
  };

  private _resize = (): void => {
    // Browser-zoom can push DPR above native (e.g. 125% on a 1.5x display = DPR 1.875).
    // Text cache naturally invalidates — its hash includes DPR — so higher DPR costs
    // memory/fill but keeps strokes crisp on desktop.
    //
    // Touch-primary devices (iPad, iPhone) are usually fragment-bound: an iPad Pro
    // at DPR 2 pushes ~5.6MP/frame, which the dual-filter blur chain can't sustain
    // at 60Hz. Clamp to 2 on those devices to preserve framerate — most iPad users
    // report native DPR 2 anyway, so this is a no-op today but protects against
    // future DPR 3 devices and 125% Safari zoom on DPR 2 displays.
    //
    // `?dpr=N` in the URL overrides both paths, so the user can A/B on device
    // without rebuilding. NaN/≤0 is ignored.
    const raw = window.devicePixelRatio || 1;
    const override = this._dprOverride;
    if (override !== null) {
      this._dpr = override;
    } else {
      const isTouchPrimary = typeof window !== 'undefined' && !!window.matchMedia
        && window.matchMedia('(pointer: coarse)').matches;
      this._dpr = isTouchPrimary ? Math.min(raw, 2) : raw;
    }
    this._width = this.Element.clientWidth;
    this._height = this.Element.clientHeight;
    this.Element.width = Math.round(this._width * this._dpr);
    this.Element.height = Math.round(this._height * this._dpr);

    // Mark root dirty so layout re-solves with new dimensions
    this.Root.Dirty |= DirtyFlag.Layout;

    // Re-render immediately so the buffer isn't blank between frames
    if (this._running) {
      if (this._hasDirtyLayout(this.Root) || this._hasDirtyText(this.Root)) {
        CascadePointScale(this.Root, this._viewport());
        this._measureDirtyText(this.Root);
        ComputeIntrinsicSizes(this.Root, this._viewport());
        this._solveAndAnimate();
        this._clearDirty(this.Root);
      }
      this._processTextTransitions(this.Root);
      this._render(0);
    }
  };

  private _observeResize = (): void => {
    // Defer _resize() to the next animation frame so the ResizeObserver's
    // callback returns synchronously. Running layout changes in-line
    // causes the browser to emit "ResizeObserver loop completed with
    // undelivered notifications" (benign but noisy, and Angular's global
    // error listener amplifies each one into a console error).
    const observer = new ResizeObserver(() => {
      requestAnimationFrame(() => this._resize());
    });
    observer.observe(this.Element);
  };

  /** Pointer tracking → specular tilt. Simulates Apple's gyro-driven catchlight:
   *  as the user moves the cursor, the specular highlight slides across the
   *  rim. `SpecularTilt` is only applied to specular math (Blinn-Phong catchlight
   *  + rim-spec highlight) — not to ambient, edge light, or border directionality,
   *  which stay anchored to the stylesheet-set `LightAngle`. */
  // Retained for future mobile gyro wiring; see constructor note. The
  // `void` reference at the end of the constructor keeps TS happy without
  // a suppression comment until we actually wire it up.
  private _listenForSpecularTilt = (): void => {
    const updateFromEvent = (clientX: number, clientY: number): void => {
      const r = this.Element.getBoundingClientRect();
      // Map pointer to [-1, +1] relative to canvas center, then scale to a
      // modest tilt magnitude (Apple's gyro tilt rarely exceeds ~30°, which
      // in light-direction space is about 0.5 unit). Clamp to ±0.5.
      const tx = ((clientX - r.left) / Math.max(r.width, 1) - 0.5) * 2;
      const ty = ((clientY - r.top) / Math.max(r.height, 1) - 0.5) * 2;
      this._specTiltX = Math.max(-0.5, Math.min(0.5, tx * 0.5));
      // Y note: screen Y grows downward, but LightAngle's y convention has
      // "up" as negative in screen space (matches the instance buffer's
      // `lightY = -sin(rad)`). So mouse moving DOWN should shift the
      // specular origin DOWN in the light source, i.e. tilt.y positive.
      this._specTiltY = Math.max(-0.5, Math.min(0.5, ty * 0.5));
      this.RequestFrame();
    };

    this.Element.addEventListener('pointermove', (e: PointerEvent) => {
      updateFromEvent(e.clientX, e.clientY);
    }, { passive: true });

    this.Element.addEventListener('pointerleave', () => {
      this._specTiltX = 0;
      this._specTiltY = 0;
      this.RequestFrame();
    }, { passive: true });
  };

  /** Pointer → interaction states (Hover / Active). The topmost hit Jiv
   *  becomes Hover:true; everyone else clears. Pointer down/up toggles
   *  Active on the hit target. Focus is keyboard-driven and sits on a
   *  separate system (added with the input focus chain). Disabled is set
   *  declaratively by the caller — we never touch it here.
   *
   *  State changes trigger a re-render via RequestFrame. State mutations
   *  are O(1) per frame per pointer (two pointers = two state flips max). */
  private _hoveredJiv: Jiv | null = null;
  private _activeJiv: Jiv | null = null;

  private _listenForInteractionStates = (): void => {
    const topmostAt = (clientX: number, clientY: number): Jiv | null => {
      const rect = this.Element.getBoundingClientRect();
      return this._scrollManager.HitTopmost(clientX - rect.left, clientY - rect.top);
    };

    this.Element.addEventListener('pointermove', (e: PointerEvent) => {
      const hit = topmostAt(e.clientX, e.clientY);
      if (hit === this._hoveredJiv) return;

      if (this._hoveredJiv) this._hoveredJiv.Hover = false;
      this._hoveredJiv = hit;
      if (hit) hit.Hover = true;
      // Kick the animation loop so style springs wake up and chase the new
      // EffectiveStyle target. Without this, springs that had settled at the
      // old state stay frozen — Jiv appears to "still be hovered."
      this._animationManager.Kick();
    });

    this.Element.addEventListener('pointerleave', () => {
      if (this._hoveredJiv) {
        this._hoveredJiv.Hover = false;
        this._hoveredJiv = null;
        this._animationManager.Kick();
      }
    });

    this.Element.addEventListener('pointerdown', (e: PointerEvent) => {
      const hit = topmostAt(e.clientX, e.clientY);
      if (!hit) return;
      this._activeJiv = hit;
      hit.Active = true;
      this._animationManager.Kick();
    });

    const clearActive = (): void => {
      if (this._activeJiv) {
        this._activeJiv.Active = false;
        this._activeJiv = null;
        this._animationManager.Kick();
      }
    };
    this.Element.addEventListener('pointerup', clearActive);
    this.Element.addEventListener('pointercancel', clearActive);
  };

  /** Mouse-driven text selection. Match web behavior:
   *    • Mousedown ANYWHERE — maps to the nearest text Jiv + word. If the
   *      tree has no text at all, clears selection.
   *    • Drag — extends selection to the nearest word of the anchor Jiv at
   *      the current pointer position (past-bounds points clamp to the
   *      nearest line/word, same as browser selection).
   *    • Double-click — selects the word at the click point.
   *    • Triple-click — selects the whole line.
   *  Mobile (touch): long-press to start selection with handle UI is a
   *  deliberate follow-up — touch is currently reserved for scroll.
   *
   *  Click-count uses a 400 ms window with a < 5 px travel threshold,
   *  matching Chromium's heuristics. The active text Jiv is remembered
   *  across the burst so a triple-click always lands on the same Jiv. */
  private _listenForTextSelection = (): void => {
    let anchorJiv: Jiv | null = null;
    let anchorWord: number = -1;
    /** Granularity of the current drag: 'char' (word-by-word), 'word'
     *  (double-click — extend by whole words), 'line' (triple-click). */
    let granularity: 'char' | 'word' | 'line' = 'char';
    /** Active click-burst state for double/triple detection. */
    let lastClickAt = 0;
    let lastClickX = 0, lastClickY = 0;
    let clickCount = 0;
    let dragging = false;

    const selMgr = this._selectionManager;

    this.Element.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      if (e.button !== 0) return;

      const rect = this.Element.getBoundingClientRect();
      const cssX = e.clientX - rect.left;
      const cssY = e.clientY - rect.top;
      const hit = this._scrollManager.HitTopmost(cssX, cssY);
      const textJiv = selMgr.NearestTextJiv(this.Root, hit, cssX, cssY);

      if (!textJiv || !selMgr.IsSelectable(textJiv)) {
        selMgr.Set(null, this.Root);
        this._animationManager.Kick();
        return;
      }

      const wordIdx = selMgr.WordIndexAt(textJiv, cssX, cssY);
      if (wordIdx === null) return;

      // Click-count detection — must be same Jiv and within the burst window
      const now = performance.now();
      const burstAlive = (now - lastClickAt) < 400
        && Math.hypot(cssX - lastClickX, cssY - lastClickY) < 5;
      clickCount = burstAlive ? clickCount + 1 : 1;
      lastClickAt = now;
      lastClickX = cssX;
      lastClickY = cssY;

      anchorJiv = textJiv;
      anchorWord = wordIdx;
      dragging = true;

      if (clickCount >= 3) {
        granularity = 'line';
        const [s, eIdx] = selMgr.LineRangeFor(textJiv, wordIdx);
        selMgr.Set({
          AnchorJiv: textJiv, AnchorWord: s,
          ExtentJiv: textJiv, ExtentWord: eIdx,
        }, this.Root);
      } else {
        granularity = clickCount === 2 ? 'word' : 'char';
        selMgr.Set({
          AnchorJiv: textJiv, AnchorWord: wordIdx,
          ExtentJiv: textJiv, ExtentWord: wordIdx,
        }, this.Root);
      }

      this._animationManager.Kick();
      this.Element.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    this.Element.addEventListener('pointermove', (e: PointerEvent) => {
      if (!dragging || !anchorJiv) return;
      const rect = this.Element.getBoundingClientRect();
      const cssX = e.clientX - rect.left;
      const cssY = e.clientY - rect.top;

      // Re-resolve which text Jiv the cursor is over on every tick — selection
      // flows across Jiv boundaries like web selection. When the pointer is
      // off-canvas or over an unselectable region, NearestTextJiv falls back
      // to the closest text Jiv by rect distance.
      const hit = this._scrollManager.HitTopmost(cssX, cssY);
      const extentJiv = selMgr.NearestTextJiv(this.Root, hit, cssX, cssY) ?? anchorJiv;
      const extentWord = selMgr.WordIndexAt(extentJiv, cssX, cssY);
      if (extentWord === null) return;

      let aJiv = anchorJiv, aWord = anchorWord;
      let eJiv = extentJiv, eWord = extentWord;

      if (granularity === 'line') {
        // Expand each endpoint to cover its whole line. Lines don't cross
        // Jiv boundaries, so we line-expand anchor and extent independently
        // inside their own Jivs. Pick each endpoint's OUTER edge (facing
        // away from the other) so both full lines end up in the range.
        const [as, ae] = selMgr.LineRangeFor(anchorJiv, anchorWord);
        const [es, ee] = selMgr.LineRangeFor(extentJiv, extentWord);
        if (aJiv === eJiv) {
          aWord = Math.min(as, es);
          eWord = Math.max(ae, ee);
        } else {
          const cmp = selMgr.DocOrder(anchorJiv, extentJiv, this.Root);
          if (cmp <= 0) { aWord = as; eWord = ee; }  // anchor is before extent
          else { aWord = ae; eWord = es; }            // anchor is after extent
        }
      }
      // 'word' and 'char' granularities just forward the raw endpoints —
      // words are already our atom, so there's nothing to snap.

      selMgr.Set({
        AnchorJiv: aJiv, AnchorWord: aWord,
        ExtentJiv: eJiv, ExtentWord: eWord,
      }, this.Root);
      this._animationManager.Kick();
    });

    const end = (e: PointerEvent): void => {
      if (e.pointerType !== 'mouse') return;
      dragging = false;
      anchorJiv = null;
      if (this.Element.hasPointerCapture(e.pointerId)) {
        this.Element.releasePointerCapture(e.pointerId);
      }
    };
    this.Element.addEventListener('pointerup', end);
    this.Element.addEventListener('pointercancel', end);
  };

  /** Keyboard shortcuts on the active selection — Cmd/Ctrl+A select-all
   *  within the current text Jiv, Escape clears.
   *
   *  Listens on `window` (canvas isn't focusable by default). We only act
   *  when the active element is the body / canvas — so typing Cmd+A inside
   *  a real <input> on the page still does the native thing. */
  private _listenForSelectionKeys = (): void => {
    const selMgr = this._selectionManager;
    window.addEventListener('keydown', (e: KeyboardEvent) => {
      const ae = document.activeElement;
      const inEditable = ae && (
        ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' ||
        (ae as HTMLElement).isContentEditable
      );
      if (inEditable) return;

      const meta = e.ctrlKey || e.metaKey;
      if (meta && (e.key === 'a' || e.key === 'A')) {
        // Select from the first text Jiv's first word to the last text Jiv's
        // last word — selection is document-wide, not scoped to one Jiv.
        const first = selMgr.FirstTextJiv(this.Root);
        const last = selMgr.LastTextJiv(this.Root);
        if (first && last) {
          const [, lastWord] = selMgr.FullRange(last);
          selMgr.Set({
            AnchorJiv: first, AnchorWord: 0,
            ExtentJiv: last, ExtentWord: lastWord,
          }, this.Root);
          this._animationManager.Kick();
          e.preventDefault();
        }
      } else if (e.key === 'Escape') {
        if (selMgr.Current) {
          selMgr.Set(null, this.Root);
          this._animationManager.Kick();
          e.preventDefault();
        }
      }
    }, { capture: true });
  };

  /** Wheel + touch/pointer drag — both route through ScrollManager which
   *  handles physics (momentum, rubber-band for drag). Wheel clamps; drag
   *  rubber-bands past bounds. */
  private _listenForScroll = (): void => {
    // ─── Wheel ───
    this.Element.addEventListener('wheel', (e: WheelEvent) => {
      // Browser zoom (Ctrl/Cmd + wheel, or pinch-zoom which Chrome delivers
      // as wheel + ctrlKey) is a browser-owned gesture — we must NOT consume
      // it as scroll. Let it bubble to the browser's zoom handler.
      if (e.ctrlKey) return;

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

      // iOS batches pointermove to ~20Hz during touch — renders run at 60Hz
      // but scroll offset was only updating 3x/frame with the raw event.
      // getCoalescedEvents() recovers the missed samples; we feed each one
      // through DragMove so scroll offset tracks the finger at native rate.
      // Fall back to the single event if the browser doesn't support it.
      const samples: readonly PointerEvent[] =
        typeof e.getCoalescedEvents === 'function'
          ? (e.getCoalescedEvents() as PointerEvent[]) : [];
      const events: readonly PointerEvent[] = samples.length > 0 ? samples : [e];

      for (const sample of events) {
        const now = performance.now();
        const dt = Math.max(1e-3, (now - ctx.lastT) / 1000);
        // Dragging pulls content the opposite direction of finger motion (finger
        // moves up → content scrolls down, same as native).
        const dx = -(sample.clientX - ctx.lastX);
        const dy = -(sample.clientY - ctx.lastY);
        this._scrollManager.DragMove(ctx.target, dx, dy, dt);
        ctx.lastX = sample.clientX;
        ctx.lastY = sample.clientY;
        ctx.lastT = now;
      }
      this._animationManager.Kick();
      // No preventDefault — listener is passive. `touch-action: none` on the
      // canvas (set in the constructor) keeps the browser's native scroll
      // from competing, so we don't need to block it imperatively.
    }, { passive: true });

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
    if (node.Overflow === 'Scroll') {
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
      const ctx = node.ResolveCtx ?? this.Root.ResolveCtx!;
      const [, padR, padB] = ResolveLengthTuple4(node.Layout.Padding, ctx, ['H', 'W', 'H', 'W']);
      node.ContentWidth = maxRight + padR;
      node.ContentHeight = maxBottom + padB;
    }
    for (const c of node.Children as Jiv[]) this._measureScrollContents(c);
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

  /** Parse `?debug` / `#debug` and `?dpr=N` from the URL. Calling this early
   *  in the constructor lets `_resize()` pick up the DPR override on its
   *  first run, and attaches the HUD once the canvas is in the DOM. */
  private _initDebugFromUrl = (): void => {
    if (typeof window === 'undefined') return;

    const search = window.location.search || '';
    const hash = window.location.hash || '';
    const params = new URLSearchParams(search);
    const debug = params.has('debug') || hash.includes('debug');

    // `?dpr=N` — explicit user override (clamped to a sane range so a typo
    // doesn't lock the browser with a 50MP backbuffer). null = auto.
    const dprStr = params.get('dpr');
    if (dprStr !== null) {
      const n = Number(dprStr);
      if (Number.isFinite(n) && n > 0 && n <= 4) this._dprOverride = n;
    }

    if (debug) this._enableDebugHud();
  };

  // GL call counting removed — WebGPU uses timestamp queries for profiling.

  /** Build the HUD overlay. Fixed-position, monospace, semi-transparent; pointer-
   *  events disabled so it never intercepts scroll/hover. Appended to body so
   *  it survives canvas re-parenting and doesn't need special CSS from hosts. */
  private _enableDebugHud = (): void => {
    if (this._debugHud || typeof document === 'undefined') return;
    const el = document.createElement('div');
    el.style.cssText = [
      'position:fixed',
      'top:8px',
      'left:8px',
      'z-index:2147483647',
      'padding:4px 8px',
      'background:rgba(0,0,0,0.6)',
      'color:#0f0',
      'font:12px/1.3 ui-monospace,Menlo,Consolas,monospace',
      'pointer-events:none',
      'white-space:pre',
      'border-radius:4px',
    ].join(';');
    el.textContent = 'FPS --';
    const attach = (): void => { document.body.appendChild(el); };
    if (document.body) attach();
    else document.addEventListener('DOMContentLoaded', attach, { once: true });
    this._debugHud = el;
  };

  /** Called from `_tick` with the current rAF timestamp. Writes the delta into
   *  the rolling buffer, then (throttled) updates the HUD textContent. Keeps
   *  the hot path allocation-free — the template literal produces one string
   *  per DOM write, not per frame. */
  private _updateHud = (time: number): void => {
    if (!this._debugHud) return;

    // _lastTime is 0 on the very first frame (set by Start); skip it so we
    // don't feed a huge bogus delta into the window.
    if (this._lastTime === 0) return;
    const dtMs = time - this._lastTime;

    const buf = this._hudDeltas;
    buf[this._hudIdx] = dtMs;
    this._hudIdx = (this._hudIdx + 1) % buf.length;
    if (this._hudCount < buf.length) this._hudCount++;

    // Throttle DOM writes to ~10Hz. Every frame would make the HUD itself
    // a measurable cost on low-power devices.
    if (time - this._hudLastWrite < 100) return;
    this._hudLastWrite = time;

    let sum = 0, min = Infinity, max = 0;
    for (let i = 0; i < this._hudCount; i++) {
      const v = buf[i];
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const avg = sum / Math.max(1, this._hudCount);
    const fps = avg > 0 ? 1000 / avg : 0;
    const w = this._width;
    const h = this._height;
    this._debugHud.textContent =
      `FPS ${fps.toFixed(1)} | ms ${avg.toFixed(1)} (min ${min === Infinity ? 0 : min.toFixed(1)} max ${max.toFixed(1)}) | dpr ${this._dpr} | WxH ${w}x${h} | WebGPU`;
  };
}

// ─── Re-exports by slice ───

export { Jath } from './Jath';
export { Jiv } from '../Jiv/Jiv';

// Core
export type { Vec2, Vec4, Rect, Color, DeviceTier, DirtyFlags } from './Types';
export { DirtyFlag } from './Types';

// Jiv
export type { JivStyle, CornerShape, BlendMode, MaterialType, ProgressiveBlurDirection } from '../Jiv/Jiv.Types';

// Glass presets
export { LiquidGlass, ClearGlass } from '../Glass/Glass.Presets';

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

// JSS
export { ParseJss } from '../Jss/Jss.Parser';
export type { Stylesheet, Ruleset } from '../Jss/Jss.Parser';
export { SlotFor, type Slot } from '../Jss/Jss.Routes';
