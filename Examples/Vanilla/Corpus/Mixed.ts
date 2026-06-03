import { Canvas, Jiv, LiquidGlass } from 'jaui';

export default async function setup(el: HTMLCanvasElement): Promise<void> {
  const canvas = await Canvas.Create(el);

  const screen = new Jiv({
    Layout: { Direction: 'Column', Justify: 'Start', Align: 'Stretch' },
    Style: { Background: 'rgba(10, 11, 20, 1)' },
    ChildLayout: { FlexGrow: 1 },
  });

  // Header
  const header = new Jiv({
    Layout: { Direction: 'Column', Justify: 'End', Align: 'Start', Gap: '4', Padding: '56 32 20 32' },
    ChildLayout: { FlexGrow: 0, FlexShrink: 0, Height: '140' },
  });
  header.AddChild(new Jiv({
    Text: 'Today',
    TextStyle: { FontSize: '14', FontWeight: 600, Color: 'rgba(255, 115, 140, 1)', TextAlign: 'Left' },
    ChildLayout: { FlexGrow: 0, Height: '18' },
  }));
  header.AddChild(new Jiv({
    Text: 'Library',
    TextStyle: { FontSize: '40', FontWeight: 700, Color: 'rgba(255, 255, 255, 0.98)', TextAlign: 'Left' },
    ChildLayout: { FlexGrow: 0, Height: '52' },
  }));
  screen.AddChild(header);

  // Scrollable card list
  const list = new Jiv({
    Layout: { Direction: 'Column', Justify: 'Start', Align: 'Stretch', Gap: '14', Padding: '0 24 140 24' },
    Overflow: 'Scroll',
    ChildLayout: { FlexGrow: 1 },
  });

  type Card = { Title: string; Sub: string; Color: string; Height: number };
  const cards: Card[] = [
    { Title: 'Pulse',        Sub: 'Electronic',   Color: 'rgb(80, 130, 255)',  Height: 160 },
    { Title: 'Embers',       Sub: 'Ambient',      Color: 'rgb(220, 100, 60)',  Height: 140 },
    { Title: 'Prism',        Sub: 'Experimental', Color: 'rgb(170, 80, 240)',  Height: 140 },
    { Title: 'Tidal',        Sub: 'Acoustic',     Color: 'rgb(50, 185, 170)',  Height: 120 },
    { Title: 'Solstice',     Sub: 'Orchestral',   Color: 'rgb(200, 170, 50)',  Height: 140 },
  ];

  for (const c of cards) {
    const card = new Jiv({
      Layout: { Direction: 'Column', Justify: 'End', Align: 'Start', Gap: '2', Padding: '16 18 18 18' },
      Style: {
        Background: c.Color,
        BorderRadius: '22',
        ShadowColor: 'rgba(0, 0, 0, 0.35)',
        ShadowBlur: '24',
        ShadowOffsetY: '10',
      },
      ChildLayout: { FlexGrow: 0, FlexShrink: 0, Height: String(c.Height) },
    });
    card.AddChild(new Jiv({
      Text: c.Sub.toUpperCase(),
      TextStyle: { FontSize: '11', FontWeight: 700, Color: 'rgba(255, 255, 255, 0.72)', TextAlign: 'Left' },
      ChildLayout: { FlexGrow: 0, Height: '14' },
    }));
    card.AddChild(new Jiv({
      Text: c.Title,
      TextStyle: { FontSize: '24', FontWeight: 700, Color: 'rgba(255, 255, 255, 0.97)', TextAlign: 'Left' },
      ChildLayout: { FlexGrow: 0, Height: '32' },
    }));
    list.AddChild(card);
  }
  screen.AddChild(list);

  // Floating glass nav bar
  const NAV_H = 58;
  const NAV_W = 400;
  const BAR_PAD = 6;

  const navBar = new Jiv({
    Layout: { Direction: 'Row', Justify: 'Start', Align: 'Stretch', Padding: String(BAR_PAD), Gap: '0' },
    Style: {
      ...LiquidGlass,
      BorderRadius: String(NAV_H / 2),
    },
    ChildLayout: { Position: 'Placed', Width: String(NAV_W), Height: String(NAV_H) },
    Width: NAV_W,
    Height: NAV_H,
  });

  const tabLabels = ['Home', 'Library', 'Search', 'Profile'];
  const tabs: Jiv[] = tabLabels.map((label, i) => new Jiv({
    Text: label,
    TextStyle: {
      FontSize: '13',
      FontWeight: i === 1 ? 600 : 500,
      Color: i === 1 ? 'rgba(255, 255, 255, 0.95)' : 'rgba(255, 255, 255, 0.55)',
      TextAlign: 'Center',
    },
    ChildLayout: { FlexGrow: 1, FlexBasis: '0' },
  }));

  const IND_H = NAV_H - BAR_PAD * 2 - 4;
  const indicator = new Jiv({
    Style: {
      Background: 'rgba(255, 255, 255, 0.16)',
      BorderRadius: String(IND_H / 2),
    },
    ChildLayout: {
      Position: 'Attach',
      AttachTo: tabs[1],
      AttachMode: 'Fill',
      AttachInset: '2',
    },
  });

  navBar.AddChild(indicator);
  tabs.forEach((t) => navBar.AddChild(t));
  screen.AddChild(navBar);

  canvas.Root.AddChild(screen);
  canvas.Start();

  const BOTTOM = 28;
  const SIDE   = 20;

  const positionNav = (): void => {
    const maxW = canvas.Width - SIDE * 2;
    const w = Math.min(NAV_W, maxW);
    navBar.Width = w;
    navBar.ChildLayout.Width = String(w);
    navBar.X = (canvas.Width - w) / 2;
    navBar.Y = canvas.Height - NAV_H - BOTTOM;
    navBar.MarkLayoutDirty();
  };

  const tryInit = (): void => {
    if (canvas.Width > 0) {
      positionNav();
      canvas.RequestFrame();
    } else {
      requestAnimationFrame(tryInit);
    }
  };
  requestAnimationFrame(tryInit);

  window.addEventListener('resize', () => requestAnimationFrame(() => { positionNav(); canvas.RequestFrame(); }));
  new ResizeObserver(() => requestAnimationFrame(() => { positionNav(); canvas.RequestFrame(); })).observe(el);

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
