// Phase 5 slab test: panels with increasing Thickness + Fillet, lit so the
// beveled edge catches a highlight. The first panel is Thickness:0 (control) —
// it MUST look identical to a flat panel (the additive-depth invariant).
import { Canvas, Jiv } from 'jaui';

export default async function setup(el: HTMLCanvasElement): Promise<void> {
  const canvas = await Canvas.Create(el);

  const screen = new Jiv({
    Layout: { Direction: 'Column', Justify: 'Center', Align: 'Center', Gap: '28', Padding: '40' },
    Style: { Background: 'rgb(22, 24, 34)' },
    ChildLayout: { FlexGrow: 1 },
  });

  // (elevation, fillet) — first is the flat control. Elevation is the SOLID-panel
  // depth axis (does NOT promote to glass, unlike Thickness).
  const variants: [number, number][] = [
    [0, 0], [12, 8], [28, 16], [48, 28],
  ];
  for (const [elevation, fillet] of variants) {
    screen.AddChild(new Jiv({
      Style: {
        Background: 'rgb(90, 150, 240)',
        BorderRadius: '40',
        Elevation: String(elevation),
        Fillet: String(fillet),
        LightAngle: '135',      // light from upper-left
        LightIntensity: '1',
      },
      ChildLayout: { FlexGrow: 0, FlexShrink: 0, Width: '460', Height: '90' },
    }));
  }

  canvas.Root.AddChild(screen);
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
