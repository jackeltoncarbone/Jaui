/**
 * Worker.Boot — exported boot function for the Jaui rendering worker.
 *
 * EVERY consumer builds its own worker entry — there is no default one, because a worker with no
 * janvas renderers registered cannot draw a field, a mannequin or a gait, and the entry is also
 * where the bundler's static `new Worker(new URL(...))` has to resolve to. Show Studio's is
 * `ShowStudio.App/src/Jaui.Worker.ts`. An entry:
 *   1. Registers JanvasRenderer factories via `RegisterJanvasRenderer`
 *   2. Calls `BootJauiWorker()` once
 *
 * The boot function is idempotent-by-construction (it consumes the worker's
 * one-and-only `init` message), so a second call would be a no-op until a
 * second `init` arrives — which it can't, since the OffscreenCanvas was
 * transferred. Calling it more than once is a programmer error.
 *
 * Why split: the registry must be populated *before* the worker handles
 * any `janvas-attach` op. If we kept the auto-boot pattern, registrations
 * would race with the first JivOps batch from main. Splitting forces the
 * consumer to register synchronously, then call boot — the registry is
 * fully populated before any message is processed.
 */

/// <reference lib="webworker" />

import { Canvas } from '../Core/Jaui';
import { WebGL2Renderer } from '../Core/WebGL2.Renderer';
import { WorkerPlatform } from './Worker.Platform';
import { WorkerBridge, PlatformInitFromMessage } from './Bridge.Worker';
import { JivRegistry } from './Jiv.Registry';
import { JTrace, JMs } from '../Diagnostics/Jaui.Trace';
import type { W2M, M2W_Init } from './Bridge.Types';

const _self: DedicatedWorkerGlobalScope =
  self as unknown as DedicatedWorkerGlobalScope;

/** Mirror worker console.* lines into main-thread console so the
 *  on-screen overlay (`?debug=console`) and DevTools both surface them.
 *  Without this, worker logs stay invisible to the overlay because
 *  it hooks main-thread console only. Idempotent: a second call no-ops. */
let _consoleForwarded = false;
const _forwardWorkerConsole = (): void => {
  if (_consoleForwarded) return;
  _consoleForwarded = true;
  const levels = ['log', 'info', 'warn', 'error', 'debug'] as const;
  for (const level of levels) {
    const orig = (console as unknown as Record<string, (...args: unknown[]) => void>)[level].bind(console);
    (console as unknown as Record<string, (...args: unknown[]) => void>)[level] = (...args: unknown[]): void => {
      try {
        // Stringify here so `postMessage` doesn't choke on non-cloneable
        // values (Errors, DOM-ish handles). Cap each arg so a giant
        // payload doesn't flood the bridge.
        const safe = args.map((a) => {
          if (a instanceof Error) return `${a.name}: ${a.message}`;
          if (typeof a === 'string') return a.slice(0, 4000);
          try { return JSON.stringify(a, null, 0).slice(0, 4000); } catch { return String(a).slice(0, 4000); }
        });
        _self.postMessage({ T: 'console', Level: level, Args: safe } as unknown as W2M);
      } catch { /* never block console */ }
      orig(...args);
    };
  }
  _self.addEventListener('error', (e: ErrorEvent) => {
    try {
      _self.postMessage({ T: 'console', Level: 'error',
        Args: [`[worker error] ${e.message}`, e.error instanceof Error ? e.error.stack ?? '' : String(e.error)] } as unknown as W2M);
    } catch { /* ignore */ }
  });
  _self.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    try {
      _self.postMessage({ T: 'console', Level: 'error',
        Args: ['[worker unhandled rejection]', e.reason instanceof Error ? `${e.reason.name}: ${e.reason.message}` : String(e.reason)] } as unknown as W2M);
    } catch { /* ignore */ }
  });
};

/** Boot the Jaui worker. Wires the bridge, waits for the `init` message,
 *  then constructs renderer/platform/canvas/registry and posts `ready`.
 *  Call once per worker scope. */
