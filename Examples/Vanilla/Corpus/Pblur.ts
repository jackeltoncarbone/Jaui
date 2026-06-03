import { Canvas, Jiv } from 'jaui';

export default async function setup(el: HTMLCanvasElement): Promise<void> {
  const canvas = await Canvas.Create(el);

  const screen = new Jiv({
    Layout: { Direction: 'Column', Justify: 'Start', Align: 'Stretch', Gap: '12', Padding: '24' },
    Style: { Background: 'LinearGradient(160deg, rgb(30, 80, 180) 0%, rgb(160, 40, 120) 100%)' },
    ChildLayout: { FlexGrow: 1 },
  });

  // Rich content the progressive blur will feather over.
  for (let i = 0; i < 8; i++) {
    const row = new Jiv({
      Layout: { Direction: 'Row', Justify: 'Start', Align: 'Center', Gap: '12' },
      ChildLayout: { FlexGrow: 0, FlexShrink: 0, Height: '64' },
    });
    row.AddChild(new Jiv({
      Style: { Background: `rgb(${40 + i * 24}, ${200 - i * 14}, ${120 + i * 12})`, BorderRadius: '16' },
      ChildLayout: { FlexGrow: 0, FlexShrink: 0, Width: '64', Height: '64' },
    }));
    row.AddChild(new Jiv({
      Text: `Row ${i + 1} — content beneath the feather`,
      TextStyle: { FontSize: '18', FontWeight: 600, Color: 'rgba(255,255,255,0.95)', TextAlign: 'Left' },
      ChildLayout: { FlexGrow: 1, Height: '24' },
    }));
    screen.AddChild(row);
  }

  // Progressive-blur feather strip at the top — clear at the bottom edge,
  // ramping to heavy frost at the very top (ToTop), like a status-bar scrim.
  const feather = new Jiv({
    Style: {
      Background: 'rgba(20, 30, 60, 0.25)',
      BackdropFrostBlur: '40',
      ProgressiveBlurDirection: 'ToTop',
      ProgressiveBlurFeather: '120',
    },
    ChildLayout: { Position: 'Placed', Width: String(752), Height: '160' },
    Width: 752,
    Height: 160,
  });
  feather.X = 0;
  feather.Y = 0;

  canvas.Root.AddChild(screen);
  canvas.Root.AddChild(feather);
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
