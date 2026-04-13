import { Canvas, Jiv } from '../src/Core/Jwift';

const el = document.getElementById('jwift') as HTMLCanvasElement;
const canvas = new Canvas(el);

// ─── A Jiv! ───

const panel = new Jiv({
  X: 100,
  Y: 100,
  Width: 400,
  Height: 200,
  Style: {
    BorderRadius: [32, 32, 32, 32],
    Smoothness: 0.6,
    Background: { R: 1, G: 1, B: 1, A: 0.08 },

    // Border — subtle white edge
    BorderColor: { R: 1, G: 1, B: 1, A: 0.4 },
    BorderWidth: 1.5,
    BorderBlur: 1.5,

    // Shadow — soft drop
    ShadowColor: { R: 0, G: 0, B: 0, A: 0.35 },
    ShadowBlur: 24,
    ShadowOffsetX: 0,
    ShadowOffsetY: 8,
  },
});

// A smaller nested pill
const pill = new Jiv({
  X: 130,
  Y: 130,
  Width: 140,
  Height: 48,
  Style: {
    BorderRadius: [100, 100, 100, 100],
    Smoothness: 0.6,
    Background: { R: 1, G: 1, B: 1, A: 0.12 },
    BorderColor: { R: 1, G: 1, B: 1, A: 0.3 },
    BorderWidth: 1,
    BorderBlur: 0,
  },
});

canvas.Root.AddChild(panel);
canvas.Root.AddChild(pill);
canvas.Start();

console.log('[Jwift] Playground running — you should see a Jiv');
