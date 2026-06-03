import { Canvas, Jiv, LiquidGlass } from 'jaui';

export default async function setup(el: HTMLCanvasElement): Promise<void> {
  const canvas = await Canvas.Create(el);

  // Full-bleed gradient backdrop — gives the glass panels something rich to sample
  const backdrop = new Jiv({
    Layout: { Direction: 'Column', Justify: 'Center', Align: 'Center', Gap: '40', Padding: '60' },
    Style: {
      Background: 'LinearGradient(135deg, rgb(20, 40, 120) 0%, rgb(100, 20, 160) 45%, rgb(180, 60, 60) 100%)',
    },
    ChildLayout: { FlexGrow: 1 },
  });

  // Decorative colored circles sitting behind the glass panels
  const circleRow = new Jiv({
    Layout: { Direction: 'Row', Justify: 'Center', Align: 'Center', Gap: '30' },
    ChildLayout: { FlexGrow: 0, FlexShrink: 0, Height: '160' },
  });
  for (const color of ['rgb(255, 80, 80)', 'rgb(80, 200, 255)', 'rgb(255, 200, 60)', 'rgb(100, 255, 160)']) {
    circleRow.AddChild(new Jiv({
      Style: { Background: color, BorderRadius: '80' },
      ChildLayout: { FlexGrow: 0, FlexShrink: 0, Width: '120', Height: '120' },
    }));
  }
  backdrop.AddChild(circleRow);

  // Glass panel row — two LiquidGlass panels floating over the gradient + circles
  const glassRow = new Jiv({
    Layout: { Direction: 'Row', Justify: 'Center', Align: 'Center', Gap: '24' },
    ChildLayout: { FlexGrow: 0, FlexShrink: 0 },
  });

  const glassA = new Jiv({
    Layout: { Direction: 'Column', Justify: 'End', Align: 'Start', Gap: '4', Padding: '20 24 24 24' },
    Style: {
      ...LiquidGlass,
      BorderRadius: '28',
    },
    ChildLayout: { FlexGrow: 0, FlexShrink: 0, Width: '240', Height: '160' },
  });
  glassA.AddChild(new Jiv({
    Text: 'LIQUID GLASS',
    TextStyle: { FontSize: '11', FontWeight: 700, Color: 'rgba(255, 255, 255, 0.7)', TextAlign: 'Left' },
    ChildLayout: { FlexGrow: 0, Height: '14' },
  }));
  glassA.AddChild(new Jiv({
    Text: 'Panel A',
    TextStyle: { FontSize: '26', FontWeight: 600, Color: 'rgba(255, 255, 255, 0.95)', TextAlign: 'Left' },
    ChildLayout: { FlexGrow: 0, Height: '34' },
  }));

  const glassB = new Jiv({
    Layout: { Direction: 'Column', Justify: 'Center', Align: 'Center', Padding: '24' },
    Style: {
      ...LiquidGlass,
      BorderRadius: '60',
    },
    ChildLayout: { FlexGrow: 0, FlexShrink: 0, Width: '160', Height: '160' },
  });
  glassB.AddChild(new Jiv({
    Text: 'Panel B',
    TextStyle: { FontSize: '18', FontWeight: 600, Color: 'rgba(255, 255, 255, 0.9)', TextAlign: 'Center' },
    ChildLayout: { FlexGrow: 0, Height: '24' },
  }));

  glassRow.AddChild(glassA);
  glassRow.AddChild(glassB);
  backdrop.AddChild(glassRow);

  canvas.Root.AddChild(backdrop);
  canvas.Start();

  requestAnimationFrame(() => {
    el.dataset.ready = 'true';
  });

  let _lastFrameTime = performance.now();
  let _frameMsAvg = 0;
  canvas.RegisterPostFrame(() => {
    const now = performance.now();
    const dt = now - _lastFrameTime;
    _lastFrameTime = now;
    // Exponential moving average to smooth jitter.
    _frameMsAvg = _frameMsAvg === 0 ? dt : _frameMsAvg * 0.9 + dt * 0.1;
    (window as unknown as Record<string, unknown>).__jaui_framems = _frameMsAvg;
  });
}
