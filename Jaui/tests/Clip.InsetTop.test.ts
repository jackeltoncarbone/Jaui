// ClipInsetTop (Drill Sentences lane R36, item 1; a round 34 blind phone tester, 10-3b-settled.png: a faint streak of letters
// along a pinned heading's top edge). A scroller's pinned heading stood at the scroller's top, so the rows were cut on its
// very outline: the half covered pixel row under the glass's edge, and its rim, read the cut words sharp. The scroller now
// cuts its children a length inside its top edge, the heading escapes that clip (ParentOverflow: Visible) and stands where
// it stood, and the rows are cut under its glass, never on its outline.
import { describe, it, expect } from 'vitest';
import { Canvas } from '@jaui/Core/Jaui';
import type { Renderer } from '@jaui/Core/Renderer';
import { BrowserPlatform } from '@jaui/Core/Platform';
import { ResolveStyle, SEED_CONTEXT } from '@jaui/Core/Style.Resolver';
import { DefaultJivStyle } from '@jaui/Jiv/Jiv.Defaults';
import { Jiv } from '@jaui/Jiv/Jiv';
import { SlotFor } from '@jaui/Jss/Jss.Routes';
import { MAT_IDENTITY } from '@jaui/Transform/Mat2x3';

const nullRenderer = (): Renderer =>
  new Proxy({}, { get: (_t, key) => (key === 'then' ? undefined : () => undefined) }) as unknown as Renderer;

const canvas = (): Canvas => {
  const platform = { ...BrowserPlatform, GetUrlSearch: (): string => '' };
  const c = new Canvas(new OffscreenCanvas(400, 300) as unknown as HTMLCanvasElement, nullRenderer(), platform);
  c.SetSizePx(400, 300);
  return c;
};

interface ClipShapeLike { X: number; Y: number; W: number; H: number; CenterX: number; CenterY: number }
type Internals = {
  _boxClip: (node: Jiv, m: typeof MAT_IDENTITY) => ClipShapeLike;
  _childClip: (parent: Jiv, stack: ClipShapeLike[], box: ClipShapeLike, child: Jiv) => ClipShapeLike[];
};

const list = (insetTop: string): Jiv => {
  const node = new Jiv({ X: 10, Y: 100, Width: 300, Height: 400, Overflow: 'Scroll', Style: { ClipInsetTop: insetTop } });
  node.RenderStyle = ResolveStyle({ ...DefaultJivStyle, ClipInsetTop: insetTop }, SEED_CONTEXT);
  return node;
};

describe('ClipInsetTop', () => {
  it('is a style property, 0 by default, resolved as a length', () => {
    expect(SlotFor('ClipInsetTop')).toBe('Style');
    expect(ResolveStyle({ ...DefaultJivStyle }, SEED_CONTEXT).ClipInsetTop).toBe(0);
    expect(ResolveStyle({ ...DefaultJivStyle, ClipInsetTop: '2px' }, SEED_CONTEXT).ClipInsetTop).toBe(2);
  });

  it('moves only the clip\'s top edge in: its sides and bottom stay the box\'s', () => {
    const c = canvas() as unknown as Internals;
    const flush = c._boxClip(list('0'), MAT_IDENTITY);
    expect([flush.X, flush.Y, flush.W, flush.H]).toEqual([10, 100, 300, 400]);
    const inset = c._boxClip(list('2px'), MAT_IDENTITY);
    expect([inset.X, inset.Y, inset.W, inset.H]).toEqual([10, 102, 300, 398]);
    expect(inset.Y + inset.H).toBe(flush.Y + flush.H);
    expect(inset.CenterY).toBe(102 + 398 / 2);
  });

  it('never inverts the box, however far it is asked in', () => {
    const c = canvas() as unknown as Internals;
    const all = c._boxClip(list('900px'), MAT_IDENTITY);
    expect(all.H).toBe(0);
    expect(all.Y).toBe(500);
  });

  it('a pinned heading that escapes it (ParentOverflow: Visible) is not cut by it; a row is', () => {
    const c = canvas() as unknown as Internals;
    const parent = list('2px');
    const box = c._boxClip(parent, MAT_IDENTITY);
    const heading = new Jiv({ ChildLayout: { Position: 'Pinned', ParentOverflow: 'Visible' } as never });
    const row = new Jiv({});
    expect(c._childClip(parent, [], box, heading)).toEqual([]);
    expect(c._childClip(parent, [], box, row)).toEqual([box]);
  });
});
