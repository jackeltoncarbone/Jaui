// Depth-as-layering proof. Two overlapping WORLD-space panels:
//   - RED  drawn FIRST (earlier in tree → earlier paint order) at +Z (NEARER).
//   - BLUE drawn SECOND (later paint order) at -Z (FARTHER).
// Under pure painter's order (old behavior), BLUE would cover RED in the overlap
// because it paints last. With depth-as-layering, RED is NEARER so it must
// OCCLUDE BLUE in the overlap — paint order loses to true Z. The overlap region
// reading RED (not BLUE) proves world depth is the layer axis.
import { Canvas, Jiv } from 'jaui';

export default async function setup(el: HTMLCanvasElement): Promise<void> {
  const canvas = await Canvas.Create(el);

  const screen = new Jiv({
    Layout: { Direction: 'Column', Justify: 'Start', Align: 'Start' },
    Style: { Background: 'rgb(20,22,30)' },
    ChildLayout: { FlexGrow: 1 },
  });
  canvas.Root.AddChild(screen);

  // RED — painted FIRST, placed NEARER (+Z). Should win the overlap.
  const red = new Jiv({
    Style: { Background: 'rgb(230,60,60)', BorderRadius: '16', Space: 'World', VisualTranslate: '0 0 120' },
    ChildLayout: { Position: 'Placed', Left: '260', Top: '180', Width: '300', Height: '240' },
  });
  canvas.Root.AddChild(red);

  // BLUE — painted SECOND (would cover RED under painter's order), placed FARTHER
  // (-Z). Depth must keep it BEHIND red in the overlap.
  const blue = new Jiv({
    Style: { Background: 'rgb(70,120,240)', BorderRadius: '16', Space: 'World', VisualTranslate: '0 0 -120' },
    ChildLayout: { Position: 'Placed', Left: '380', Top: '300', Width: '300', Height: '240' },
  });
  canvas.Root.AddChild(blue);

  canvas.Start();
  requestAnimationFrame(() => { el.dataset.ready = 'true'; });
}
