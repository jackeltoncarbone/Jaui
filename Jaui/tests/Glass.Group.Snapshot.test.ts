/**
 * A GLASS GROUP OF UNFROSTED SURFACES paints into the scene, member after member.
 *
 * Two `Jwift_List_Translucent` sections in one sheet body are a group: siblings, one parent, the same
 * (zero) frost. A surface with no frost takes a raw-scene snapshot for its sharp tap, and the snapshot
 * binds its copy target. The first member rebinds the scene when it builds the group's pyramid; the
 * second member only looks the pyramid up, so until 2026-09-25 nothing rebound and it, its rows and
 * everything after it in the walk drew into the default framebuffer, which the end-of-frame blit then
 * overwrote. On the drill page that was Start Over and the save-status line, gone from the show menu.
 *
 * Run against the real walk and a recording renderer: every draw must land after the scene was
 * rebound following the last snapshot.
 */
import { describe, it, expect } from 'vitest';
import { Canvas } from '@jaui/Core/Jaui';
import type { Renderer } from '@jaui/Core/Renderer';
import { WebGL2Renderer } from '@jaui/Core/WebGL2.Renderer';
import { BrowserPlatform } from '@jaui/Core/Platform';
import { Jiv } from '@jaui/Jiv/Jiv';

type Event = { Kind: 'snap' } | { Kind: 'rebind' } | { Kind: 'group' } | { Kind: 'blur' } | { Kind: 'draw'; Site: 'fill' | 'other' };

/** Records what the walk asks the renderer for, in order. Booleans the walk reads are given
 *  explicit falsy values; the catch-all returns a no-op function. */
const recorder = (log: Event[]): Renderer => {
  let seq = 0;
  const mutable: Record<string, unknown> = {
    DiagNoBlur: false, DiagBlurDummy: false, DiagBlurSrc: null,
    CardCompositeEnabled: false, DiagNoDepth: false, DiagSnapOnce: false,
    ShadowSnap: false, ShadowSnapped: 0,
  };
  const fixed: Record<string, unknown> = {
    SceneTexture: { Id: 0 },
    CardActive: false,
    GetGL: () => null,
    BeginCardComposite: () => false,
    PaceTakeFence: () => null,
    PaceInFlight: () => 0,
    MeasureShadowBackdrop: () => -1,
    SnapshotScreen: () => { log.push({ Kind: 'snap' }); return { Id: ++seq }; },
    RebindSceneTarget: () => { log.push({ Kind: 'rebind' }); },
    ComputeBlur: () => { log.push({ Kind: 'blur' }); return { Id: ++seq }; },
    ComputeBlurGroup: () => { log.push({ Kind: 'group' }); return { Id: ++seq }; },
    PanelDrawBatch: (...args: unknown[]): void => {
      // A draw that binds a backdrop pyramid is a surface's fill; the rest are plain batches.
      log.push({ Kind: 'draw', Site: args[2] != null ? 'fill' : 'other' });
    },
    GroupBuilds: 0, GroupMembers: 0, GroupFallbacks: 0,
    SceneEndsByKey: {}, SceneSwitches: 0, SceneReads: 0, SceneRestarts: 0,
    SceneAtlasDraws: 0, BlurPoolCensus: 'none', BackdropBuildSeq: 0,
    BordersFromFill: 0, BordersRimBuilt: 0, PresampledBuilds: 0, LastPresampleK: 1,
  };
  const target = Object.create(WebGL2Renderer.prototype) as object;
  return new Proxy(target, {
    get: (_t, key) => {
      if (key === 'then') return undefined;
      const k = key as string;
      if (k in fixed) return fixed[k];
      if (k in mutable) return mutable[k];
      return () => undefined;
    },
    set: (_t, key, value) => { mutable[key as string] = value; return true; },
  }) as unknown as Renderer;
};

const OPAQUE = { Opacity: '1' } as const;

/** A sheet body: two translucent sections (Jwift's List.jss values), then a footnote. */
const buildSheetBody = (c: Canvas): void => {
  const body = new Jiv({
    ChildLayout: { Position: 'Placed', Left: '100pt', Top: '100pt', Width: '540pt' },
    Layout: { Direction: 'Column', Align: 'Stretch', Gap: '12pt' },
    Style: { Background: 'rgb(28, 28, 30)', ...OPAQUE },
  });
  for (let i = 0; i < 2; i++) {
    const list = new Jiv({
      ChildLayout: { Height: i === 0 ? '320pt' : '64pt' },
      Layout: { Direction: 'Column', Align: 'Stretch' },
      Style: {
        Background: 'rgba(0, 0, 0, 0.4)', BackdropFilter: 'Saturate(2) Brightness(0.75)',
        BorderRadius: '31.5pt', Overflow: 'Hidden', ...OPAQUE,
      },
    });
    list.AddChild(new Jiv({ Text: i === 0 ? 'Rename Show' : 'Start Over', Style: { Background: 'rgba(0, 0, 0, 0)', ...OPAQUE } }));
    body.AddChild(list);
  }
  body.AddChild(new Jiv({ Text: 'This is a trial on this device.', Style: { Background: 'rgba(0, 0, 0, 0)', ...OPAQUE } }));
  c.Root.AddChild(body);
};

const walk = (search: string): { Log: Event[]; Groups: number } => {
  const log: Event[] = [];
  const platform = { ...BrowserPlatform, GetUrlSearch: (): string => search };
  const c = new Canvas(new OffscreenCanvas(1280, 800) as unknown as HTMLCanvasElement, recorder(log), platform);
  c.SetSizePx(1280, 800);
  buildSheetBody(c);
  c.RenderHeadless(1000);
  const stats = (c as unknown as { _glassGroupStats: { Groups: number } })._glassGroupStats;
  return { Log: log, Groups: stats.Groups };
};

/** Every fill draw whose last preceding snapshot was not followed by a rebind: a draw off the scene. */
const drawsOffScene = (log: Event[]): number => {
  let bound = true;
  let off = 0;
  for (const e of log) {
    if (e.Kind === 'snap') bound = false;
    else if (e.Kind === 'rebind') bound = true;
    else if (e.Kind === 'draw' && e.Site === 'fill' && !bound) off++;
  }
  return off;
};

describe('a glass group of unfrosted surfaces', () => {
  it('groups the two sections, so the test reaches the group path', () => {
    expect(walk('').Groups).toBe(1);
  });

  it('draws every member into the scene, not only the one that built the pyramid', () => {
    const { Log } = walk('');
    const fills = Log.filter((e) => e.Kind === 'draw' && e.Site === 'fill');
    expect(fills.length).toBe(2);
    expect(Log.filter((e) => e.Kind === 'snap').length).toBe(2);
    expect(Log.filter((e) => e.Kind === 'group').length).toBe(1);
    expect(drawsOffScene(Log)).toBe(0);
  });

  it('draws into the scene with the group off too, where each member builds its own', () => {
    const { Log, Groups } = walk('?glass-group=off');
    expect(Groups).toBe(0);
    expect(drawsOffScene(Log)).toBe(0);
  });
});
