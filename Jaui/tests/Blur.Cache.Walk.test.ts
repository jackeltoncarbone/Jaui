/**
 * `?blur-cache` THROUGH THE REAL WALK: which builds a clean backdrop skips, which it does not, and
 * what each arm binds.
 *
 * REAL -- the walk, the flex solver, `_glassFillBlurPlan`, the instance funnels the paint records
 * hash, the reader decision and the flag's refusal chain. One `RenderHeadless` is one real frame of
 * the engine against a recording renderer whose prototype is `WebGL2Renderer.prototype` (every
 * blur arm gates on `instanceof`, so a fake that failed it could only ever measure the refusal).
 *
 * NOT HERE -- a rasteriser. Nothing below proves a texel; it proves WHICH pyramid each glass draw
 * binds and WHEN one was built. The verify arm on a GPU is the proof that the audit is complete.
 */
import { describe, it, expect } from 'vitest';
import { Canvas, type BlurCacheCensus } from '@jaui/Core/Jaui';
import type { Renderer } from '@jaui/Core/Renderer';
import { WebGL2Renderer } from '@jaui/Core/WebGL2.Renderer';
import { BrowserPlatform } from '@jaui/Core/Platform';
import { Jiv } from '@jaui/Jiv/Jiv';

const W = 1280;
const H = 800;
const CLEAR = 'rgba(0, 0, 0, 0)';

interface Region { ScaleX: number; ScaleY: number; OffsetX: number; OffsetY: number; TexelsX: number; TexelsY: number }
interface Handle { Id: number; Region?: Region; Cached?: boolean }
interface Slot { Valid: boolean; LastUse: number; Handle: Handle | null; Texture: object | null }
type Event =
  | { Kind: 'blur'; Handle: Handle }
  | { Kind: 'store'; From: number }
  | { Kind: 'compare'; A: Handle; B: Handle }
  | { Kind: 'release' }
  | { Kind: 'draw'; Handle: Handle | null; Site: 'fill' | 'rim' | 'panel' };

const recorder = (log: Event[], opts: { Mismatch?: () => number } = {}) => {
  let seq = 0;
  const mutable: Record<string, unknown> = {
    DiagNoBlur: false, DiagBlurDummy: false, DiagBlurSrc: null,
    CardCompositeEnabled: false, DiagNoDepth: false, DiagSnapOnce: false,
    ShadowSnap: false, ShadowSnapped: 0,
  };
  const counts = { Hit: 0, Miss: 0, Verified: 0, Mismatches: 0 };
  const fixed: Record<string, unknown> = {
    SceneTexture: { Id: 0 },
    CardActive: false,
    GetGL: () => null,
    BeginCardComposite: () => false,
    SnapshotScreen: () => null,
    PaceTakeFence: () => null,
    PaceInFlight: () => 0,
    MeasureShadowBackdrop: () => -1,
    // The handle carries the region map `BlurPass._region` would: the cache tests next frame against
    // the rect a build READ, and reads it back off this map.
    ComputeBlur: (_in: unknown, w: number, h: number, _radius: number, _min: unknown,
      region?: { x: number; y: number; w: number; h: number }): Handle => {
      const r = region ?? { x: 0, y: 0, w, h };
      const handle: Handle = {
        Id: ++seq,
        Region: {
          ScaleX: w / r.w, ScaleY: h / r.h, OffsetX: -r.x / r.w, OffsetY: -(h - r.y - r.h) / r.h,
          TexelsX: r.w, TexelsY: r.h,
        },
      };
      log.push({ Kind: 'blur', Handle: handle });
      return handle;
    },
    PanelDrawBatch: (...args: unknown[]): void => {
      const backdrop = args[2] as Handle | null;
      const site = args.length >= 10 ? 'fill' : args[6] === true ? 'rim' : 'panel';
      log.push({ Kind: 'draw', Handle: backdrop, Site: site });
    },
    BlurCacheStore: (src: Handle, slot: Slot | null, frame: number): Slot => {
      const s: Slot = slot ?? { Valid: false, LastUse: 0, Handle: null, Texture: {} };
      s.Valid = true;
      s.LastUse = frame;
      s.Texture = s.Texture ?? {};
      s.Handle = { Id: ++seq, Region: src.Region, Cached: true };
      log.push({ Kind: 'store', From: src.Id });
      return s;
    },
    BlurCacheRelease: (s: Slot): void => { s.Valid = false; s.Handle = null; s.Texture = null; log.push({ Kind: 'release' }); },
    BlurCacheCompare: (a: Handle, b: Handle): number => { log.push({ Kind: 'compare', A: a, B: b }); return opts.Mismatch?.() ?? 0; },
    NoteBlurCacheHit: (): void => { counts.Hit++; },
    NoteBlurCacheMiss: (): void => { counts.Miss++; },
    NoteBlurCacheVerify: (m: boolean): void => { counts.Verified++; if (m) counts.Mismatches++; },
    BlurCacheBytes: 0, BlurCacheSlots: 0, BlurCacheBudgetBytes: 48 * 1024 * 1024, BlurCacheReadKind: 'test',
    BlurCacheCensus: { Evictions: 0, Refused: 0, Verified: 0, Mismatches: 0 },
    GroupBuilds: 0, GroupMembers: 0, GroupFallbacks: 0,
    SceneEndsByKey: {}, SceneSwitches: 0, SceneReads: 0, SceneRestarts: 0,
    SceneAtlasDraws: 0, BlurPoolCensus: 'none', BackdropBuildSeq: 0,
    BordersFromFill: 0, BordersRimBuilt: 0, PresampledBuilds: 0, LastPresampleK: 1,
  };
  const target = Object.create(WebGL2Renderer.prototype) as object;
  const proxy = new Proxy(target, {
    get: (_t, key) => {
      if (key === 'then') return undefined;
      const k = key as string;
      if (k in fixed) return fixed[k];
      if (k in mutable) return mutable[k];
      return () => undefined;
    },
    set: (_t, key, value) => { mutable[key as string] = value; return true; },
  });
  return { Renderer: proxy as unknown as Renderer, Counts: counts };
};

