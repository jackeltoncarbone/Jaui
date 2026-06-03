import * as THREE from 'three';
import { Janvas } from '../Janvas/Janvas';
import type { JivStyle } from '../Jiv/Jiv.Types';
import type { LayoutConfig, ChildLayout } from '../Layout/Layout.Types';
import type { JanvasRenderer, JanvasContext, JanvasRect } from '../Janvas/Janvas.Renderer';

/**
 * Model3D — 3D content as a first-class Jiv. "In this Jiv, put a model."
 *
 * A Janvas with a BUILT-IN renderer that loads/holds a model, frames it to ITS
 * OWN rect (centered, scaled to fit), lights it with a sensible 3-point rig, and
 * plays glTF animations. Declarative — no subsystem boilerplate, no per-page
 * pointer wiring. Nests anywhere a Jiv can (card, tile, hero, sheet).
 *
 *   new Model3D({ Object: someThreeObject, ChildLayout: { FlexGrow: 1 } })
 *   new Model3D({ Src: 'uniform.glb' })            // glTF (loader injected)
 *
 * Framing is per-rect: two Model3Ds on one page each frame independently.
 * Idle is cheap — a static model marks dirty once. AutoSpin / external rotation
 * (set via RotationView) tick only while active.
 *
 * No external-CDN dependency is required: pass a `THREE.Object3D` directly for
 * bundled/procedural content. `Src` is optional and needs a loader supplied via
 * `Loader` (keeps three's GLTFLoader out of the core dependency graph).
 */
export interface Model3DOptions {
  /** A ready THREE.Object3D to display (procedural / bundled). Preferred for
   *  core UI — no network, can't blank the frame on a failed fetch. */
  Object?: THREE.Object3D;
  /** glTF/glb URL. Requires `Loader` (e.g. a GLTFLoader instance) — the core
   *  lib does not bundle three's example loaders. */
  Src?: string;
  /** Loader with a `.load(url, onLoad, onProgress, onError)` signature
   *  (THREE.GLTFLoader-compatible). Only needed with `Src`. */
  Loader?: { load: (url: string, onLoad: (gltf: { scene: THREE.Object3D; animations?: THREE.AnimationClip[] }) => void, onProgress?: unknown, onError?: (e: unknown) => void) => void };
  /** Fraction of the smaller rect dimension the model fits into. Default 0.8. */
  Fit?: number;
  /** Provide your own lights instead of the built-in 3-point rig. */
  Lights?: THREE.Light[];
  /** Optional scene backdrop `[r,g,b]` (0..1). Sets the shared scene background
   *  so the see-through stage reads as a surface, not pure black, framing the
   *  model. (The Jaui scene otherwise clears to black.) */
  Background?: [number, number, number];
  Style?: Partial<JivStyle>;
  Layout?: Partial<LayoutConfig>;
  ChildLayout?: Partial<ChildLayout>;
}

class Model3DRenderer implements JanvasRenderer {
  private _root = new THREE.Group();
  /** Public pivot — RotationView (or any wrapper) sets `.rotation` on this. */
  readonly Pivot = new THREE.Group();
  private _markDirty: () => void = () => {};
  private _mixer: THREE.AnimationMixer | null = null;
  private _clock = 0;
  private _animating = false;     // true while a clip plays or a wrapper spins
  private readonly _opts: Model3DOptions;

  constructor(opts: Model3DOptions) { this._opts = opts; }

