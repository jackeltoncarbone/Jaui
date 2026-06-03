import { Canvas, Jiv } from 'jaui';

export default async function setup(el: HTMLCanvasElement): Promise<void> {
  const canvas = await Canvas.Create(el);

  const panels: { color: string; radius: string; width: string; height: string }[] = [
    { color: 'rgb(220, 60,  60)',  radius: '4',  width: '340', height: '60'  },
    { color: 'rgb(255, 140, 0)',   radius: '12', width: '280', height: '80'  },
    { color: 'rgb(40,  180, 100)', radius: '20', width: '400', height: '72'  },
    { color: 'rgb(60,  120, 240)', radius: '28', width: '320', height: '90'  },
    { color: 'rgb(160, 60,  220)', radius: '36', width: '260', height: '64'  },
    { color: 'rgb(30,  200, 200)', radius: '44', width: '380', height: '100' },
  ];

  const column = new Jiv({
    Layout: { Direction: 'Column', Justify: 'Center', Align: 'Center', Gap: '20', Padding: '40' },
    Style: { Background: 'rgb(18, 18, 22)' },
    ChildLayout: { FlexGrow: 1 },
  });

  for (const p of panels) {
    column.AddChild(new Jiv({
      Style: {
        Background: p.color,
        BorderRadius: p.radius,
      },
      ChildLayout: { FlexGrow: 0, FlexShrink: 0, Width: p.width, Height: p.height },
    }));
  }

  canvas.Root.AddChild(column);
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
