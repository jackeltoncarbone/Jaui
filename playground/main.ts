import { Canvas, Jiv } from '../src/Core/Jwift';
import type { LayoutConfig, ChildLayout } from '../src/Layout/Layout.Types';

const el = document.getElementById('jwift') as HTMLCanvasElement;
const canvas = new Canvas(el);

// ─── Container ───

const container = new Jiv({
  Layout: {
    Mode: 'Flex',
    Direction: 'Row',
    Wrap: 'NoWrap',
    Justify: 'Start',
    Align: 'Stretch',
    AlignContent: 'Stretch',
    Gap: 16,
    RowGap: 0,
    ColumnGap: 0,
    Padding: [24, 24, 24, 24],
  },
  Style: {
    Background: { R: 1, G: 1, B: 1, A: 0.03 },
    BorderRadius: [24, 24, 24, 24],
    Smoothness: 0.6,
    BorderColor: { R: 1, G: 1, B: 1, A: 0.15 },
    BorderWidth: 1,
  },
  ChildLayout: { FlexGrow: 1 },
});

// ─── 5 Child panels ───

const colors = [
  { R: 0.4, G: 0.6, B: 1.0, A: 0.12 },
  { R: 0.5, G: 1.0, B: 0.6, A: 0.12 },
  { R: 1.0, G: 0.5, B: 0.4, A: 0.12 },
  { R: 1.0, G: 0.8, B: 0.3, A: 0.12 },
  { R: 0.7, G: 0.4, B: 1.0, A: 0.12 },
];

const children: Jiv[] = colors.map((bg) =>
  new Jiv({
    Style: {
      Background: bg,
      BorderRadius: [16, 16, 16, 16],
      Smoothness: 0.6,
      BorderColor: { R: 1, G: 1, B: 1, A: 0.25 },
      BorderWidth: 1,
      BorderBlur: 1,
      ShadowColor: { R: 0, G: 0, B: 0, A: 0.25 },
      ShadowBlur: 16,
      ShadowOffsetY: 4,
    },
  }),
);

canvas.Root.AddChild(container);
children.forEach((c) => container.AddChild(c));
canvas.Start();

// ─── Layout Presets ───

interface LayoutPreset {
  Name: string;
  Container: Partial<LayoutConfig>;
  Children: Partial<ChildLayout>[];
}

const presets: LayoutPreset[] = [
  // 0: Equal row
  {
    Name: 'Row — Equal',
    Container: { Direction: 'Row', Justify: 'Start', Align: 'Stretch', Gap: 16 },
    Children: [
      { FlexGrow: 1 },
      { FlexGrow: 1 },
      { FlexGrow: 1 },
      { FlexGrow: 1 },
      { FlexGrow: 1 },
    ],
  },
  // 1: Column stack
  {
    Name: 'Column — Equal',
    Container: { Direction: 'Column', Justify: 'Start', Align: 'Stretch', Gap: 16 },
    Children: [
      { FlexGrow: 1 },
      { FlexGrow: 1 },
      { FlexGrow: 1 },
      { FlexGrow: 1 },
      { FlexGrow: 1 },
    ],
  },
  // 2: Sidebar + content
  {
    Name: 'Row — Sidebar + Content',
    Container: { Direction: 'Row', Justify: 'Start', Align: 'Stretch', Gap: 16 },
    Children: [
      { FlexGrow: 0, Width: 120 },
      { FlexGrow: 1 },
      { FlexGrow: 0, Width: 80 },
      { FlexGrow: 0, Width: 80 },
      { FlexGrow: 0, Width: 80 },
    ],
  },
  // 3: Centered with space around
  {
    Name: 'Row — SpaceEvenly, Center',
    Container: { Direction: 'Row', Justify: 'SpaceEvenly', Align: 'Center', Gap: 0 },
    Children: [
      { FlexGrow: 0, Width: 80, Height: 80 },
      { FlexGrow: 0, Width: 80, Height: 120 },
      { FlexGrow: 0, Width: 80, Height: 160 },
      { FlexGrow: 0, Width: 80, Height: 120 },
      { FlexGrow: 0, Width: 80, Height: 80 },
    ],
  },
  // 4: Weighted column
  {
    Name: 'Column — Weighted 1:2:3:2:1',
    Container: { Direction: 'Column', Justify: 'Start', Align: 'Stretch', Gap: 12 },
    Children: [
      { FlexGrow: 1 },
      { FlexGrow: 2 },
      { FlexGrow: 3 },
      { FlexGrow: 2 },
      { FlexGrow: 1 },
    ],
  },
];

// ─── Apply a preset ───

const applyPreset = (index: number): void => {
  const preset = presets[index];

  // Container layout
  Object.assign(container.Layout, preset.Container);

  // Per-child layout
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const cl = preset.Children[i];

    // Reset to defaults then apply preset
    child.ChildLayout.FlexGrow = cl.FlexGrow ?? 0;
    child.ChildLayout.FlexShrink = cl.FlexShrink ?? 1;
    child.ChildLayout.FlexBasis = cl.FlexBasis ?? 'Auto';
    child.ChildLayout.Width = cl.Width ?? 'Auto';
    child.ChildLayout.Height = cl.Height ?? 'Auto';
    child.ChildLayout.AlignSelf = cl.AlignSelf ?? 'Auto';
    child.ChildLayout.Margin = cl.Margin ?? [0, 0, 0, 0];
  }

  container.MarkLayoutDirty();
  console.log(`[Jwift] Layout ${index + 1}/5: ${preset.Name}`);
};

// Start with preset 0
applyPreset(0);

// ─── Click to cycle ───

let current = 0;

el.addEventListener('click', () => {
  current = (current + 1) % presets.length;
  applyPreset(current);
});

console.log('[Jwift] Click to cycle through 5 layout presets');
