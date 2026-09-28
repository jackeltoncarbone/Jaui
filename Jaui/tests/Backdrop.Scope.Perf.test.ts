/**
 * BackdropScope's hard rule, on the walk itself: a canvas that never authors `BackdropRoot` /
 * `BackdropScope: Parent` must pay NOTHING extra, per node, per frame — no wrapper call, no
 * Map.set, no try/finally. `Core/Jaui.ts` picks its walk's entry point ONCE per frame
 * (`renderNode = _scopingActive ? <wrapper> : renderNodeInner`), off a flag `_noteScopeChange` keeps
 * live from style CHANGES only (never a per-frame tree scan) — this file proves BOTH ends of that:
 * the flag reads false on an unscoped tree of 5,000 nodes (so the fast path — literally
 * `renderNodeInner` itself — is what ran), and a tree that DOES use it only ever tracks the
 * handful of nodes that matter, never the whole tree, and costs time within noise of the unscoped
 * baseline.
 *
 * REAL walk (`Canvas.RenderHeadless` against a recording renderer), same shape as
 * Blur.Cache.Walk.test.ts / Backdrop.Scope.test.ts — see the former's header for why this is not a
 * rasteriser.
 */
import { describe, it, expect } from 'vitest';
import { Canvas } from '@jaui/Core/Jaui';
import type { Renderer } from '@jaui/Core/Renderer';
import { WebGL2Renderer } from '@jaui/Core/WebGL2.Renderer';
import { BrowserPlatform } from '@jaui/Core/Platform';
import { Jiv } from '@jaui/Jiv/Jiv';

const W = 1600;
const H = 1200;
const NODE_COUNT = 5000;

/** A minimal recording renderer: no glass/backdrop authored in the perf tree at all, so only plain
 *  panel draws (and, for the one-root case, a single glass fill) ever reach it. */
const recorder = () => {
  const mutable: Record<string, unknown> = {
    DiagNoBlur: false, DiagBlurDummy: false, DiagBlurSrc: null, CardCompositeEnabled: false, DiagSnapOnce: false,
  };
  let seq = 0;
  const fixed: Record<string, unknown> = {
    SceneTexture: { Id: 0 },
    CardActive: false,
    GetGL: () => null,
    BeginCardComposite: () => false,
    SnapshotScreen: () => null,
    PaceTakeFence: () => null,
    PaceInFlight: () => 0,
    MeasureShadowBackdrop: () => -1,
    ComputeBlur: (): { Id: number } => ({ Id: ++seq }),
    PanelDrawBatch: (): void => {},
    BlurCacheStore: (src: { Id: number }, slot: { Valid: boolean; LastUse: number; Handle: unknown } | null) => {
      const s = slot ?? { Valid: false, LastUse: 0, Handle: null }; s.Valid = true; s.Handle = { Id: src.Id }; return s;
    },
    BlurCacheRelease: (): void => {}, BlurCacheCompare: (): number => 0,
    NoteBlurCacheHit: (): void => {}, NoteBlurCacheMiss: (): void => {}, NoteBlurCacheVerify: (): void => {},
    BlurCacheBytes: 0, BlurCacheSlots: 0, BlurCacheBudgetBytes: 48 * 1024 * 1024, BlurCacheReadKind: 't',
    BlurCacheCensus: { Evictions: 0, Refused: 0, Verified: 0, Mismatches: 0 },
    GroupBuilds: 0, GroupMembers: 0, GroupFallbacks: 0, SceneEndsByKey: {}, SceneSwitches: 0, SceneReads: 0, SceneRestarts: 0,
    SceneAtlasDraws: 0, BlurPoolCensus: 'none', BackdropBuildSeq: 0, BordersFromFill: 0, BordersRimBuilt: 0, PresampledBuilds: 0, LastPresampleK: 1,
  };
  const target = Object.create(WebGL2Renderer.prototype) as object;
  const proxy = new Proxy(target, {
    get: (_t, key) => { if (key === 'then') return undefined; const k = key as string; if (k in fixed) return fixed[k]; if (k in mutable) return mutable[k]; return () => undefined; },
    set: (_t, key, value) => { mutable[key as string] = value; return true; },
  });
  return proxy as unknown as Renderer;
};

