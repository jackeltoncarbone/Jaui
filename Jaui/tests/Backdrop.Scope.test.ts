/**
 * `BackdropScope` (Core/Glass.Jss.md 5): `BackdropRoot: true` on an ancestor bounds what a
 * descendant's `BackdropScope: Parent | Root` backdrop can see. `Page` (the default, unauthored)
 * is today's whole-scene-so-far read and must stay byte-for-byte unchanged.
 *
 * REAL walk for the parsing/resolving/no-inheritance/fallback/refusal/sharing/cache-hit proofs
 * (`Canvas.RenderHeadless` against a recording renderer, `Blur.Cache.Walk.test.ts`'s own pattern —
 * see that file's header for why this is not a rasteriser). `GetGL` returns null here, so a scoped
 * element's own re-walk capture always takes its documented no-GL fallback (Page's `SceneTexture`)
 * rather than exercising the real GPU path; what these tests prove is the DECISION each surface
 * makes (which reader kind, which cache, whether it renders at all, whether inheritance leaks) —
 * the same level Blur.Cache.Walk.test.ts itself proves cross-frame caching at.
 */
import { describe, it, expect, vi } from 'vitest';
import { Canvas, type BlurCacheCensus } from '@jaui/Core/Jaui';
import type { Renderer } from '@jaui/Core/Renderer';
import { WebGL2Renderer } from '@jaui/Core/WebGL2.Renderer';
import { BrowserPlatform } from '@jaui/Core/Platform';
import { Jiv } from '@jaui/Jiv/Jiv';
import { ResolveStyle, SEED_CONTEXT } from '@jaui/Core/Style.Resolver';
import { DefaultJivStyle } from '@jaui/Jiv/Jiv.Defaults';

const W = 800;
const H = 600;
const CLEAR = 'rgba(0, 0, 0, 0)';

interface Handle { Id: number; Region?: unknown }
type Event =
  | { Kind: 'blur'; Handle: Handle }
  | { Kind: 'draw'; Handle: Handle | null; Site: 'fill' | 'rim' | 'panel' };

/** A recording `WebGL2Renderer`-shaped renderer, trimmed from `Blur.Cache.Walk.test.ts`'s own —
 *  same `instanceof` trick (every blur arm gates on it), same no-GL fallback (`GetGL: () => null`),
 *  same cache plumbing (`BlurCacheStore`/`NoteBlurCacheHit`/etc., which `_bcBuild` calls on every
 *  reader kind, `READER_SCOPED` included). */
