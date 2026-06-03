import { Canvas, Jiv } from 'jaui';

export default async function setup(el: HTMLCanvasElement): Promise<void> {
  const canvas = await Canvas.Create(el);

  const bg = new Jiv({
    Layout: { Direction: 'Column', Justify: 'Center', Align: 'Center', Gap: '40', Padding: '60' },
    Style: { Background: 'rgb(14, 14, 22)' },
    ChildLayout: { FlexGrow: 1 },
  });

  // Panel A — soft ambient shadow, no border
  bg.AddChild(new Jiv({
    Style: {
      Background: 'rgb(60, 100, 200)',
      BorderRadius: '20',
      ShadowColor: 'rgba(0, 0, 0, 0.55)',
      ShadowBlur: '40',
      ShadowOffsetX: '0',
      ShadowOffsetY: '16',
    },
    ChildLayout: { FlexGrow: 0, FlexShrink: 0, Width: '360', Height: '100' },
  }));

  // Panel B — hard directional shadow, no border
  bg.AddChild(new Jiv({
    Style: {
      Background: 'rgb(220, 80, 60)',
      BorderRadius: '12',
      ShadowColor: 'rgba(220, 80, 60, 0.45)',
      ShadowBlur: '8',
      ShadowOffsetX: '6',
      ShadowOffsetY: '10',
    },
    ChildLayout: { FlexGrow: 0, FlexShrink: 0, Width: '300', Height: '88' },
  }));

  // Panel C — shadow + white border
  bg.AddChild(new Jiv({
    Style: {
      Background: 'rgb(40, 180, 120)',
      BorderRadius: '24',
      ShadowColor: 'rgba(0, 0, 0, 0.6)',
      ShadowBlur: '60',
      ShadowOffsetX: '-8',
      ShadowOffsetY: '20',
      BorderColor: 'rgba(255, 255, 255, 0.8)',
      BorderWidth: '2',
    },
    ChildLayout: { FlexGrow: 0, FlexShrink: 0, Width: '380', Height: '96' },
  }));

  // Panel D — colored shadow + colored border
  bg.AddChild(new Jiv({
    Style: {
      Background: 'rgb(150, 60, 220)',
      BorderRadius: '16',
      ShadowColor: 'rgba(150, 60, 220, 0.7)',
      ShadowBlur: '28',
      ShadowOffsetX: '0',
      ShadowOffsetY: '12',
      BorderColor: 'rgba(220, 160, 255, 0.6)',
      BorderWidth: '1.5',
    },
    ChildLayout: { FlexGrow: 0, FlexShrink: 0, Width: '320', Height: '88' },
  }));

  canvas.Root.AddChild(bg);
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
