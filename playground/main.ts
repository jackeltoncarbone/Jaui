import { Canvas, Jiv, LiquidGlass } from '../src/Core/Jwift';
import { JivAnimator } from '../src/Jiv/Jiv.Animator';

const el = document.getElementById('jwift') as HTMLCanvasElement;
const canvas = new Canvas(el);

// ─── Background (colored circles + content behind the glass bar) ───

const screen = new Jiv({
  Layout: { Direction: 'Column', Justify: 'Start', Align: 'Stretch' },
  Style: { Background: { R: 0.06, G: 0.07, B: 0.12, A: 1 } },
  ChildLayout: { FlexGrow: 1 },
});

const circlesRow = new Jiv({
  Layout: { Direction: 'Row', Justify: 'SpaceEvenly', Align: 'End', Padding: [40, 40, 0, 40] },
  ChildLayout: { FlexGrow: 1 },
});
const circleColors = [
  { R: 0.9, G: 0.35, B: 0.55 },
  { R: 0.35, G: 0.65, B: 1.0 },
  { R: 1.0, G: 0.75, B: 0.25 },
  { R: 0.45, G: 1.0, B: 0.65 },
];
circleColors.forEach((c) => {
  const circle = new Jiv({
    Style: {
      Background: { R: c.R, G: c.G, B: c.B, A: 1 },
      BorderRadius: [260, 260, 260, 260],
      Smoothness: 1,
      ShadowColor: { R: 0, G: 0, B: 0, A: 0.4 },
      ShadowBlur: 40,
      ShadowOffsetY: 12,
    },
    ChildLayout: { FlexGrow: 0, Width: 280, Height: 280 },
  });
  circlesRow.AddChild(circle);
});
screen.AddChild(circlesRow);

// Bottom row: holds the tab bar, centered, with less margin so bar sits over the circles
const bottomRow = new Jiv({
  Layout: { Direction: 'Row', Justify: 'Center', Align: 'End', Padding: [0, 0, 24, 0] },
  ChildLayout: { FlexGrow: 0, Height: 84 },
});
screen.AddChild(bottomRow);

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
    ShadowColor: { R: 0, G: 0, B: 0, A: 0.35 },
    ShadowBlur: 24,
    ShadowOffsetY: 8,
  },
  ChildLayout: { FlexGrow: 0, Width: NAV_W, Height: NAV_H },
});

// Indicator pill — Placed child, manually positioned + animated
const IND_W = TAB_W - INDICATOR_INSET * 2;
const IND_H = NAV_H - BAR_PAD * 2 - INDICATOR_INSET * 2;
const indicator = new Jiv({
  Style: {
    Background: { R: 1, G: 1, B: 1, A: 0.18 },
    BorderRadius: [IND_H / 2, IND_H / 2, IND_H / 2, IND_H / 2],
  },
  ChildLayout: { Position: 'Placed', Width: IND_W, Height: IND_H },
  X: BAR_PAD + INDICATOR_INSET, // relative to tabBar — but since Placed = absolute,
  Y: BAR_PAD + INDICATOR_INSET, // we'll compute absolute X/Y after first layout pass
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

bottomRow.AddChild(tabBar);
canvas.Root.AddChild(screen);
canvas.Start();

// ─── Indicator animation (manual JivAnimator for a Placed node) ───

// Placed children aren't put through the Canvas's auto-animator loop. We create one manually.
const indAnimator = new JivAnimator(indicator);
canvas.Animations.Register(indAnimator);

let selected = 0;

const updateIndicator = (snap: boolean): void => {
  const targetX = tabBar.X + BAR_PAD + INDICATOR_INSET + selected * TAB_W;
  const targetY = tabBar.Y + BAR_PAD + INDICATOR_INSET;
  if (snap) {
    indAnimator.Springs.X.Target = targetX;
    indAnimator.Springs.Y.Target = targetY;
    indAnimator.Springs.Width.Target = IND_W;
    indAnimator.Springs.Height.Target = IND_H;
    indAnimator.Springs.X.Snap();
    indAnimator.Springs.Y.Snap();
    indAnimator.Springs.Width.Snap();
    indAnimator.Springs.Height.Snap();
    // Also sync Jiv properties directly so first render doesn't show 0,0
    indicator.X = targetX;
    indicator.Y = targetY;
    indicator.Width = IND_W;
    indicator.Height = IND_H;
  } else {
    indAnimator.SetTargets({ X: targetX, Y: targetY, Width: IND_W, Height: IND_H });
    canvas.Animations.Kick();
  }
};

// Keep trying until tabBar has its resolved position, then snap
const tryInit = (): void => {
  if (tabBar.X > 0 && tabBar.Y > 0) {
    updateIndicator(true);
    canvas.RequestFrame();
  } else {
    requestAnimationFrame(tryInit);
  }
};
requestAnimationFrame(tryInit);

// ─── Click to select ───

el.addEventListener('click', (ev) => {
  const rect = el.getBoundingClientRect();
  const clickX = ev.clientX - rect.left;
  const clickY = ev.clientY - rect.top;

  // Hit-test against tab bar
  if (clickX < tabBar.X || clickX > tabBar.X + tabBar.Width) return;
  if (clickY < tabBar.Y || clickY > tabBar.Y + tabBar.Height) return;

  const localX = clickX - tabBar.X - BAR_PAD;
  const idx = Math.max(0, Math.min(TAB_COUNT - 1, Math.floor(localX / TAB_W)));
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
  updateIndicator(false);
});

console.log('[Jwift] Click a tab in the nav bar');
