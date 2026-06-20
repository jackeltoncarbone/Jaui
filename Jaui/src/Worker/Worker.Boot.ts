/**
 * Worker.Boot — exported boot function for the Jaui rendering worker.
 *
 * This file replaces the side-effecting body that used to live in
 * `Jaui.Worker.ts`. Show-studio (or any consumer) builds a custom worker
 * entry that:
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

  bridge.OnInit = async (m: M2W_Init): Promise<void> => {
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
      await renderer.Init(m.Canvas);

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
      bridge.AttachRegistry(registry);

      canvas.RegisterPostFrame(() => registry.EmitRectSnapshots());

      // Worker-side FPS sampling. Main thread's rAF cadence stays at the
      // display rate even when the worker stalls, so the on-screen
      // ?fps overlay needs the WORKER's actual paint cadence to report
      // perceived smoothness. Sample over a 1-second sliding window;
      // emit a `fps` message every ~250ms — short enough to react to
      // recent stalls, sparse enough not to flood the bridge.
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
      canvas.RegisterPostFrame(() => {
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

      canvas.ResizeFromBridge(m.Width, m.Height);

      if (_debug) console.log('[Jaui.Worker] ready');
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