  Attach(ctx: JanvasContext): void {
    this._markDirty = ctx.MarkDirty;
    // Our world is y-DOWN (projection Y-flipped); flip the pivot so models that
    // author +Y-up stand upright on screen.
    this.Pivot.scale.set(1, -1, 1);
    this._root.add(this.Pivot);
    ctx.World.add(this._root);

    if (this._opts.Background) {
      const [r, gg, bb] = this._opts.Background;
      ctx.Scene.background = new THREE.Color(r, gg, bb);
    }

    const lights = this._opts.Lights ?? this._defaultRig();
    for (const l of lights) this._root.add(l);

    if (this._opts.Object) {
      this._mount(this._opts.Object);
    } else if (this._opts.Src && this._opts.Loader) {
      this._opts.Loader.load(this._opts.Src, (gltf) => {
        this._mount(gltf.scene);
        if (gltf.animations && gltf.animations.length) {
          this._mixer = new THREE.AnimationMixer(gltf.scene);
          this._mixer.clipAction(gltf.animations[0]).play();
          this._animating = true;
        }
        this._markDirty();
      }, undefined, (e) => console.error('[Model3D] load failed:', e));
    }
  }

  /** Normalize: center on origin, scale so max dimension = 1 unit. The per-frame
   *  rect fit then scales the whole root to the Jiv rect. */
  private _mount(obj: THREE.Object3D): void {
    const box = new THREE.Box3().setFromObject(obj);
    obj.position.sub(box.getCenter(new THREE.Vector3()));
    const sz = box.getSize(new THREE.Vector3());
    obj.scale.setScalar(1 / (Math.max(sz.x, sz.y, sz.z) || 1));
    this.Pivot.add(obj);
    this._markDirty();
  }

  private _defaultRig(): THREE.Light[] {
    // Bright, frontal 3-point rig so any dropped-in model reads well by default
    // (a front key matters most — side-only keys rake edge-on and look dim).
    const amb = new THREE.AmbientLight(0xffffff, 1.0);
    const front = new THREE.DirectionalLight(0xffffff, 2.2); front.position.set(0.2, -0.3, 1);   // toward viewer
    const key = new THREE.DirectionalLight(0xfff3e6, 2.0); key.position.set(-0.6, -1, 0.5);
    const fill = new THREE.DirectionalLight(0xbcd0ff, 1.2); fill.position.set(0.8, 0.4, 0.6);
    return [amb, front, key, fill];
  }

  /** Wrappers (RotationView) call this to spin the model and request frames. */
  SetRotation(pitch: number, yaw: number): void {
    this.Pivot.rotation.set(pitch, yaw, 0);
    this._markDirty();
  }
  SetAnimating(on: boolean): void { this._animating = on; }
  /** Per-frame callback (dt seconds) a wrapper registers to integrate idle spin
   *  / inertia — driven by the renderer's own Update so no external frame loop
   *  is needed. */
  OnTick: ((dt: number) => void) | null = null;

  Update(rect: JanvasRect, dt: number): void {
    if (this.OnTick) this.OnTick(dt);
    if (rect.Width <= 0 || rect.Height <= 0 || !Number.isFinite(rect.X) || !Number.isFinite(rect.Y)) return;
    // FRAME TO THIS RECT (origin at rect center, scale to fit). Per-rect framing
    // is the whole point: each Model3D sits correctly in its own Jiv.
    this._root.position.set(rect.X + rect.Width / 2, rect.Y + rect.Height / 2, 0);
    const fit = this._opts.Fit ?? 0.8;
    this._root.scale.setScalar(Math.min(rect.Width, rect.Height) * fit);
    if (this._mixer) this._mixer.update(dt);
    this._clock += dt;
    if (this._animating || this._mixer) this._markDirty();
  }

  Detach(): void { this._root.parent?.remove(this._root); this._mixer?.stopAllAction(); }
}

export class Model3D extends Janvas {
  /** The internal renderer — exposed so wrappers (RotationView) can drive
   *  rotation / animation without reaching through the Janvas. */
  readonly Model: {
    SetRotation(p: number, y: number): void;
    SetAnimating(on: boolean): void;
    OnTick: ((dt: number) => void) | null;
  };

  constructor(opts: Model3DOptions) {
    super({ Style: opts.Style, Layout: opts.Layout, ChildLayout: opts.ChildLayout });
    const r = new Model3DRenderer(opts);
    this.Renderer = r;
    this.Model = r;
  }
}
