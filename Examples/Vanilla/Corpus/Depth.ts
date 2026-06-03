// Phase 5 Z-depth test: identical panels at increasing translateZ in World space.
// They should recede/advance in PERSPECTIVE (nearer = larger, farther = smaller),
// proving the camera projection + Space:World. The z=0 panel must sit exactly
// where a flat Screen panel would (the calibration invariant).
import { Canvas, Jiv } from 'jaui';

export default async function setup(el: HTMLCanvasElement): Promise<void> {
  const canvas = await Canvas.Create(el);

  const screen = new Jiv({
    Layout: { Direction: 'Column', Justify: 'Center', Align: 'Center', Gap: '20', Padding: '40' },
    Style: { Background: 'rgb(18, 20, 30)' },
    ChildLayout: { FlexGrow: 1 },
  });

  // translateZ in device px: +Z = toward viewer (larger), -Z = away (smaller).
  // A 50° FOV camera at z≈d makes these visibly change size with perspective.
  const zVals = [200, 100, 0, -150, -350];
  const colors = ['rgb(255,90,90)', 'rgb(255,170,60)', 'rgb(90,200,120)', 'rgb(90,150,240)', 'rgb(180,100,240)'];
  zVals.forEach((z, i) => {
    screen.AddChild(new Jiv({
      Style: {
        Background: colors[i],
        BorderRadius: '20',
        Space: 'World',
        VisualTranslate: '0 0 ' + String(z),
      },
      ChildLayout: { FlexGrow: 0, FlexShrink: 0, Width: '420', Height: '70' },
    }));
  });

  canvas.Root.AddChild(screen);

  // Atmospheric fog: on-plane UI (view-depth ~= camera distance ~643px at 600h)
  // stays clear; elements pushed away in Z (negative translateZ → larger
  // view-depth) haze toward the fog color, selling the depth.
  canvas.SetFog({ Color: [0.07, 0.08, 0.12], Start: 660, Range: 360, Density: 1 });
  // Depth of field: focus the z=0 plane (view-depth ~= camera distance ~643px);
  // panels nearer/farther soften. Combined with fog, gives full cinematic depth.
  canvas.SetDof({ FocusDepth: 643, FocusRange: 80, Strength: 1 });

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
