import { Canvas, Jiv } from '../src/Core/Jwift';

const el = document.getElementById('jwift') as HTMLCanvasElement;
const canvas = new Canvas(el);

// ─── Tree ───
//
// App (Column)
// ├── Header (Row)
// │   ├── Title (text)
// │   └── Actions (Row) — Button × 3
// └── Body (Row)
//     ├── Sidebar (Column) — NavItem × 4
//     └── Main (Column) — Card × 3 (each with header + body text)

const app = new Jiv({
  Layout: { Mode: 'Flex', Direction: 'Column', Gap: 12, Padding: [16, 16, 16, 16] },
  Style: {
    Background: { R: 1, G: 1, B: 1, A: 0.02 },
    BorderRadius: [20, 20, 20, 20],
    Smoothness: 0.6,
    BorderColor: { R: 1, G: 1, B: 1, A: 0.12 },
    BorderWidth: 1,
  },
  ChildLayout: { FlexGrow: 1 },
});

// ─── Header ───

const header = new Jiv({
  Layout: { Direction: 'Row', Align: 'Center', Justify: 'SpaceBetween', Padding: [12, 16, 12, 16], Gap: 12 },
  Style: {
    Background: { R: 1, G: 1, B: 1, A: 0.05 },
    BorderRadius: [12, 12, 12, 12],
  },
  ChildLayout: { Height: 56, FlexShrink: 0 },
});

const title = new Jiv({
  Text: 'Jwift Demo',
  TextStyle: { FontSize: 22, FontWeight: 700, Color: { R: 1, G: 1, B: 1, A: 0.95 } },
  ChildLayout: { FlexGrow: 0 },
});

const actions = new Jiv({
  Layout: { Direction: 'Row', Gap: 8, Align: 'Center' },
  ChildLayout: { FlexGrow: 0 },
});

const makeButton = (label: string, accent: { R: number; G: number; B: number }): Jiv => new Jiv({
  Text: label,
  TextStyle: { FontSize: 13, FontWeight: 600, Color: { R: 1, G: 1, B: 1, A: 0.9 }, TextAlign: 'Center' },
  Layout: { Padding: [8, 14, 8, 14] },
  Style: {
    Background: { R: accent.R, G: accent.G, B: accent.B, A: 0.22 },
    BorderRadius: [10, 10, 10, 10],
    BorderColor: { R: 1, G: 1, B: 1, A: 0.25 },
    BorderWidth: 1,
  },
  ChildLayout: { Height: 36, FlexGrow: 0 },
});

const btn1 = makeButton('Save', { R: 0.4, G: 0.7, B: 1.0 });
const btn2 = makeButton('Share', { R: 0.5, G: 0.9, B: 0.6 });
const btn3 = makeButton('Delete', { R: 1.0, G: 0.5, B: 0.5 });

actions.AddChild(btn1);
actions.AddChild(btn2);
actions.AddChild(btn3);

header.AddChild(title);
header.AddChild(actions);

// ─── Body ───

const body = new Jiv({
  Layout: { Direction: 'Row', Gap: 12 },
  ChildLayout: { FlexGrow: 1 },
});

// Sidebar

const sidebar = new Jiv({
  Layout: { Direction: 'Column', Gap: 6, Padding: [12, 12, 12, 12] },
  Style: {
    Background: { R: 1, G: 1, B: 1, A: 0.04 },
    BorderRadius: [12, 12, 12, 12],
  },
  ChildLayout: { Width: 180, FlexShrink: 0 },
});

const navLabels = ['Dashboard', 'Projects', 'Team', 'Settings'];
const navItems: Jiv[] = navLabels.map((label) => new Jiv({
  Text: label,
  TextStyle: { FontSize: 14, FontWeight: 500, Color: { R: 1, G: 1, B: 1, A: 0.85 } },
  Layout: { Padding: [10, 12, 10, 12] },
  Style: {
    Background: { R: 1, G: 1, B: 1, A: 0.04 },
    BorderRadius: [8, 8, 8, 8],
  },
  ChildLayout: { Height: 38, FlexGrow: 0 },
}));
navItems.forEach((n) => sidebar.AddChild(n));

// Main content

const main = new Jiv({
  Layout: { Direction: 'Column', Gap: 12, Padding: [0, 0, 0, 0] },
  ChildLayout: { FlexGrow: 1 },
});

const cardColors = [
  { R: 0.4, G: 0.65, B: 1.0 },
  { R: 0.5, G: 1.0, B: 0.7 },
  { R: 1.0, G: 0.7, B: 0.4 },
];

interface Card {
  Root: Jiv;
  Header: Jiv;
  Body: Jiv;
}

const makeCard = (title: string, body: string, accent: { R: number; G: number; B: number }): Card => {
  const cardBody = new Jiv({
    Text: body,
    TextStyle: { FontSize: 13, Color: { R: 1, G: 1, B: 1, A: 0.7 }, LineHeight: 1.4 },
    Layout: { Padding: [12, 16, 12, 16] },
    ChildLayout: { FlexGrow: 1 },
  });

  const cardHeader = new Jiv({
    Text: title,
    TextStyle: { FontSize: 16, FontWeight: 600, Color: { R: 1, G: 1, B: 1, A: 0.95 } },
    Layout: { Padding: [10, 16, 10, 16] },
    Style: {
      Background: { R: accent.R, G: accent.G, B: accent.B, A: 0.18 },
      BorderRadius: [10, 10, 0, 0],
    },
    ChildLayout: { Height: 44, FlexShrink: 0 },
  });

  const root = new Jiv({
    Layout: { Direction: 'Column' },
    Style: {
      Background: { R: 1, G: 1, B: 1, A: 0.05 },
      BorderRadius: [10, 10, 10, 10],
      BorderColor: { R: 1, G: 1, B: 1, A: 0.15 },
      BorderWidth: 1,
      ShadowColor: { R: 0, G: 0, B: 0, A: 0.3 },
      ShadowBlur: 12,
      ShadowOffsetY: 4,
    },
    ChildLayout: { FlexGrow: 1 },
  });
  root.AddChild(cardHeader);
  root.AddChild(cardBody);

  return { Root: root, Header: cardHeader, Body: cardBody };
};