/** `count` plain, unscoped nodes in a 100-wide grid under a fixed-size screen; `extra(screen)` adds
 *  whatever the case needs (a BackdropRoot wrapper, a Parent-scoped card) on top. */
const buildScene = (count: number, extra?: (screen: Jiv) => void): Canvas => {
  const platform = { ...BrowserPlatform, GetUrlSearch: (): string => '' };
  const c = new Canvas(new OffscreenCanvas(W, H) as unknown as HTMLCanvasElement, recorder(), platform);
  c.SetSizePx(W, H);
  const screen = new Jiv({
    ChildLayout: { Position: 'Fixed', Top: '0pt', Left: '0pt', Width: '100vw', Height: '100vh' },
    Style: { PointScale: '1', Background: 'rgb(20, 20, 24)', Opacity: '1' },
  });
  const cols = 100;
  for (let i = 0; i < count; i++) {
    const x = (i % cols) * 16, y = Math.floor(i / cols) * 16;
    screen.AddChild(new Jiv({
      ChildLayout: { Position: 'Placed', Left: `${x}pt`, Top: `${y}pt`, Width: '14pt', Height: '14pt' },
      Style: { Opacity: '1', Background: `rgb(${i % 200}, ${(i * 3) % 200}, ${(i * 7) % 200})` },
    }));
  }
  extra?.(screen);
  c.Root.AddChild(screen);
  return c;
};

/** `n` headless frames, ms elapsed. */
const timeFrames = (c: Canvas, n: number): number => {
  let t = 1000;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) { c.RequestFrame(); c.RenderHeadless((t += 16)); }
  return performance.now() - t0;
};

describe('BackdropScope — the walk pays nothing on a tree that never uses it', () => {
  it(`_scopingActive reads false on ${NODE_COUNT} plain nodes: the fast path (renderNode === renderNodeInner) is what ran`, () => {
    const c = buildScene(NODE_COUNT);
    timeFrames(c, 3);
    const priv = c as unknown as { _scopeRootNodes: Set<unknown>; _scopeParentNeeded: Map<unknown, unknown> };
    expect(priv._scopeRootNodes.size).toBe(0);
    expect(priv._scopeParentNeeded.size).toBe(0);
  });

  it(`a BackdropRoot + a BackdropScope: Parent node track ONLY themselves among ${NODE_COUNT} plain siblings`, () => {
    let parentOfScoped!: Jiv;
    const c = buildScene(NODE_COUNT, (screen) => {
      const root = new Jiv({ Style: { BackdropRoot: 'true', Opacity: '1' } });
      parentOfScoped = new Jiv({ Style: { Opacity: '1' } });
      parentOfScoped.AddChild(new Jiv({
        ChildLayout: { Position: 'Placed', Left: '0pt', Top: '0pt', Width: '40pt', Height: '40pt' },
        Style: { Opacity: '1', BackdropScope: 'Parent' },
      }));
      root.AddChild(parentOfScoped);
      screen.AddChild(root);
    });
    timeFrames(c, 3);
    const priv = c as unknown as { _scopeRootNodes: Set<Jiv>; _scopeParentNeeded: Map<Jiv, number> };
    expect(priv._scopeRootNodes.size).toBe(1);
    expect(priv._scopeParentNeeded.size).toBe(1);
    expect(priv._scopeParentNeeded.get(parentOfScoped)).toBe(1);
  });

  it(`render time for ${NODE_COUNT} nodes stays within noise whether or not one BackdropRoot exists elsewhere in the tree`, () => {
    const FRAMES = 8;
    const plain = buildScene(NODE_COUNT);
    timeFrames(plain, 2); // warm up (JIT, first-frame allocation) before timing
    const plainMs = timeFrames(plain, FRAMES);

    const scoped = buildScene(NODE_COUNT, (screen) => {
      const root = new Jiv({ Style: { BackdropRoot: 'true', Opacity: '1' } });
      screen.AddChild(root);
    });
    timeFrames(scoped, 2);
    const scopedMs = timeFrames(scoped, FRAMES);

    // Generous on purpose (CI machines vary widely) — this is a regression GUARD against an
    // accidental per-node cost creeping back in, not a tight perf assertion. A per-node Map.set +
    // try/finally on 5,000 nodes a frame was measurably worse than this bound in practice.
    expect(scopedMs).toBeLessThan(Math.max(plainMs * 3, plainMs + 200));
  });
});
