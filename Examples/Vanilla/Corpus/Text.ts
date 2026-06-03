import { Canvas, Jiv } from 'jaui';

export default async function setup(el: HTMLCanvasElement): Promise<void> {
  const canvas = await Canvas.Create(el);

  const bg = new Jiv({
    Layout: { Direction: 'Column', Justify: 'Start', Align: 'Stretch', Gap: '16', Padding: '40' },
    Style: { Background: 'rgb(12, 12, 18)' },
    ChildLayout: { FlexGrow: 1 },
  });

  // Small label — muted, light weight
  const labelPanel = new Jiv({
    Layout: { Direction: 'Column', Justify: 'Center', Align: 'Start', Padding: '16 20' },
    Style: { Background: 'rgb(26, 26, 36)', BorderRadius: '12' },
    ChildLayout: { FlexGrow: 0, FlexShrink: 0 },
  });
  labelPanel.AddChild(new Jiv({
    Text: 'SECTION LABEL',
    TextStyle: { FontSize: '11', FontWeight: 600, Color: 'rgba(255, 255, 255, 0.5)', TextAlign: 'Left' },
    ChildLayout: { FlexGrow: 0, Height: '14' },
  }));
  bg.AddChild(labelPanel);

  // Title — large, bold, white
  const titlePanel = new Jiv({
    Layout: { Direction: 'Column', Justify: 'Center', Align: 'Start', Padding: '20 20' },
    Style: { Background: 'rgb(26, 26, 36)', BorderRadius: '16' },
    ChildLayout: { FlexGrow: 0, FlexShrink: 0 },
  });
  titlePanel.AddChild(new Jiv({
    Text: 'Display Heading',
    TextStyle: { FontSize: '40', FontWeight: 700, Color: 'rgba(255, 255, 255, 0.98)', TextAlign: 'Left' },
    ChildLayout: { FlexGrow: 0, Height: '52' },
  }));
  bg.AddChild(titlePanel);

  // Subtitle — medium, accent color
  const subtitlePanel = new Jiv({
    Layout: { Direction: 'Column', Justify: 'Center', Align: 'Start', Padding: '16 20' },
    Style: { Background: 'rgb(26, 26, 36)', BorderRadius: '12' },
    ChildLayout: { FlexGrow: 0, FlexShrink: 0 },
  });
  subtitlePanel.AddChild(new Jiv({
    Text: 'Subtitle in accent color',
    TextStyle: { FontSize: '20', FontWeight: 500, Color: 'rgba(100, 180, 255, 1)', TextAlign: 'Left' },
    ChildLayout: { FlexGrow: 0, Height: '26' },
  }));
  bg.AddChild(subtitlePanel);

  // Body — normal weight, readable gray, right-aligned
  const bodyPanel = new Jiv({
    Layout: { Direction: 'Column', Justify: 'Center', Align: 'Stretch', Padding: '16 20' },
    Style: { Background: 'rgb(26, 26, 36)', BorderRadius: '12' },
    ChildLayout: { FlexGrow: 0, FlexShrink: 0 },
  });
  bodyPanel.AddChild(new Jiv({
    Text: 'Body text at 16pt, right-aligned.',
    TextStyle: { FontSize: '16', FontWeight: 400, Color: 'rgba(255, 255, 255, 0.75)', TextAlign: 'Right' },
    ChildLayout: { FlexGrow: 0, Height: '22' },
  }));
  bg.AddChild(bodyPanel);

  // Multiline wrapping — long text inside a constrained panel
  const wrapPanel = new Jiv({
    Layout: { Direction: 'Column', Justify: 'Start', Align: 'Stretch', Padding: '20' },
    Style: { Background: 'rgb(32, 28, 48)', BorderRadius: '16', BorderColor: 'rgba(180, 120, 255, 0.3)', BorderWidth: '1' },
    ChildLayout: { FlexGrow: 0, FlexShrink: 0 },
  });
  wrapPanel.AddChild(new Jiv({
    Text: 'This is a longer paragraph that should wrap across multiple lines because the panel is narrower than the text content, exercising the word-wrap and multi-line layout path of the text renderer.',
    TextStyle: { FontSize: '14', FontWeight: 400, Color: 'rgba(255, 255, 255, 0.8)', TextAlign: 'Left' },
    ChildLayout: { FlexGrow: 1 },
  }));
  bg.AddChild(wrapPanel);

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
