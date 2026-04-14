import { Canvas, Jiv, LiquidGlass } from '../src/Core/Jwift';

const el = document.getElementById('jwift') as HTMLCanvasElement;
const canvas = new Canvas(el);

// ─── Background screen ───

const screen = new Jiv({
  Layout: { Direction: 'Column', Justify: 'Start', Align: 'Stretch' },
  Style: { Background: { R: 0.04, G: 0.045, B: 0.08, A: 1 } },
  ChildLayout: { FlexGrow: 1 },
});

// ─── Header ───

const header = new Jiv({
  Layout: { Direction: 'Column', Justify: 'End', Align: 'Start', Gap: 4, Padding: [56, 32, 20, 32] },
  ChildLayout: { FlexGrow: 0, FlexShrink: 0, Height: 140 },
});
header.AddChild(new Jiv({
  Text: 'Today',
  TextStyle: { FontSize: 14, FontWeight: 600, Color: { R: 1, G: 0.45, B: 0.55, A: 1 }, TextAlign: 'Left' },
  ChildLayout: { FlexGrow: 0, Height: 18 },
}));
header.AddChild(new Jiv({
  Text: 'Discover',
  TextStyle: { FontSize: 40, FontWeight: 700, Color: { R: 1, G: 1, B: 1, A: 0.98 }, TextAlign: 'Left' },
  ChildLayout: { FlexGrow: 0, Height: 52 },
}));

screen.AddChild(header);

// Content stack — colourful cards behind the glass bar so refraction has material to work on.
// Overflow: 'Scroll' → the wheel handler hit-tests this, and the cards below scroll
// through its bounds. Cards total height > contentColumn height → visible overflow.
const contentColumn = new Jiv({
  Layout: { Direction: 'Column', Justify: 'Start', Align: 'Stretch', Gap: 18, Padding: [0, 24, 140, 24] },
  Style: { Overflow: 'Scroll' },
  ChildLayout: { FlexGrow: 1 },
});

type Card = { Title: string; Kicker: string; Color: { R: number; G: number; B: number }; Height: number };
const cards: Card[] = [
  { Title: 'Northern Lights',   Kicker: 'Featured',    Color: { R: 0.35, G: 0.55, B: 1.0 },  Height: 220 },
  { Title: 'Sunset Run',        Kicker: 'Workout',     Color: { R: 1.0,  G: 0.48, B: 0.28 }, Height: 140 },
  { Title: 'Deep Focus',        Kicker: 'Playlist',    Color: { R: 0.72, G: 0.38, B: 1.0 },  Height: 140 },
  { Title: 'Coastline',         Kicker: 'Photo Story', Color: { R: 0.25, G: 0.78, B: 0.72 }, Height: 180 },
  { Title: 'Golden Hour',       Kicker: 'Collection',  Color: { R: 1.0,  G: 0.78, B: 0.28 }, Height: 160 },
  { Title: 'Evergreen',         Kicker: 'Nature',      Color: { R: 0.35, G: 0.72, B: 0.45 }, Height: 140 },
];

for (const c of cards) {
  const card = new Jiv({
    Layout: { Direction: 'Column', Justify: 'End', Align: 'Start', Gap: 2, Padding: [20, 22, 22, 22] },
    Style: {
      Background: { R: c.Color.R, G: c.Color.G, B: c.Color.B, A: 1 },
      BorderRadius: [28, 28, 28, 28],
      ShadowColor: { R: 0, G: 0, B: 0, A: 0.4 },
      ShadowBlur: 32,
      ShadowOffsetY: 14,
    },
    ChildLayout: { FlexGrow: 0, FlexShrink: 0, Height: c.Height },
  });
  card.AddChild(new Jiv({
    Text: c.Kicker.toUpperCase(),
    TextStyle: { FontSize: 11, FontWeight: 700, Color: { R: 1, G: 1, B: 1, A: 0.78 }, TextAlign: 'Left' },
    ChildLayout: { FlexGrow: 0, Height: 14 },
  }));
  card.AddChild(new Jiv({
    Text: c.Title,
    TextStyle: { FontSize: 26, FontWeight: 700, Color: { R: 1, G: 1, B: 1, A: 0.98 }, TextAlign: 'Left' },
    ChildLayout: { FlexGrow: 0, Height: 34 },
  }));
  contentColumn.AddChild(card);
}

screen.AddChild(contentColumn);

// The tab bar is Placed (absolute positioning) so it can overlap the circles.
// Glass needs backdrop content to refract — if the bar sits alongside circles
// it has nothing behind it.

// ─── Nav Tab Bar ───

const NAV_W = 440;
const NAV_H = 60;
const BAR_PAD = 6;
const TAB_COUNT = 4;
const TAB_W = (NAV_W - BAR_PAD * 2) / TAB_COUNT;
const INDICATOR_INSET = 2;

const tabBar = new Jiv({
  Layout: { Direction: 'Row', Justify: 'Start', Align: 'Stretch', Padding: [BAR_PAD, BAR_PAD, BAR_PAD, BAR_PAD], Gap: 0 },
  Style: {
    ...LiquidGlass,
    BorderRadius: [NAV_H / 2, NAV_H / 2, NAV_H / 2, NAV_H / 2], // pill shape
  },
  ChildLayout: { Position: 'Placed', Width: NAV_W, Height: NAV_H },
  Width: NAV_W,
  Height: NAV_H,
});