const cards: Card[] = [
  makeCard('Overview', 'Canvas-based UI rendering engine. Every pixel goes through WebGL2 shaders.', cardColors[0]),
  makeCard('Layout', 'Flex solver computes positions instantly. Springs animate to new targets smoothly.', cardColors[1]),
  makeCard('Text', 'Text rasterized to offscreen canvas, cached by content + style hash, rendered as textured quads.', cardColors[2]),
];

cards.forEach((c) => main.AddChild(c.Root));

body.AddChild(sidebar);
body.AddChild(main);

app.AddChild(header);
app.AddChild(body);
canvas.Root.AddChild(app);
canvas.Start();

// ─── Presets (cycle on click) ───

interface Preset {
  Name: string;
  Apply: () => void;
}

const presets: Preset[] = [
  {
    Name: '1. Default (sidebar left, 3 cards column)',
    Apply: () => {
      body.Layout.Direction = 'Row';
      main.Layout.Direction = 'Column';
      sidebar.ChildLayout.Width = 180;
      cards.forEach((c) => { c.Root.ChildLayout.FlexGrow = 1; });
      navItems.forEach((n) => n.SetText(n.Text ?? '', { TextAlign: 'Left' }));
    },
  },
  {
    Name: '2. Sidebar right (RowReverse)',
    Apply: () => {
      body.Layout.Direction = 'RowReverse';
      main.Layout.Direction = 'Column';
    },
  },
  {
    Name: '3. Compact sidebar (60px, centered text)',
    Apply: () => {
      body.Layout.Direction = 'Row';
      sidebar.ChildLayout.Width = 60;
      navItems.forEach((n, i) => n.SetText(['D', 'P', 'T', 'S'][i], { TextAlign: 'Center', FontSize: 18, FontWeight: 700 }));
    },
  },
  {
    Name: '4. Center alignment, all text centered',
    Apply: () => {
      body.Layout.Direction = 'Row';
      sidebar.ChildLayout.Width = 180;
      navItems.forEach((n, i) => n.SetText(navLabels[i], { TextAlign: 'Center' }));
      cards.forEach((c) => {
        c.Header.SetText(c.Header.Text ?? '', { TextAlign: 'Center' });
        c.Body.SetText(c.Body.Text ?? '', { TextAlign: 'Center' });
      });
    },
  },
  {
    Name: '5. Mobile stacked (everything column)',
    Apply: () => {
      body.Layout.Direction = 'Column';
      main.Layout.Direction = 'Column';
      sidebar.ChildLayout.Width = 'Auto' as number | 'Auto';
      sidebar.Layout.Direction = 'Row';
      sidebar.Layout.Justify = 'SpaceEvenly';
      navItems.forEach((n, i) => n.SetText(navLabels[i], { TextAlign: 'Center', FontSize: 13 }));
    },
  },
  {
    Name: '6. Dense grid (3 cards in row)',
    Apply: () => {
      body.Layout.Direction = 'Row';
      sidebar.Layout.Direction = 'Column';
      sidebar.ChildLayout.Width = 180;
      main.Layout.Direction = 'Row';
      main.Layout.Wrap = 'NoWrap';
      navItems.forEach((n, i) => n.SetText(navLabels[i], { TextAlign: 'Left', FontSize: 14, FontWeight: 500 }));
      cards.forEach((c) => {
        c.Header.SetText(c.Header.Text ?? '', { TextAlign: 'Left' });
        c.Body.SetText(c.Body.Text ?? '', { TextAlign: 'Left' });
      });
    },
  },
  {
    Name: '7. Buttons SpaceBetween',
    Apply: () => {
      header.Layout.Justify = 'SpaceBetween';
      actions.Layout.Justify = 'SpaceBetween';
      actions.ChildLayout.FlexGrow = 1;
    },
  },
  {
    Name: '8. Reset',
    Apply: () => {
      body.Layout.Direction = 'Row';
      main.Layout.Direction = 'Column';
      main.Layout.Wrap = 'NoWrap';
      sidebar.Layout.Direction = 'Column';
      sidebar.Layout.Justify = 'Start';
      sidebar.ChildLayout.Width = 180;
      header.Layout.Justify = 'SpaceBetween';
      actions.Layout.Justify = 'Start';
      actions.ChildLayout.FlexGrow = 0;
      navItems.forEach((n, i) => n.SetText(navLabels[i], { TextAlign: 'Left', FontSize: 14, FontWeight: 500 }));
      cards.forEach((c) => {
        c.Header.SetText(c.Header.Text ?? '', { TextAlign: 'Left' });
        c.Body.SetText(c.Body.Text ?? '', { TextAlign: 'Left' });
      });
    },
  },
];

const apply = (index: number): void => {
  presets[index].Apply();
  canvas.Root.Dirty |= 1; // mark layout dirty
  // Propagate dirty through the tree
  const walk = (n: Jiv): void => {
    n.MarkLayoutDirty();
    n.Children.forEach(walk);
  };
  walk(canvas.Root);
  console.log(`[Jwift] ${presets[index].Name}`);
};

apply(0);

let current = 0;
el.addEventListener('click', () => {
  current = (current + 1) % presets.length;
  apply(current);
});

console.log(`[Jwift] Click to cycle through ${presets.length} layout presets`);