export const BootJauiWorker = (): void => {
  _forwardWorkerConsole();
  // Build marker — proves WHICH worker bundle is live in the tab (a soft refresh
  // reuses the cached module worker; only a hard reload re-inits it). Gated behind
  // `?debug`/`?jdebug` so normal mode stays clean; enable it when verifying a
  // worker-side change actually landed in the running bundle.
  try {
    if (/[?&](debug|jdebug)\b/.test(_self.location?.search ?? '')) {
      console.log('[Jaui.Worker] BOOT rot-render v3 (pblur fragment clip un-rotates about clip center)');
    }
  } catch { /* never block boot */ }

  const post = (msg: W2M, transfer?: Transferable[]): void => {
    if (transfer && transfer.length > 0) {
      _self.postMessage(msg, transfer);
    } else {
      _self.postMessage(msg);
    }
  };

  const bridge = new WorkerBridge(post);

  // NOTHING HAPPENS BEFORE `init`, AND THAT IS A DECISION. A host may start this worker from the
  // document head (show-studio does), so the module is parsed and sitting here well before the page
  // has a canvas to transfer — tempting to fill that window by taking a THROWAWAY GL context and
  // issuing the shader batch into it, since Chrome's compiled-program cache is keyed on shader source
  // and shared across contexts. It would make the first-ever visit WORSE. The cache entry is written
  // when a compile COMPLETES, ~700ms in; the real `init` now arrives long before that, misses the
  // still-in-flight entry, and compiles the same thirteen programs a second time — two full compiles
  // for one first frame, plus a second live context during boot. The speculative warm-up only pays
  // when init arrives after the warm-up finished, which is the opposite of what an early spawn does.
  // Start the worker sooner; do not start the GPU twice.
  bridge.OnInit = async (m: M2W_Init): Promise<void> => {
    // `jaui:booted` below only says the message handler is installed. THIS is where the worker
    // starts doing work, and the distance from `booted` to here is the page's half of the
    // handshake — how long the page took to lay the canvas out and hand over the OffscreenCanvas.
    // The size is in the mark because an init rect of 0 means the render loop will bail on every
    // frame until a `resize` arrives (see `_tickInner`'s zero-size gate).
    JTrace(`jaui:init:received ${Math.round(m.Width)}x${Math.round(m.Height)}`);
    const _t0 = performance.now();
    // Gate noisy worker logs behind `?debug` (or `?jdebug`) on the launching
    // page. Production / casual reload should see a clean console; we only
    // want fps/phase chatter when explicitly profiling.
    const _debug = /[?&](debug|jdebug)\b/.test(m.UrlSearch ?? '');
    if (_debug) console.log('[Jaui.Worker] init received', {
      Width: m.Width,
      Height: m.Height,
      Dpr: m.DevicePixelRatio,
    });
    try {
      const renderer = new WebGL2Renderer();
      JTrace('jaui:renderer-init:start');
      await renderer.Init(m.Canvas);
      JTrace(`jaui:renderer-init:end ${JMs(performance.now() - _t0)}ms`);

      const platform = new WorkerPlatform(PlatformInitFromMessage(m));
      bridge.AttachPlatform(platform);

      const canvas = new Canvas(
        m.Canvas as unknown as HTMLCanvasElement,
        renderer,
        platform,
      );

      bridge.AttachCanvas(canvas);

      // Forward GL context loss/restore to main so the eviction watchdog can self-heal:
      // the worker recovers the context IN PLACE (Canvas._onContextRestored), and these
      // tell the watchdog whether that happened — so it only reloads when it truly must
      // (the worker was killed and will never post `context-restored`).
      canvas.ContextLostRelay = () => post({ T: 'context-lost' });
      canvas.ContextRestoredRelay = () => post({ T: 'context-restored' });

      const registry = new JivRegistry(canvas.Root, post);
      // Wire the rAF kick so class-swap `@Animation` re-applies can wake
      // the loop. Without this, the AnimationManager parks itself when
      // all current animations settle and a newly-applied looping
      // animation would never tick until something else nudged it.
      registry.SetAnimationKick(() => canvas.Animations.Kick());
      canvas.RegisterGroupPeersResolver(jiv => registry.GroupPeersOf(jiv));
      registry.SetScroller({
        Measure: canvas.MeasureScrollContent,
        PageX: canvas.ScrollPageX,
        ScrollTo: canvas.ScrollTo,
      });
      bridge.AttachRegistry(registry);

      canvas.RegisterPostFrame(() => registry.EmitRectSnapshots());

      // Worker-side FPS sampling. Main thread's rAF cadence stays at the
      // display rate even when the worker stalls, so the on-screen
      // ?fps overlay needs the WORKER's actual paint cadence to report
      // perceived smoothness. Sample over a 1-second sliding window;
      // emit a `fps` message every ~250ms — short enough to react to
      // recent stalls, sparse enough not to flood the bridge.
      //
      // ONLY WHEN SOMEBODY IS READING IT. This used to be registered unconditionally, which meant
      // every page in the app paid a post-frame callback per tick -- a performance.now(), a push,
      // a shift over a ~60-entry array -- plus four postMessages a second, forever, to feed an
      // overlay nobody had asked for. Every consumer is behind a flag already: the standalone
      // overlay is `?fps`, the app's own TraceFps is `?trace` (Diagnostics/Trace.ts), and the
      // phase dump below is `?debug`. So the sampler is behind the union of them.
      const _fpsWanted = /[?&](fps|trace|debug|jdebug)\b/.test(m.UrlSearch ?? '');
      const fpsStamps: number[] = [];
      let fpsFrame = 0;
      let fpsLastEmit = 0;
      let lastFrameStart = 0;
      // Phase timing — accumulate per-phase durations across the
      // sample window so we can see which phase eats the budget.
      // Each entry tracks total ms + count of samples.
      const phases: Record<string, { ms: number; n: number }> = {};
      const _trackPhase = (name: string, dur: number): void => {
        const e = phases[name] ?? (phases[name] = { ms: 0, n: 0 });
        e.ms += dur; e.n += 1;
      };
      // Hook into the start-of-frame so we can measure inter-frame gap
      // (full rAF period including any worker idleness — a long gap with
      // no work means the worker rAF isn't being scheduled fast enough,
      // not that the work itself is slow).
      if (_fpsWanted) canvas.RegisterPostFrame(() => {
        const now = performance.now();
        if (lastFrameStart > 0) _trackPhase('frame', now - lastFrameStart);
        lastFrameStart = now;
        fpsStamps.push(now);
        fpsFrame++;
        while (fpsStamps.length > 0 && fpsStamps[0] < now - 1000) fpsStamps.shift();
        if (now - fpsLastEmit < 250) return;
        fpsLastEmit = now;
        const span = fpsStamps[fpsStamps.length - 1] - fpsStamps[0];
        const avg = span > 0 ? (fpsStamps.length - 1) * 1000 / span : 0;
        let worstGap = 0;
        for (let i = 1; i < fpsStamps.length; i++) {
          const g = fpsStamps[i] - fpsStamps[i - 1];
          if (g > worstGap) worstGap = g;
        }
        const min = worstGap > 0 ? 1000 / worstGap : 0;
        // Snapshot phase averages for this window and reset.
        const phaseAvg: Record<string, number> = {};
        for (const k in phases) {
          phaseAvg[k] = phases[k].n > 0 ? phases[k].ms / phases[k].n : 0;
          phases[k].ms = 0; phases[k].n = 0;
        }
        post({ T: 'fps', Avg: avg, Min: min, Frame: fpsFrame });
        // Surface phase timings on the same channel via console — the
        // ?fps overlay only renders fps; phase data shows up in the
        // ?debug=console overlay so iPad users can read it on-device.
        if (_debug && Object.keys(phaseAvg).length > 0) {
          console.log(`[wkr-fps] ${avg.toFixed(0)}avg ${min.toFixed(0)}min frame=${phaseAvg['frame']?.toFixed(1)}ms`);
        }
      });

      JTrace(`jaui:registry:end ${JMs(performance.now() - _t0)}ms`);

      canvas.ResizeFromBridge(m.Width, m.Height);

      if (_debug) console.log('[Jaui.Worker] ready');
      // READY MEANS "SEND ME THE TREE", NOT "THE GPU IS WARM". `WebGL2Renderer.Init` issues its
      // shader compiles and returns without waiting for them; the first frame collects them. So
      // posting here releases main's whole backlogged jiv tree to a worker that can build, measure
      // and solve it while the driver is still compiling — work that used to queue behind the
      // compile for no reason other than that Init happened to block.
      JTrace(`jaui:ready:posted init=${JMs(performance.now() - _t0)}ms`);
      post({ T: 'ready' });
    } catch (err) {
      console.error('[Jaui.Worker] init failed:', err);
      throw err;
    }
  };

  _self.addEventListener('message', (e: MessageEvent) => {
    bridge.HandleMessage(e.data);
  });

  _self.addEventListener('error', (e: ErrorEvent) => {
    console.error('[Jaui.Worker] uncaught error:', e.message, e.error);
  });
  _self.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    console.error('[Jaui.Worker] unhandled rejection:', e.reason);
  });
};
