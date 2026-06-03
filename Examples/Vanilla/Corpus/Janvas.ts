// Janvas-native proof: a self-contained Three subsystem (spinning lit cube)
// mounts its own Object3D subtree into Jaui's shared scene via the JanvasRenderer
// Attach/Update contract, then UI panels + glass composite OVER it — proving the
// "one world, two authoring paths" model (see Documentation/ThreeMigration.md).
import * as THREE from 'three';
import { Canvas, Jiv, Janvas, LiquidGlass } from 'jaui';
import type { JanvasRenderer, JanvasContext, JanvasRect } from 'jaui';

class CubeSubsystem implements JanvasRenderer {
  private _root = new THREE.Group();
  private _cube!: THREE.Mesh;
  private _markDirty: () => void = () => {};
  private _spin = 0;

  Attach(ctx: JanvasContext): void {
    this._markDirty = ctx.MarkDirty;
    // Unlit material: this fixture exists to PROVE the Janvas-native path (a
    // subsystem mounts its own Object3D subtree into the shared scene, shares the
    // camera/depth, composites under UI). Lit shading (MeshStandard + lights)
    // interacts with the camera's Y-flip winding + light orientation — real
    // subsystems own that; here unlit keeps the demonstration unambiguous.
    // DoubleSide because the Y-flipped projection reverses content winding.
    this._cube = new THREE.Mesh(
      new THREE.BoxGeometry(120, 120, 120),
      new THREE.MeshBasicMaterial({ color: 0x4fa8ff, side: THREE.DoubleSide }),
    );
    this._root.add(this._cube);
    ctx.World.add(this._root);
  }

  Update(rect: JanvasRect, dt: number): void {
    // Center the cube in the Janvas's screen rect (device-px, top-left origin).
    const cx = rect.X + rect.Width / 2;
    const cy = rect.Y + rect.Height / 2;
    this._cube.position.set(cx, cy, 0);
    this._spin += dt;
    this._cube.rotation.set(this._spin * 0.7, this._spin, 0);
    this._markDirty(); // animating → keep ticking
  }

  Detach(): void {
    this._root.parent?.remove(this._root);
  }
}

export default async function setup(el: HTMLCanvasElement): Promise<void> {
  const canvas = await Canvas.Create(el);

  // NOTE: the screen background is TRANSPARENT — an opaque ancestor panel would
  // paint over the Janvas in the panel pass (the subsystem draws first, into the
  // scene target; opaque panels drawn after would cover it). The Janvas is a
  // see-through hole onto the shared 3D world. Clear color (BeginScenePass) is
  // the backdrop.
  const screen = new Jiv({
    Layout: { Direction: 'Column', Justify: 'Start', Align: 'Stretch' },
    ChildLayout: { FlexGrow: 1 },
  });

  // The Janvas reserves a rect; the cube subsystem fills it as real 3D content.
  const janvas = new Janvas({ ChildLayout: { FlexGrow: 1 } });
  janvas.Renderer = new CubeSubsystem();
  screen.AddChild(janvas);

  canvas.Root.AddChild(screen);

  // A glass panel floating OVER the 3D cube — proves UI composites on top of
  // (and samples) subsystem content in the one shared world.
  const card = new Jiv({
    Layout: { Direction: 'Column', Justify: 'End', Align: 'Start', Padding: '20' },
    Style: { ...LiquidGlass, BorderRadius: '24' },
    ChildLayout: { Position: 'Placed', Width: '260', Height: '120' },
    Width: 260, Height: 120,
  });
  card.X = 60; card.Y = 60;
  card.AddChild(new Jiv({
    Text: 'UI over a 3D Janvas',
    TextStyle: { FontSize: '18', FontWeight: 600, Color: 'rgba(255,255,255,0.95)', TextAlign: 'Left' },
    ChildLayout: { FlexGrow: 0, Height: '24' },
  }));
  canvas.Root.AddChild(card);

  canvas.Start();
  requestAnimationFrame(() => { el.dataset.ready = 'true'; });

  let _lastFrameTime = performance.now();
  let _frameMsAvg = 0;
  canvas.RegisterPostFrame(() => {
    const now = performance.now();
    const dt = now - _lastFrameTime;
    _lastFrameTime = now;
    _frameMsAvg = _frameMsAvg === 0 ? dt : _frameMsAvg * 0.9 + dt * 0.1;
    (window as unknown as Record<string, unknown>).__jaui_framems = _frameMsAvg;
  });
}
