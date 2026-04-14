import { Canvas, Jiv, LiquidGlass } from '../src/Core/Jwift';

const el = document.getElementById('jwift') as HTMLCanvasElement;
const canvas = new Canvas(el);

// ─── Background screen ───

const screen = new Jiv({
  Layout: { Direction: 'Column', Justify: 'Start', Align: 'Stretch' },
  Style: { Background: 'rgba(10, 11, 20, 1)' },
  ChildLayout: { FlexGrow: 1 },
});

// ─── Header ───

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
  Text: 'Discover',
  TextStyle: { FontSize: '40', FontWeight: 700, Color: 'rgba(255, 255, 255, 0.98)', TextAlign: 'Left' },
  ChildLayout: { FlexGrow: 0, Height: '52' },
}));

screen.AddChild(header);

const contentColumn = new Jiv({
  Layout: { Direction: 'Column', Justify: 'Start', Align: 'Stretch', Gap: '18', Padding: '0 24 140 24' },
  Style: { Overflow: 'Scroll' },
  ChildLayout: { FlexGrow: 1 },
});

type Card = { Title: string; Kicker: string; Color: string; Height: number };
const cards: Card[] = [
  { Title: 'Northern Lights', Kicker: 'Featured',    Color: 'rgb(90, 140, 255)',  Height: 220 },
  { Title: 'Sunset Run',      Kicker: 'Workout',     Color: 'rgb(255, 123, 72)',  Height: 140 },
  { Title: 'Deep Focus',      Kicker: 'Playlist',    Color: 'rgb(184, 98, 255)',  Height: 140 },
  { Title: 'Coastline',       Kicker: 'Photo Story', Color: 'rgb(64, 199, 184)',  Height: 180 },
  { Title: 'Golden Hour',     Kicker: 'Collection',  Color: 'rgb(255, 199, 72)',  Height: 160 },
  { Title: 'Evergreen',       Kicker: 'Nature',      Color: 'rgb(90, 184, 115)',  Height: 140 },
];

for (const c of cards) {
  const card = new Jiv({
    Layout: { Direction: 'Column', Justify: 'End', Align: 'Start', Gap: '2', Padding: '20 22 22 22' },
    Style: {
      Background: c.Color,
      BorderRadius: '28',
      ShadowColor: 'rgba(0, 0, 0, 0.4)',
      ShadowBlur: '32',
      ShadowOffsetY: '14',
    },
    HoverStyle: {
      BorderColor: 'rgba(255, 255, 255, 0.95)',
      BorderWidth: '2',
      BorderBlur: '6',
      ShadowColor: 'rgba(255, 255, 255, 0.28)',
      ShadowBlur: '40',
      ShadowOffsetY: '0',
    },
    ActiveStyle: {
      BorderColor: 'rgba(255, 255, 255, 0.35)',
      BorderWidth: '1',
    },
    ChildLayout: { FlexGrow: 0, FlexShrink: 0, Height: String(c.Height) },
  });
  card.AddChild(new Jiv({
    Text: c.Kicker.toUpperCase(),
    TextStyle: { FontSize: '11', FontWeight: 700, Color: 'rgba(255, 255, 255, 0.78)', TextAlign: 'Left' },
    ChildLayout: { FlexGrow: 0, Height: '14' },
  }));
  card.AddChild(new Jiv({
    Text: c.Title,
    TextStyle: { FontSize: '26', FontWeight: 700, Color: 'rgba(255, 255, 255, 0.98)', TextAlign: 'Left' },
    ChildLayout: { FlexGrow: 0, Height: '34' },
  }));
  contentColumn.AddChild(card);
}

screen.AddChild(contentColumn);

// ─── Nav Tab Bar ───

const NAV_W = 440;
const NAV_H = 60;
const BAR_PAD = 6;
const INDICATOR_INSET = 2;

const tabBar = new Jiv({
  Layout: { Direction: 'Row', Justify: 'Start', Align: 'Stretch', Padding: String(BAR_PAD), Gap: '0' },
  Style: {
    ...LiquidGlass,
    BorderRadius: String(NAV_H / 2),   // pill
  },
  ChildLayout: { Position: 'Placed', Width: String(NAV_W), Height: String(NAV_H) },
  Width: NAV_W,
  Height: NAV_H,
});

const tabLabels = ['Home', 'Discover', 'Activity', 'Profile'];
const tabs: Jiv[] = tabLabels.map((label, i) => new Jiv({
  Text: label,
  TextStyle: {
    FontSize: '14',
    FontWeight: i === 0 ? 600 : 500,
    Color: i === 0 ? 'rgba(255, 255, 255, 0.95)' : 'rgba(255, 255, 255, 0.6)',
    TextAlign: 'Center',
  },
  ChildLayout: { FlexGrow: 1, FlexBasis: '0' },
}));

const IND_H = NAV_H - BAR_PAD * 2 - INDICATOR_INSET * 2;
const indicator = new Jiv({
  Style: {
    Background: 'rgba(255, 255, 255, 0.18)',
    BorderRadius: String(IND_H / 2),
  },
  ChildLayout: {
    Position: 'Attach',
    AttachTo: tabs[0],
    AttachMode: 'Fill',
    AttachInset: String(INDICATOR_INSET),
  },
});

tabBar.AddChild(indicator);
tabs.forEach((t) => tabBar.AddChild(t));

screen.AddChild(tabBar);
canvas.Root.AddChild(screen);
canvas.Start();

let selected = 0;

const BOTTOM_INSET = 32;
const SIDE_INSET = 20;

const positionTabBar = (): void => {
  const maxW = canvas.Width - SIDE_INSET * 2;
  const width = Math.min(NAV_W, maxW);
  tabBar.Width = width;
  tabBar.ChildLayout.Width = String(width);
  tabBar.X = (canvas.Width - width) / 2;
  tabBar.Y = canvas.Height - NAV_H - BOTTOM_INSET;
  tabBar.MarkLayoutDirty();
};

const updateIndicator = (): void => {
  indicator.ChildLayout.AttachTo = tabs[selected];
  indicator.MarkLayoutDirty();
};

const tryInit = (): void => {
  if (canvas.Width > 0) {
    positionTabBar();
    updateIndicator();
    canvas.RequestFrame();
  } else {
    requestAnimationFrame(tryInit);
  }
};
requestAnimationFrame(tryInit);

const onViewport = (): void => {
  requestAnimationFrame(() => {
    positionTabBar();
    updateIndicator();
    canvas.RequestFrame();
  });
};
window.addEventListener('resize', onViewport);
window.visualViewport?.addEventListener('resize', onViewport);
new ResizeObserver(onViewport).observe(el);

el.addEventListener('click', (ev) => {
  const rect = el.getBoundingClientRect();
  const clickX = ev.clientX - rect.left;
  const clickY = ev.clientY - rect.top;

  const idx = tabs.findIndex(t =>
    clickX >= t.X && clickX < t.X + t.Width && clickY >= t.Y && clickY < t.Y + t.Height);
  if (idx < 0 || idx === selected) return;

  tabs[selected].SetText(tabLabels[selected], {
    Color: 'rgba(255, 255, 255, 0.6)',
    FontWeight: 500,
  });
  tabs[idx].SetText(tabLabels[idx], {
    Color: 'rgba(255, 255, 255, 0.95)',
    FontWeight: 600,
  });

  selected = idx;
  updateIndicator();
});

console.log('[Jwift] Click a tab in the nav bar');

(window as unknown as { __jwift: unknown }).__jwift = { canvas, screen, contentColumn, tabBar };