const placed = (left: number, top: number, width: number, height: number, style: Record<string, string>): Jiv =>
  new Jiv({
    ChildLayout: { Position: 'Placed', Left: `${left}pt`, Top: `${top}pt`, Width: `${width}pt`, Height: `${height}pt` },
    Style: { Opacity: '1', ...style },
  });

const glass = (left: number, top: number): Jiv => placed(left, top, 200, 120, {
  Background: CLEAR, Thickness: '2.5', Refraction: '8', BackdropFilter: 'Blur(4pt)', BorderRadius: '16pt',
});

interface Scene {
  Canvas: Canvas;
  Log: Event[];
  Counts: ReturnType<typeof recorder>['Counts'];
  /** Behind card A, inside its sample region, painted BEFORE it. */
  Near: Jiv;
  /** Far from every card, painted before them. */
  Far: Jiv;
  /** Over card A, painted AFTER it. */
  Over: Jiv;
  A: Jiv; B: Jiv; C: Jiv;
  Screen: Jiv;
  Frame: () => { Builds: number; Stores: number; Compares: number; Fills: Event[]; Census: BlurCacheCensus };
}

/** Three glass cards over an opaque bed. Each card sits in its own wrapper so `?glass-group` (on by
 *  default) finds three runs of ONE -- the phone's home page, `groups=0 solo=6` -- and builds solo. */
