// Frost diagnostic: a glass panel placed DIRECTLY over high-frequency content
// (a checkerboard + sharp colored bars). A smooth gradient hides blur (nothing
// to blur); a checkerboard makes frost obvious — sharp squares vs milky haze.
import { Canvas, Jiv, LiquidGlass } from 'jaui';

export default async function setup(el: HTMLCanvasElement): Promise<void> {
  const canvas = await Canvas.Create(el);

  // High-frequency backdrop: sharp vertical color bars filling the screen
  // (normal flow, FlexGrow so they stretch). Sharp edges = frost is obvious.
  const root = new Jiv({
    Layout: { Direction: 'Row', Justify: 'Start', Align: 'Stretch' },
    Style: { Background: 'rgb(10,10,14)' },
    ChildLayout: { FlexGrow: 1 },
  });
  const COLORS = ['rgb(255,80,80)', 'rgb(80,200,255)', 'rgb(255,210,60)', 'rgb(120,255,160)', 'rgb(200,120,255)'];
  for (let c = 0; c < 16; c++) {
    root.AddChild(new Jiv({
      Style: { Background: COLORS[c % COLORS.length] },
      // FlexGrow shares width; Align:Stretch on root stretches them to full height.
      ChildLayout: { FlexGrow: 1, FlexShrink: 1, AlignSelf: 'Stretch' },
    }));
  }
  canvas.Root.AddChild(root);

  // Glass panel over the checkerboard — frost should turn the sharp squares into
  // a soft milky wash inside the panel.
  const panel = new Jiv({
    Layout: { Direction: 'Column', Justify: 'Center', Align: 'Center', Padding: '24' },
    Style: { ...LiquidGlass, BorderRadius: '40' },
    ChildLayout: { Position: 'Placed', Left: '220', Top: '160', Width: '360', Height: '280' },
  });
  panel.AddChild(new Jiv({
    Text: 'FROST',
    TextStyle: { FontSize: '22', FontWeight: 700, Color: 'rgba(255,255,255,0.95)', TextAlign: 'Center' },
    ChildLayout: { FlexGrow: 0, Height: '28' },
  }));
  canvas.Root.AddChild(panel);

  canvas.Start();
  requestAnimationFrame(() => { el.dataset.ready = 'true'; });
}
