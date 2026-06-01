import { Jiv } from '../Jiv/Jiv';
import type { JivStyle } from '../Jiv/Jiv.Types';
import type { LayoutConfig, ChildLayout } from '../Layout/Layout.Types';
import type { TextStyle } from '../Text/Text.Types';
import type { JanvasRenderer } from './Janvas.Renderer';

/**
 * Janvas — a layout-participating Element whose pixels are filled by a
 * foreign WebGL2 renderer (THREE.js, custom shader app, anything) sharing
 * Jaui's GL context.
 *
 * Janvas does not paint a panel of its own. It reserves a rect via the
 * normal layout solver and, once per frame, hands the foreign renderer the
 * GL context with the viewport set to its screen rect. The renderer draws
 * directly into the bound scene framebuffer; subsequent panels render over
 * the top, glass surfaces sample the result as a backdrop — full
 * compositing for free.
 *
 * Bind a renderer via `Renderer = ...`. The renderer's `Init` runs on the
 * first eligible frame; `Render` runs only when `_dirty` is set (push-based
 * via the markDirty callback handed to Init). Calling `MarkDirty()` from
 * the outside also schedules a redraw.
 */
export class Janvas extends Jiv {
  /** The foreign renderer. Null = nothing to draw; the rect stays empty. */
  Renderer: JanvasRenderer | null = null;

  /** Set true on construction and on every external `MarkDirty()` call;
   *  cleared after the renderer's `Render` runs. The frame loop skips
   *  `Render` when this is false — a static scene costs zero extra GPU. */
  private _dirty: boolean = true;

  /** True once `Renderer.Init` has been called. */
  private _inited: boolean = false;

  constructor(options?: {
    Style?: Partial<JivStyle>;
    Layout?: Partial<LayoutConfig>;
    ChildLayout?: Partial<ChildLayout>;
    TextStyle?: Partial<TextStyle>;
  }) {
    // Janvas extends Jiv so it slots into the panel walker without
    // special-casing — its own panel stays transparent (Jiv's default
    // Background is already rgba(0,0,0,0)) so the foreign renderer's
    // pixels show through. Callers can still pass a Style override if
    // they want a tint or border on top.
    super(options);
  }

  /** Schedules a `Render` on the next frame loop. Renderers usually call
   *  this via the closure handed to `Init`; external code can call it too
   *  (e.g., when a model the renderer reads from changes). */
  MarkDirty = (): void => {
    this._dirty = true;
  };

  /** Internal — used by Jaui's frame loop. Returns true if the renderer
   *  needs to draw this frame. */
  IsDirty(): boolean { return this._dirty; }

  /** Internal — clears the dirty flag after a successful Render. */
  ClearDirty(): void { this._dirty = false; }

  /** Internal — true once Init has been called for this renderer. */
  IsInited(): boolean { return this._inited; }

  /** Internal — marks the renderer as initialised. */
  MarkInited(): void { this._inited = true; }
}
