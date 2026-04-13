import { Canvas, Jiv } from '../src/Core/Jwift';
import { JivAnimator } from '../src/Jiv/Jiv.Animator';
import { AnimationManager } from '../src/Animation/Animation.Manager';

const el = document.getElementById('jwift') as HTMLCanvasElement;
const canvas = new Canvas(el);
const animManager = new AnimationManager();

// Re-render whenever animations step
animManager.OnFrame(() => canvas.RequestFrame());

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
    BorderColor: { R: 1, G: 1, B: 1, A: 0.4 },
    BorderWidth: 1.5,
    BorderBlur: 1.5,
    ShadowColor: { R: 0, G: 0, B: 0, A: 0.35 },
    ShadowBlur: 24,
    ShadowOffsetY: 8,
  },
});

const panelAnim = new JivAnimator(panel);
animManager.Register(panelAnim);

// A smaller pill
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
  },
});

const pillAnim = new JivAnimator(pill);
animManager.Register(pillAnim);

canvas.Root.AddChild(panel);
canvas.Root.AddChild(pill);
canvas.Start();

// ─── Click to animate ───

let expanded = false;

el.addEventListener('click', () => {
  expanded = !expanded;

  if (expanded) {
    panelAnim.SetTargets({ Width: 600, Height: 300 });
    pillAnim.SetTargets({ X: 130, Y: 180, Width: 200 });
  } else {
    panelAnim.SetTargets({ Width: 400, Height: 200 });
    pillAnim.SetTargets({ X: 130, Y: 130, Width: 140 });
  }

  animManager.Kick();
});

console.log('[Jwift] Click the canvas to spring-animate the Jiv');