// Indicator pill — Placed child, X/Y RELATIVE to tabBar (Placed = parent-relative,
// like CSS position: absolute inside a positioned ancestor). No manual animator;
// the canvas auto-animator picks up solver targets and springs between them.
const IND_W = TAB_W - INDICATOR_INSET * 2;
const IND_H = NAV_H - BAR_PAD * 2 - INDICATOR_INSET * 2;
const indicator = new Jiv({
  Style: {
    Background: { R: 1, G: 1, B: 1, A: 0.18 },
    BorderRadius: [IND_H / 2, IND_H / 2, IND_H / 2, IND_H / 2],
  },
  ChildLayout: { Position: 'Placed', Width: IND_W, Height: IND_H },
  X: BAR_PAD + INDICATOR_INSET,  // relative to tabBar.X
  Y: BAR_PAD + INDICATOR_INSET,  // relative to tabBar.Y
  Width: IND_W, Height: IND_H,
});

const tabLabels = ['Home', 'Discover', 'Activity', 'Profile'];
const tabs: Jiv[] = tabLabels.map((label, i) => new Jiv({
  Text: label,
  TextStyle: {
    FontSize: 14,
    FontWeight: i === 0 ? 600 : 500,
    Color: i === 0 ? { R: 1, G: 1, B: 1, A: 0.95 } : { R: 1, G: 1, B: 1, A: 0.6 },
    TextAlign: 'Center',
  },
  ChildLayout: { FlexGrow: 1, FlexBasis: 0 },
}));

// Indicator first (underneath), then tabs on top
tabBar.AddChild(indicator);
tabs.forEach((t) => tabBar.AddChild(t));

// Tab bar is a Placed direct child of screen — we position it manually after
// the first layout pass so it floats over the circles at the bottom-center.
screen.AddChild(tabBar);
canvas.Root.AddChild(screen);
canvas.Start();

// ─── Placed positioning: tab bar (screen-relative) + indicator (tab-bar-relative) ───
// Placed children's X/Y are RELATIVE to parent. Indicator just sets its offset
// within tabBar; the solver cascades tabBar's position down automatically.
// No manual animator needed — Canvas's auto-animator springs Placed children
// to their solved targets on layout changes.

let selected = 0;

const BOTTOM_INSET = 32;
const SIDE_INSET = 20;                  // keep nav at least this far from screen edges

/** Reposition the tab bar. X/Y here are RELATIVE to `screen` (its parent),
 *  which starts at (0,0) so this is effectively canvas-absolute. The width
 *  adapts to the viewport so the nav never hangs off a narrow screen. */
const positionTabBar = (): void => {
  const maxW = canvas.Width - SIDE_INSET * 2;
  const width = Math.min(NAV_W, maxW);
  tabBar.Width = width;
  tabBar.ChildLayout.Width = width;
  tabBar.X = (canvas.Width - width) / 2;
  tabBar.Y = canvas.Height - NAV_H - BOTTOM_INSET;
  tabBar.MarkLayoutDirty();
};

/** Update indicator to the currently-selected tab. X is RELATIVE to tabBar. */
const updateIndicator = (): void => {
  const effectiveTabW = (tabBar.Width - BAR_PAD * 2) / TAB_COUNT;
  indicator.X = BAR_PAD + INDICATOR_INSET + selected * effectiveTabW;
  indicator.Y = BAR_PAD + INDICATOR_INSET;
  indicator.Width = effectiveTabW - INDICATOR_INSET * 2;
  indicator.ChildLayout.Width = indicator.Width;
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

// Reposition on any viewport change — ResizeObserver catches window resize AND
// canvas container size changes; visualViewport catches browser zoom reliably
// on mobile + some desktops where resize alone doesn't fire.
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

// ─── Click to select ───

el.addEventListener('click', (ev) => {
  const rect = el.getBoundingClientRect();
  const clickX = ev.clientX - rect.left;
  const clickY = ev.clientY - rect.top;

  // Hit-test against tab bar using its CURRENT width (responsive)
  if (clickX < tabBar.X || clickX > tabBar.X + tabBar.Width) return;
  if (clickY < tabBar.Y || clickY > tabBar.Y + tabBar.Height) return;

  const effectiveTabW = (tabBar.Width - BAR_PAD * 2) / TAB_COUNT;
  const localX = clickX - tabBar.X - BAR_PAD;
  const idx = Math.max(0, Math.min(TAB_COUNT - 1, Math.floor(localX / effectiveTabW)));
  if (idx === selected) return;

  // Update text styles — old tab dims, new tab brightens
  tabs[selected].SetText(tabLabels[selected], {
    Color: { R: 1, G: 1, B: 1, A: 0.6 },
    FontWeight: 500,
  });
  tabs[idx].SetText(tabLabels[idx], {
    Color: { R: 1, G: 1, B: 1, A: 0.95 },
    FontWeight: 600,
  });

  selected = idx;
  updateIndicator();
});

console.log('[Jwift] Click a tab in the nav bar');

(window as unknown as { __jwift: unknown }).__jwift = { canvas, screen, contentColumn, tabBar };
