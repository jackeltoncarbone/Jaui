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
export interface JanvasRenderer {
  Init(gl: WebGL2RenderingContext, markDirty: () => void): void;
  Render(gl: WebGL2RenderingContext, width: number, height: number, dt: number): void;
  Dispose?(): void;
}
