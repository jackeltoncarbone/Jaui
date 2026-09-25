import { describe, it, expect } from 'vitest';
import { ScrollManager } from '../src/Scroll/Scroll.Manager';
import { LAYER_TOP } from '../src/Jiv/Jiv.Types';
import type { Jiv } from '../src/Jiv/Jiv';

/**
 * `Layer: Top` takes the pointer ahead of everything, as it paints after everything.
 *
 * The case is the app's: an open menu Placed inside a clipping, scrolled page, and a later sibling of that
 * page (the tab bar) over the menu's foot. A plain Layer is sibling-local, so the tab bar won the press.
 */

type Box = [x: number, y: number, w: number, h: number];
interface Spec { Name: string; Box: Box; Layer?: number; Clips?: boolean; Scroll?: number; Kids?: Spec[] }

const build = (spec: Spec): Jiv => {
  const [X, Y, Width, Height] = spec.Box;
  const node = {
    X, Y, Width, Height, Name: spec.Name, Visible: true,
    Overflow: spec.Scroll !== undefined ? 'Scroll' : 'Visible',
    ClipsChildren: spec.Clips ?? spec.Scroll !== undefined,
    ScrollX: 0, ScrollY: spec.Scroll ?? 0, PointerEvents: 'Auto',
    ChildLayout: { Position: 'Flow' },
    RenderStyle: { Transform: { Rotation: 0, OriginX: 0.5, OriginY: 0.5 }, Layer: spec.Layer ?? 0 },
    Children: (spec.Kids ?? []).map(build), Parent: null,
  } as unknown as Jiv;
  for (const kid of node.Children as Jiv[]) (kid as unknown as { Parent: Jiv }).Parent = node;
  return node;
};

const nameOf = (n: Jiv | null): string => (n as unknown as { Name?: string } | null)?.Name ?? 'null';

const app = (menuLayer: number, present: boolean) => {
  const root = build({
    Name: 'Root', Box: [0, 0, 390, 640],
    Kids: [{
      Name: 'Screen', Box: [0, 0, 390, 640], Clips: true,
      Kids: [
        {
          // Scrolled by 100: the menu's layout box is 100px lower than where it shows.
          Name: 'Page', Box: [0, 0, 390, 640], Scroll: 100,
          Kids: [{
            Name: 'Header', Box: [0, 100, 390, 60], Clips: true,
            Kids: [{ Name: 'Menu', Box: [130, 110, 250, 600], Layer: menuLayer, Kids: [{ Name: 'LastRow', Box: [136, 640, 238, 44] }] }],
          }],
        },
        { Name: 'TabBar', Box: [20, 520, 350, 70], Layer: 5 },
      ],
    }],
  });
  const manager = new ScrollManager(root);
  manager.TopLayerPresent = present;
  return (x: number, y: number): string => nameOf(manager.HitTopmost(x, y));
};

describe('Layer: Top', () => {
  it('a plain Layer stays sealed in its ancestors: the tab bar takes the press', () => {
    expect(app(1, false)(200, 560)).toBe('TabBar');
  });

  it('the top layer takes it, through the scroll offset, past the clipping header', () => {
    expect(app(LAYER_TOP, true)(200, 560)).toBe('LastRow');
    expect(app(LAYER_TOP, true)(200, 300)).toBe('Menu');
  });

  it('outside the menu the ordinary walk answers', () => {
    expect(app(LAYER_TOP, true)(60, 560)).toBe('TabBar');
    expect(app(LAYER_TOP, true)(60, 300)).toBe('Page');
  });
});
