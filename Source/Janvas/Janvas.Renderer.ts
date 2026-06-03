import type * as THREE from 'three';

/**
 * JanvasRenderer — the contract a self-contained 3D subsystem (reality marchers,
 * field sim, a custom shader app) implements to live inside Jaui's unified
 * Three.js scene.
 *
 * This is the Three-native evolution of the old "foreign WebGL2 renderer draws
 * into our FBO" model (see Documentation/ThreeMigration.md, "one world, two
 * authoring paths"). A subsystem no longer blits into a framebuffer; it **mounts
 * its own `Object3D` subtree** into the shared scene and renders as part of the
 * single unified Three frame — so it shares the camera, depth buffer, and lights
 * with the UI, occluding and being lit alongside it automatically.
 *
 * Lifecycle:
 *   1. `Attach(ctx)` — once, when the Janvas first becomes visible. The subsystem
 *      adds its root Object3D to `ctx.World` (or builds geometry/materials using
 *      `ctx.Renderer`). It gets the raw Three handles — this is the deliberate
 *      escape hatch: build whatever's fastest (InstancedMesh of 200 marchers,
 *      custom ShaderMaterial), at native Three speed, NOT through the JSS path.
 *   2. `Update(rect, dt)` — each frame the Janvas is dirty. The subsystem
 *      positions/sizes its content for the Janvas's current screen rect (device
 *      px, top-left origin) and advances its animation by `dt` seconds. It does
 *      NOT call renderer.render — Jaui renders the whole scene once per frame.
 *   3. `Detach()` — when the Janvas leaves the tree. Remove the subtree, dispose.
 *
 * The `markDirty` callback handed to `Attach` lets the subsystem request a frame
 * (camera moved, model changed, animation tick). Jaui only calls `Update` when
 * the Janvas is dirty, so a static subsystem costs nothing per frame.
 */

/** Janvas screen rect in device pixels, top-left origin. */
export interface JanvasRect {
  X: number;
  Y: number;
  Width: number;
  Height: number;
}

/** Shared-world handles handed to a subsystem at `Attach`. The subsystem mounts
 *  into `World` and may read `Scene`/`Camera`/`Renderer` for advanced use. */
export interface JanvasContext {
  /** The single THREE.Scene. */
  Scene: THREE.Scene;
  /** The world group — mount your subtree here (it inherits the world transform). */
  World: THREE.Group;
  /** The shared perspective camera (read-only; do not reparent or mutate unless
   *  you own the camera for a full-bleed 3D Janvas). */
  Camera: THREE.PerspectiveCamera;
  /** The shared WebGLRenderer — for creating GPU resources (textures, RTs). */
  Renderer: THREE.WebGLRenderer;
  /** Request a redraw. Call when internal state changes between frames. */
  MarkDirty: () => void;
  /** Forward an event to this Janvas's main-side counterpart (worker mode). */
  PostEvent?: (channel: string, payload: unknown, transfer?: Transferable[]) => void;
}

export interface JanvasRenderer {
  /** Mount the subsystem's Object3D subtree into the shared scene. Called once. */
  Attach(ctx: JanvasContext): void;
  /** Position/animate for the current screen rect; advance by `dt` seconds.
   *  Called per dirty frame. Must NOT call renderer.render. */
  Update(rect: JanvasRect, dt: number): void;
  /** Receive a state push from main (or another service) by named channel.
   *  Optional. Channels namespace by intent: 'reality:camera', 'reality:marchers'. */
  Input?(channel: string, payload: unknown): void;
  /** Remove the subtree and dispose GPU resources. */
  Detach?(): void;
}

/** Construction context for a `JanvasRendererFactory`. Lets the factory close
 *  over per-instance plumbing — most importantly `PostEvent`. */
export interface JanvasFactoryContext {
  /** Worker-side Jiv id of the Janvas this renderer is being constructed for. */
  JivId: number;
  /** Forwarder to `WorkerBridge.PostJanvasEvent` with this Janvas's id bound. */
  PostEvent: (channel: string, payload: unknown, transfer?: Transferable[]) => void;
}
