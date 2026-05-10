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
  console.log('[Jaui.Worker] booted');

  const post = (msg: W2M, transfer?: Transferable[]): void => {
    if (transfer && transfer.length > 0) {
      _self.postMessage(msg, transfer);
    } else {
      _self.postMessage(msg);
    }
  };

  const bridge = new WorkerBridge(post);

  bridge.OnInit = async (m: M2W_Init): Promise<void> => {
    console.log('[Jaui.Worker] init received', {
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

      const registry = new JivRegistry(canvas.Root, post);
      bridge.AttachRegistry(registry);

      canvas.RegisterPostFrame(() => registry.EmitRectSnapshots());

      canvas.ResizeFromBridge(m.Width, m.Height);

      console.log('[Jaui.Worker] ready');
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