const scene = (search: string, opts: { Mismatch?: () => number; Siblings?: boolean; Rims?: boolean } = {}): Scene => {
  const log: Event[] = [];
  const rec = recorder(log, opts);
  const platform = { ...BrowserPlatform, GetUrlSearch: (): string => search };
  const c = new Canvas(new OffscreenCanvas(W, H) as unknown as HTMLCanvasElement, rec.Renderer, platform);
  c.SetSizePx(W, H);
  const screen = new Jiv({
    ChildLayout: { Position: 'Fixed', Top: '0pt', Left: '0pt', Width: '100vw', Height: '100vh' },
    Style: { PointScale: '1', Background: 'rgb(30, 40, 50)', Opacity: '1' },
  });
  const near = placed(60, 60, 40, 40, { Background: 'rgb(200, 30, 30)' });
  const far = placed(900, 600, 40, 40, { Background: 'rgb(30, 200, 30)' });
  screen.AddChild(near);
  screen.AddChild(far);
  const wrap = (card: Jiv): Jiv => {
    if (opts.Siblings) return card;
    const w = placed(0, 0, W, H, { Background: CLEAR });
    w.AddChild(card);
    return w;
  };
  // Siblings sit 20pt apart in a row, as glass-grid's cards do, so the group planner finds a union
  // worth building; the default layout spreads them where no union would pay.
  const a = glass(40, 40);
  const b = opts.Siblings ? glass(260, 40) : glass(500, 40);
  const cc = opts.Siblings ? glass(480, 40) : glass(40, 450);
  if (opts.Rims) {
    // `BorderLayer` past every child makes the rim a SEPARATE overlay drawn after the card's children,
    // which under `?border-source=fill` (the default) binds the fill's own pyramid.
    for (const card of [a, b, cc]) {
      Object.assign(card.Style, { BorderWidth: '0.45pt', BorderColor: 'rgba(255, 255, 255, 0.35)', BorderLayer: '10' });
      card.AddChild(new Jiv({ Text: 'Label', Style: { Background: CLEAR, Opacity: '1' } }));
    }
  }
  screen.AddChild(wrap(a));
  screen.AddChild(wrap(b));
  screen.AddChild(wrap(cc));
  const over = placed(70, 70, 30, 30, { Background: 'rgb(30, 30, 200)' });
  screen.AddChild(over);
  c.Root.AddChild(screen);
  let t = 1000;
  const frameOnce = (): ReturnType<Scene['Frame']> => {
    log.length = 0;
    c.RequestFrame();
    c.RenderHeadless((t += 16));
    const census = (globalThis as unknown as { __jauiBlurCache: () => BlurCacheCensus }).__jauiBlurCache();
    return {
      Builds: log.filter((e) => e.Kind === 'blur').length,
      Stores: log.filter((e) => e.Kind === 'store').length,
      Compares: log.filter((e) => e.Kind === 'compare').length,
      Fills: log.filter((e) => e.Kind === 'draw' && e.Site === 'fill'),
      Census: census,
    };
  };
  return { Canvas: c, Log: log, Counts: rec.Counts, Near: near, Far: far, Over: over, A: a, B: b, C: cc, Screen: screen, Frame: frameOnce };
};

/** Frames until every spring the setup kicked has settled and the records stop moving. */
const settle = (s: Scene): void => { for (let i = 0; i < 120; i++) s.Frame(); };

describe('?blur-cache -- the flag', () => {
  it('is ON by default, and ?blur-cache=off is the control: no record, no store, every surface builds every frame', () => {
    expect(scene('').Frame().Census.Armed).toBe('on');
    const s = scene('?blur-cache=off');
    settle(s);
    const f = s.Frame();
    expect(f.Census.Armed).toBe('off');
    expect(f.Builds).toBe(3);
    expect(f.Stores).toBe(0);
    expect(s.Counts.Hit + s.Counts.Miss).toBe(0);
    // ...and the instance funnels are the ones it shipped with: nothing is wrapped on an unarmed canvas.
    const funnels = s.Canvas as unknown as { _panelBuffer: { Push: () => void }; _textBuffer: { Push: () => void } };
    expect(String(funnels._panelBuffer.Push)).not.toContain('_bcNotePanel');
    expect(String(funnels._textBuffer.Push)).not.toContain('_bcNoteText');
    const armed = scene('?blur-cache=on').Canvas as unknown as typeof funnels;
    expect(String(armed._panelBuffer.Push)).toContain('_bcNotePanel');
  });

  it('refuses beside the arms it cannot stand, by name', () => {
    const s = scene('?blur-cache=on&glass-gaussian=on');
    expect(s.Frame().Census).toMatchObject({ Armed: 'off', Refused: 'glass-gaussian-reads-the-scene-past-the-read-guard' });
    const t = scene('?blur-cache=on&wkr-shared-backdrop');
    expect(t.Frame().Census.Refused).toBe('shared-backdrop-builds-one-canvas-pyramid-this-cache-does-not-key');
  });

  it('throws on a value it does not know rather than arming a default', () => {
    expect(() => scene('?blur-cache=1')).toThrow(/blur-cache takes/);
  });
});

