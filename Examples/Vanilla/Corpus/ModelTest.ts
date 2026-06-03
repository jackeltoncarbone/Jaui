// Isolation: ONE Model3D filling the screen, centered. If the gem is dead-center,
// Model3D's frame-to-rect is correct and the home framing bug is layout-specific.
// If it's off-center, the Janvas rect→world mapping is the bug.
import * as THREE from 'three';
import { Canvas, Jiv, Model3D, RotationView } from 'jaui';

function gem(): THREE.Object3D {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.42, 0),
    new THREE.MeshStandardMaterial({ color: 0x4fa8ff, roughness: 0.2, metalness: 0.7 }),
  ));
  return g;
}

export default async function setup(el: HTMLCanvasElement): Promise<void> {
  const canvas = await Canvas.Create(el);
  const root = new Jiv({
    Layout: { Direction: 'Column', Justify: 'Stretch', Align: 'Stretch' },
    ChildLayout: { FlexGrow: 1 },
  });
  root.AddChild(new RotationView({
    AutoSpin: true,
    Content: new Model3D({ Object: gem(), Fit: 0.6 }),
    ChildLayout: { FlexGrow: 1, FlexShrink: 1 },
  }));
  canvas.Root.AddChild(root);
  canvas.Start();
  requestAnimationFrame(() => { el.dataset.ready = 'true'; });
}