const recorder = (log: Event[]) => {
  let seq = 0;
  const mutable: Record<string, unknown> = {
    DiagNoBlur: false, DiagBlurDummy: false, DiagBlurSrc: null,
    CardCompositeEnabled: false, DiagSnapOnce: false,
  };
  const counts = { Hit: 0, Miss: 0 };
  const fixed: Record<string, unknown> = {
    SceneTexture: { Id: 0 },
    CardActive: false,
    GetGL: () => null,
    BeginCardComposite: () => false,
    SnapshotScreen: () => null,
    BuildSharedBackdrop: (): Handle => ({ Id: ++seq }),
    PaceTakeFence: () => null,
    PaceInFlight: () => 0,
    MeasureShadowBackdrop: () => -1,
    ComputeBlur: (_in: unknown, w: number, h: number, _radius: number, _min: unknown,
      region?: { x: number; y: number; w: number; h: number }): Handle => {
      const r = region ?? { x: 0, y: 0, w, h };
      const handle: Handle = {
        Id: ++seq,
        Region: { ScaleX: w / r.w, ScaleY: h / r.h, OffsetX: -r.x / r.w, OffsetY: -(h - r.y - r.h) / r.h, TexelsX: r.w, TexelsY: r.h },
      };
      log.push({ Kind: 'blur', Handle: handle });
      return handle;
    },
    // A draw that binds a non-null backdrop (arg 2, `lastBackdrop`) is a glass/backdrop-filter FILL
    // — the one thing every test below cares about (which handle it bound), regardless of the
    // material's exact site label.
    PanelDrawBatch: (...args: unknown[]): void => {
      const backdrop = (args[2] ?? null) as Handle | null;
      if (backdrop !== null) log.push({ Kind: 'draw', Handle: backdrop, Site: 'fill' });
    },
    BlurCacheStore: (src: Handle, slot: { Valid: boolean; LastUse: number; Handle: Handle | null } | null, frame: number) => {
      const s = slot ?? { Valid: false, LastUse: 0, Handle: null };
      s.Valid = true;
      s.LastUse = frame;
      s.Handle = { Id: src.Id, Region: src.Region };
      return s;
    },
    BlurCacheRelease: (s: { Valid: boolean; Handle: Handle | null }): void => { s.Valid = false; s.Handle = null; },
    BlurCacheCompare: (): number => 0,
    NoteBlurCacheHit: (): void => { counts.Hit++; },
    NoteBlurCacheMiss: (): void => { counts.Miss++; },
    NoteBlurCacheVerify: (): void => {},
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

const scopedCard = (left: number, top: number, scope: 'Page' | 'Parent' | 'Root'): Jiv => placed(left, top, 120, 80, {
  Background: CLEAR, Thickness: '2.5', Refraction: '8', BackdropFilter: 'Blur(4pt)', BorderRadius: '12pt',
  BackdropScope: scope,
});

interface Scene {
  Canvas: Canvas;
  Log: Event[];
  Frame: () => { Builds: number; Fills: Event[]; Census: BlurCacheCensus };
}

/** One frame of a scene built from `build(screen)`, which adds whatever the test needs under a
 *  fixed-size root. */
const scene = (search: string, build: (screen: Jiv) => void): Scene => {
  const log: Event[] = [];
  const rec = recorder(log);
  const platform = { ...BrowserPlatform, GetUrlSearch: (): string => search };
  const c = new Canvas(new OffscreenCanvas(W, H) as unknown as HTMLCanvasElement, rec.Renderer, platform);
  c.SetSizePx(W, H);
  const screen = new Jiv({
    ChildLayout: { Position: 'Fixed', Top: '0pt', Left: '0pt', Width: '100vw', Height: '100vh' },
    Style: { PointScale: '1', Background: 'rgb(30, 40, 50)', Opacity: '1' },
  });
  build(screen);
  c.Root.AddChild(screen);
  let t = 1000;
  const frameOnce = (): ReturnType<Scene['Frame']> => {
    log.length = 0;
    c.RequestFrame();
    c.RenderHeadless((t += 16));
    const census = (globalThis as unknown as { __jauiBlurCache: () => BlurCacheCensus }).__jauiBlurCache();
    return {
      Builds: log.filter((e) => e.Kind === 'blur').length,
      Fills: log.filter((e) => e.Kind === 'draw' && e.Site === 'fill'),
      Census: census,
    };
  };
  return { Canvas: c, Log: log, Frame: frameOnce };
};

const settle = (s: Scene): void => { for (let i = 0; i < 4; i++) s.Frame(); };

describe('BackdropScope — parsing and resolving (Core/Glass.Jss.md 5)', () => {
  it('defaults to BackdropRoot false, BackdropScope Page', () => {
    const rs = ResolveStyle({ ...DefaultJivStyle }, SEED_CONTEXT);
    expect(rs.BackdropRoot).toBe(false);
    expect(rs.BackdropScope).toBe('Page');
  });

  it('resolves BackdropRoot as a plain per-node boolean, like Isolate', () => {
    expect(ResolveStyle({ ...DefaultJivStyle, BackdropRoot: 'true' }, SEED_CONTEXT).BackdropRoot).toBe(true);
    expect(ResolveStyle({ ...DefaultJivStyle, BackdropRoot: 'false' }, SEED_CONTEXT).BackdropRoot).toBe(false);
  });

  it('resolves BackdropScope Page | Parent | Root', () => {
    expect(ResolveStyle({ ...DefaultJivStyle, BackdropScope: 'Parent' }, SEED_CONTEXT).BackdropScope).toBe('Parent');
    expect(ResolveStyle({ ...DefaultJivStyle, BackdropScope: 'Root' }, SEED_CONTEXT).BackdropScope).toBe('Root');
    expect(ResolveStyle({ ...DefaultJivStyle, BackdropScope: 'Page' }, SEED_CONTEXT).BackdropScope).toBe('Page');
  });

  it('throws on a value it does not know, by name', () => {
    expect(() => ResolveStyle({ ...DefaultJivStyle, BackdropScope: 'Ancestor' }, SEED_CONTEXT)).toThrow(/BackdropScope/);
  });

  it('never inherits: a child under a BackdropRoot ancestor resolves its OWN default unless authored', () => {
    const root = new Jiv({ Style: { BackdropRoot: 'true', Opacity: '1' } });
    const child = new Jiv({});
    root.AddChild(child);
    expect(root.RenderStyle.BackdropRoot).toBe(true);
    expect(child.RenderStyle.BackdropRoot).toBe(false);
    expect(child.RenderStyle.BackdropScope).toBe('Page');
  });

  it('the gap: BackdropFilter LinearProgressiveBlur()/EdgeProgressiveBlur() now resolves (Style.Resolver.ts)', () => {
    const rs = ResolveStyle({ ...DefaultJivStyle, BackdropFilter: 'EdgeProgressiveBlur(24pt, 8pt)' }, SEED_CONTEXT);
    expect(rs.Material).toBe('ProgressiveBlur');
    expect(rs.ProgressiveBlurStops).not.toBeNull();
    expect(rs.BackdropFrostBlur).toBeGreaterThan(0);
    // Filter (foreground) still wins when a node authors both.
    const both = ResolveStyle({
      ...DefaultJivStyle, BackdropFilter: 'EdgeProgressiveBlur(24pt, 8pt)', Filter: 'LinearProgressiveBlur(Top, 40pt)',
    }, SEED_CONTEXT);
    expect(both.ProgressiveBlurDirection).toBe('ToTop');
  });
});

describe('BackdropScope — the walk (Core/Jaui.ts)', () => {
  it('Page (unauthored) renders exactly as before: one fill, one build', () => {
    const s = scene('', (screen) => screen.AddChild(scopedCard(40, 40, 'Page')));
    settle(s);
    const f = s.Frame();
    expect(f.Fills.length).toBe(1);
  });

  it('Root with no BackdropRoot ancestor anywhere falls back to Page silently (no refusal logged) — ' +
     'the same `_scopeRootOf` returns-null path a Parent scope with no parent at all takes too', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const s = scene('', (screen) => screen.AddChild(scopedCard(40, 40, 'Root')));
    settle(s);
    const f = s.Frame();
    expect(f.Fills.length).toBe(1);
    expect(info).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it('refuses under _capturing, falls back to Page, and logs the reason once', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    let root!: Jiv;
    const s = scene('', (screen) => {
      root = new Jiv({ Style: { BackdropRoot: 'true', Opacity: '1' } });
      root.AddChild(scopedCard(10, 10, 'Root'));
      screen.AddChild(root);
    });
    (s.Canvas as unknown as { _capturing: boolean })._capturing = true;
    settle(s);
    const f = s.Frame();
    expect(f.Fills.length).toBe(1); // still renders — Page-shaped, not broken
    expect(info).toHaveBeenCalledWith(expect.stringContaining('capturing'));
    // Logged once: a second refusal for the same reason does not print again.
    const callsAfterFirst = info.mock.calls.length;
    s.Frame();
    expect(info.mock.calls.length).toBe(callsAfterFirst);
    info.mockRestore();
  });

  it('refuses under a shared backdrop, falls back to Page, and logs the reason once', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const s = scene('?wkr-shared-backdrop', (screen) => {
      const root = new Jiv({ Style: { BackdropRoot: 'true', Opacity: '1' } });
      root.AddChild(scopedCard(10, 10, 'Root'));
      screen.AddChild(root);
    });
    settle(s);
    expect(s.Frame().Fills.length).toBe(1);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('shared-backdrop'));
    info.mockRestore();
  });

  it('same-frame sharing: two scoped cards under one root, same region, one underlying build', () => {
    const s = scene('', (screen) => {
      const root = new Jiv({ Style: { BackdropRoot: 'true', Opacity: '1' } });
      root.AddChild(scopedCard(10, 10, 'Root'));
      root.AddChild(scopedCard(10, 10, 'Root')); // identical box on purpose: same key, same region
      screen.AddChild(root);
    });
    const f = s.Frame();
    expect(f.Fills.length).toBe(2);
    // Both fills bind the SAME handle — the second reused the first's capture+build this frame.
    expect((f.Fills[0] as { Handle: Handle }).Handle?.Id).toBe((f.Fills[1] as { Handle: Handle }).Handle?.Id);
    expect(f.Builds).toBe(1);
  });

  it('cross-frame cache: a clean scoped backdrop builds once, then keeps — same Id, no rebuild', () => {
    const s = scene('', (screen) => {
      const root = new Jiv({ Style: { BackdropRoot: 'true', Opacity: '1' } });
      root.AddChild(scopedCard(10, 10, 'Root'));
      screen.AddChild(root);
    });
    settle(s);
    const first = s.Frame();
    expect(first.Builds).toBe(0); // already settled by `settle`
    const firstId = (first.Fills[0] as { Handle: Handle }).Handle?.Id;
    const second = s.Frame();
    expect(second.Builds).toBe(0);
    expect((second.Fills[0] as { Handle: Handle }).Handle?.Id).toBe(firstId);
  });

  it('scoped cache invalidates on a change INSIDE the root, and stays clean on a change OUTSIDE it', () => {
    let outside!: Jiv;
    let inside!: Jiv;
    const s = scene('', (screen) => {
      outside = placed(500, 500, 40, 40, { Background: 'rgb(200, 30, 30)' });
      screen.AddChild(outside);
      const root = new Jiv({ Style: { BackdropRoot: 'true', Opacity: '1' } });
      inside = placed(0, 0, 20, 20, { Background: 'rgb(30, 200, 30)' });
      root.AddChild(inside);
      root.AddChild(scopedCard(10, 10, 'Root'));
      screen.AddChild(root);
    });
    settle(s);
    const before = s.Frame();
    expect(before.Builds).toBe(0);
    const beforeId = (before.Fills[0] as { Handle: Handle }).Handle?.Id;

    // A change OUTSIDE the root (a distinct background elsewhere on the page) — the scoped reader
    // stays clean: same Id, no rebuild, even though it is NOT the same pixels Page-scope would see.
    Object.assign(outside.Style, { Background: 'rgb(10, 10, 240)' });
    const afterOutside = s.Frame();
    expect(afterOutside.Builds).toBe(0);
    expect((afterOutside.Fills[0] as { Handle: Handle }).Handle?.Id).toBe(beforeId);

    // A change INSIDE the root (a row under it) — the scoped reader rebuilds: a new Id.
    Object.assign(inside.Style, { Background: 'rgb(240, 10, 10)' });
    const afterInside = s.Frame();
    expect(afterInside.Builds).toBe(1);
    expect((afterInside.Fills[0] as { Handle: Handle }).Handle?.Id).not.toBe(beforeId);
  });
});