describe('?blur-cache=on -- what a clean backdrop buys', () => {
  it('first sight builds, the next frame builds and KEEPS, every frame after builds nothing', () => {
    const s = scene('?blur-cache=on');
    settle(s);
    const f = s.Frame();
    expect(f.Census.Armed).toBe('on');
    expect(f.Builds).toBe(0);
    expect(f.Census.Frame).toMatchObject({ Surfaces: 3, Hits: 3, Misses: 0, DirtyPx: 0, Resting: true, Vacuous: false, Untracked: 0 });
    // Every fill draw binds a CACHED pyramid.
    expect(f.Fills.length).toBe(3);
    for (const d of f.Fills) expect((d as { Handle: Handle }).Handle.Cached).toBe(true);
  });

  it('warms in exactly two frames from a cold start', () => {
    const s = scene('?blur-cache=on');
    // Let layout and every spring finish with the cache in whatever state, then force a cold start.
    settle(s);
    const priv = s.Canvas as unknown as { _bc: { Reset: () => void } };
    priv._bc.Reset();
    const f1 = s.Frame();
    expect([f1.Builds, f1.Stores]).toEqual([3, 0]);
    expect(f1.Census.Frame?.Dirty.first).toBe(3);
    const f2 = s.Frame();
    expect([f2.Builds, f2.Stores]).toEqual([3, 3]);
    expect(f2.Census.Frame?.Cold).toBe(3);
    const f3 = s.Frame();
    expect([f3.Builds, f3.Stores]).toEqual([0, 0]);
  });

  it('a change UNDER one card rebuilds that card and no other', () => {
    const s = scene('?blur-cache=on');
    settle(s);
    s.Near.Style.Background = 'rgb(10, 220, 90)';
    s.Near.MarkStyleDirty();
    const f = s.Frame();
    expect(f.Census.Frame).toMatchObject({ Hits: 2, Misses: 1 });
    expect(f.Census.Frame?.Dirty.damage).toBe(1);
    expect(f.Builds).toBe(1);
    // ...and once it stops changing, it warms and hits again.
    settle(s);
    expect(s.Frame().Builds).toBe(0);
  });

  it('a change far from every card rebuilds nothing -- the video beside five static cards', () => {
    const s = scene('?blur-cache=on');
    settle(s);
    s.Far.Style.Background = 'rgb(250, 250, 10)';
    s.Far.MarkStyleDirty();
    const f = s.Frame();
    expect(f.Census.Frame?.Changed).toBeGreaterThan(0);
    expect(f.Census.Frame?.DirtyPx).toBeGreaterThan(0);
    expect(f.Builds).toBe(0);
    expect(f.Census.Frame?.Hits).toBe(3);
  });

  it('a change painted OVER a card, after it, is not in its backdrop', () => {
    const s = scene('?blur-cache=on');
    settle(s);
    s.Over.Style.Background = 'rgb(250, 120, 10)';
    s.Over.MarkStyleDirty();
    const f = s.Frame();
    expect(f.Census.Frame?.Changed).toBeGreaterThan(0);
    expect(f.Builds).toBe(0);
  });

  it('content APPEARING before the cards dirties every card after it (the prefix), then warms', () => {
    const s = scene('?blur-cache=on');
    settle(s);
    // A child of `Near` paints after it and before every card, far from all their regions.
    s.Near.AddChild(placed(1100, 20, 4, 4, { Background: 'rgb(255, 255, 255)' }));
    const f = s.Frame();
    expect(f.Census.Frame?.Hits).toBe(0);
    expect(f.Census.Frame?.Dirty.prefix).toBe(3);
    settle(s);
    expect(s.Frame().Builds).toBe(0);
  });

  it('a card that MOVES misses on its key and its old and new footprints are damage', () => {
    const s = scene('?blur-cache=on');
    settle(s);
    s.A.ChildLayout.Left = '60pt';
    s.A.MarkLayoutDirty();
    // The move springs in over frames. Every frame of it, A's region moves (a `key` miss) and its
    // old and new footprints are damage; B and C are nowhere near either and keep hitting.
    let keyMisses = 0;
    for (let i = 0; i < 8; i++) {
      const f = s.Frame();
      keyMisses += f.Census.Frame?.Dirty.key ?? 0;
      expect(f.Census.Frame?.Hits).toBeGreaterThanOrEqual(2);
    }
    expect(keyMisses).toBeGreaterThanOrEqual(3);
  });

  it('a resize is the whole canvas', () => {
    const s = scene('?blur-cache=on');
    settle(s);
    s.Canvas.SetSizePx(W - 10, H);
    const f = s.Frame();
    expect(f.Census.Frame?.Hits).toBe(0);
    expect(f.Census.Frame?.Seeded).toBe(true);
  });
});

