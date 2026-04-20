/**
 * JanvasRenderer — interface a foreign renderer (THREE.js, vanilla WebGL,
 * etc.) implements to draw into a Janvas region of Jaui's scene.
 *
 * Lifecycle:
 *   1. `Init(gl, markDirty)` is called once when the Janvas first becomes
 *      visible to the frame loop. The renderer should build any GPU resources
 *      it needs (programs, buffers, textures) using the provided WebGL2
 *      context — that context is shared with Jaui, so anything created here
 *      participates in the same GL device.
 *   2. `Render(gl, width, height, dt)` is called every Jaui frame the renderer
 *      is marked dirty. The viewport and scissor are set by Jaui to the
 *      Janvas's screen rect before the call; the foreign renderer just draws
 *      into the currently bound framebuffer at the origin.
 *   3. `Dispose()` is called when the Janvas leaves the tree.
 *
 * The `markDirty` callback handed to `Init` lets the renderer signal that
 * its internal state changed (camera moved, model updated, animation tick).
 * Jaui only calls `Render` when the dirty flag is set, so a static scene
 * has zero per-frame cost beyond the clear/scissor reset.
 *
 * GL state contract: Jaui save-and-restores the framebuffer binding, viewport,
 * scissor, blend, depth-test, and the four texture-unit-0 bindings around
 * `Render`. The renderer is free to mutate ANY other GL state without
 * disturbing Jaui's pipeline.
 */
export interface JanvasRect {
  /** Janvas region in device pixels, GL viewport conventions:
   *   - X, Y: bottom-left-origin offset into the scene FBO (Y is
   *           `canvasHeight - topLeftY - Height`, ready for
   *           `gl.viewport` / THREE `renderTarget.viewport`).
   *   - Width, Height: size.
   *  The foreign renderer must pass all four to its viewport — passing
   *  `(0, 0, Width, Height)` makes content land at the canvas bottom-left
   *  regardless of where the janvas actually is. */
  X: number;
  Y: number;
  Width: number;
  Height: number;
}

export interface JanvasRenderer {
  Init(gl: WebGL2RenderingContext, markDirty: () => void): void;
  /** @param fbo The framebuffer Jaui wants the renderer to draw into. May
   *             be null = default framebuffer. THREE consumers wrap it via
   *             `WebGLRenderTarget` + `__webglFramebuffer` override.
   *  @param rect Screen rect in device pixels for the janvas region. */
  Render(gl: WebGL2RenderingContext, fbo: WebGLFramebuffer | null, rect: JanvasRect, dt: number): void;
  Dispose?(): void;
}
