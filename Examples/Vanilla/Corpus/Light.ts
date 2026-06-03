// Phase 5 scene-light test: a grid of panels (some elevated) lit by a movable
// point light. The light adds a soft sheen + specular glint that sweeps across
// the panels and rakes the beveled edges — the "physical light in the UI" feel.
// Light is parked upper-left at a height; in a real app you'd drive Pos from the
// pointer/gyro each frame.
import { Canvas, Jiv } from 'jaui';

export default async function setup(el: HTMLCanvasElement): Promise<void> {
  const canvas = await Canvas.Create(el);

  const grid = new Jiv({
    Layout: { Direction: 'Column', Justify: 'Center', Align: 'Center', Gap: '22', Padding: '50' },
    Style: { Background: 'rgb(16, 18, 26)' },
    ChildLayout: { FlexGrow: 1 },
  });

  // Rows of panels; alternate elevation so the light rakes both flat + beveled.
  for (let r = 0; r < 4; r++) {
    const row = new Jiv({
      Layout: { Direction: 'Row', Justify: 'Center', Align: 'Center', Gap: '22' },
      ChildLayout: { FlexGrow: 0, FlexShrink: 0, Height: '90' },
    });
    for (let c = 0; c < 3; c++) {
      row.AddChild(new Jiv({
        Style: {
          Background: 'rgb(70, 110, 180)',
          BorderRadius: '22',
          Elevation: (r % 2 === 0) ? '20' : '0',
          Fillet: '14',
        },
        ChildLayout: { FlexGrow: 0, FlexShrink: 0, Width: '200', Height: '90' },
      }));
    }
    grid.AddChild(row);
  }

  canvas.Root.AddChild(grid);

  // Scene light parked upper-left, lifted off the plane. Bright white, broad
  // radius so the whole grid catches some sheen with a clear hot-spot near it.
  canvas.SetLight({ Pos: [180, 140, 320], Color: [1, 1, 1], Strength: 1.4, Radius: 900 });

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