describe('?blur-cache=on -- the shapes it names rather than wins', () => {
  it("glass-group members take the group's pyramid: counted `grouped`, never hit, never stored", () => {
    const s = scene('?blur-cache=on', { Siblings: true });
    settle(s);
    const f = s.Frame();
    expect(f.Census.Frame).toMatchObject({ Grouped: 3, Surfaces: 0, Hits: 0 });
    expect(f.Census.Frame?.Fresh.group).toBe(3);
    expect(f.Stores).toBe(0);
    // `?glass-group=off` is the same page building solo, and it caches.
    const off = scene('?blur-cache=on&glass-group=off', { Siblings: true });
    settle(off);
    expect(off.Frame().Census.Frame).toMatchObject({ Grouped: 0, Surfaces: 3, Hits: 3 });
  });

  it("a rim that binds its fill's pyramid rides the fill's hit: no rim build, the rim draws the cached copy", () => {
    // ARMED, because this cell's whole subject is the fill arm -- 'a rim that BINDS ITS FILL'S pyramid'.
    // It stopped being the default on 2026-09-21 (Border.FromFill.test.ts records the ruling: on an
    // avatar the shortcut samples the wall behind the photo rather than the photo), and under `scene` a
    // rim builds its own pyramid, so there is no fill hit to ride and Hits reads 6 instead of 3.
    const s = scene('?blur-cache=on&border-source=fill', { Rims: true });
    settle(s);
    const f = s.Frame();
    expect(f.Builds).toBe(0);
    expect(f.Census.Frame).toMatchObject({ Hits: 3, Resting: true });
    const rims = s.Log.filter((e) => e.Kind === 'draw' && e.Site === 'rim');
    expect(rims.length).toBe(3);
    for (const d of rims) expect((d as { Handle: Handle }).Handle.Cached).toBe(true);
  });

  it('a font refresh moves the seed: every glyph may have been re-rastered under the same UVs', () => {
    const s = scene('?blur-cache=on');
    settle(s);
    s.Canvas.RefreshFonts();
    const f = s.Frame();
    expect(f.Census.Frame?.Seeded).toBe(true);
    expect(f.Census.Frame?.Hits).toBe(0);
  });
});

describe('?blur-cache=verify -- the arm that makes it shippable', () => {
  it('builds anyway on every hit, compares, and binds the FRESH pyramid', () => {
    const s = scene('?blur-cache=verify');
    settle(s);
    const f = s.Frame();
    expect(f.Census.Frame?.Hits).toBe(3);
    expect(f.Builds).toBe(3);
    expect(f.Compares).toBe(3);
    for (const d of f.Fills) expect((d as { Handle: Handle }).Handle.Cached).toBeUndefined();
    expect(s.Counts.Mismatches).toBe(0);
  });

  it('a mismatch is counted, the slot is refilled from the fresh build, and the picture is the fresh one', () => {
    let bad = 0;
    const s = scene('?blur-cache=verify', { Mismatch: () => (bad-- > 0 ? 12 : 0) });
    settle(s);
    bad = 1;
    const f = s.Frame();
    expect(s.Counts.Mismatches).toBe(1);
    expect(f.Stores).toBe(1);
    for (const d of f.Fills) expect((d as { Handle: Handle }).Handle.Cached).toBeUndefined();
  });
});
