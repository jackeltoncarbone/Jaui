// Interaction isolation test. A row of buttons (solid + glass) with OnClick and
// hover. Clicking sets a global so a Playwright harness can assert the engine's
// hit-test + OnClick fire (and on GLASS too). Proves interaction works at the
// engine level, independent of any specific page's wiring.
import { Canvas, Jiv, LiquidGlass } from 'jaui';

declare global { interface Window { __clicks: string[]; __hovers: string[]; } }

export default async function setup(el: HTMLCanvasElement): Promise<void> {
  const canvas = await Canvas.Create(el);
  window.__clicks = [];
  window.__hovers = [];

  const root = new Jiv({
    Layout: { Direction: 'Column', Justify: 'Center', Align: 'Center', Gap: '24' },
    Style: { Background: 'rgb(16,18,26)' },
    ChildLayout: { FlexGrow: 1 },
  });

  const row = new Jiv({
    Layout: { Direction: 'Row', Justify: 'Center', Align: 'Center', Gap: '20' },
    ChildLayout: { FlexGrow: 0, Height: '80' },
  });

  const mk = (label: string, glass: boolean): Jiv => {
    const btn = new Jiv({
      Layout: { Direction: 'Column', Justify: 'Center', Align: 'Center', Padding: '0 28' },
      Style: glass
        ? { ...LiquidGlass, BorderRadius: '20' }
        : { Background: 'rgb(40,44,60)', BorderRadius: '20' },
      ChildLayout: { FlexGrow: 0, FlexShrink: 0, Width: '160', Height: '64' },
    });
    btn.AddChild(new Jiv({
      Text: label,
      TextStyle: { FontSize: '16', FontWeight: 600, Color: 'rgba(255,255,255,0.95)', TextAlign: 'Center' },
      ChildLayout: { FlexGrow: 0, Height: '20' },
    }));
    btn.OnClick = () => { window.__clicks.push(label); };
    btn.OnPointerMove = () => { if (!window.__hovers.includes(label)) window.__hovers.push(label); };
    return btn;
  };

  row.AddChild(mk('Solid', false));
  row.AddChild(mk('Glass', true));
  root.AddChild(row);
  canvas.Root.AddChild(root);

  canvas.Start();
  requestAnimationFrame(() => { el.dataset.ready = 'true'; });
}
