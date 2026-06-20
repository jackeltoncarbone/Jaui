/**
 * ContextWatchdog — main-thread self-heal for the worker-rendered canvas.
 *
 * The worker recovers a lost WebGL context in place (see Canvas `_onContextRestored`).
 * But iOS, under enough memory pressure, kills the whole BACKGROUND tab's worker — and
 * a dead worker can't recover itself, nor will it ever post `context-restored`. The only
 * cure then is a reload. This watchdog detects that case from the main thread:
 *
 *   • On the tab becoming visible again, it PINGS the worker. A live worker pongs; if no
 *     pong arrives within `PongTimeoutMs`, the worker is gone → reload.
 *   • If the context is LOST and not restored within `RestoreTimeoutMs` of becoming
 *     visible (in-worker recovery failed), reload as the last resort.
 *
 * Timers are armed only while the tab is VISIBLE — background timers are throttled on
 * mobile and can't be trusted. All callbacks are injected so it unit-tests with fake
 * timers and no DOM/worker.
 */
export interface ContextWatchdogOptions {
  /** Send a liveness ping to the worker (main → worker `ping`). */
  PostPing: () => void;
  /** Recover when the worker/context is unrecoverable — typically `location.reload()`. */
  Reload: () => void;
  /** Wait this long for a `pong` after a visibility ping before declaring the worker
   *  dead. Default 2000ms. */
  PongTimeoutMs?: number;
  /** Once visible with a lost context, wait this long for `context-restored` before
   *  forcing a reload. Default 4000ms. */
  RestoreTimeoutMs?: number;
}

export class ContextWatchdog {
  private readonly _post: () => void;
  private readonly _reload: () => void;
  private readonly _pongMs: number;
  private readonly _restoreMs: number;
  private _pongTimer: ReturnType<typeof setTimeout> | null = null;
  private _restoreTimer: ReturnType<typeof setTimeout> | null = null;
  private _contextLost = false;
  private _fired = false;

  constructor(opts: ContextWatchdogOptions) {
    this._post = opts.PostPing;
    this._reload = opts.Reload;
    this._pongMs = opts.PongTimeoutMs ?? 2000;
    this._restoreMs = opts.RestoreTimeoutMs ?? 4000;
  }

  /** The tab became visible (or `pageshow` fired). Ping for liveness; if the context is
   *  lost, also bound how long we wait for the in-worker restore. */
  OnVisible = (): void => {
    if (this._fired) return;
    this._clearPong();
    this._post();
    this._pongTimer = setTimeout(() => {
      this._pongTimer = null;
      this._fire(); // no pong → the worker is dead
    }, this._pongMs);

    if (this._contextLost) this._armRestore();
  };

  /** Worker answered the ping — it's alive. */
  OnPong = (): void => {
    this._clearPong();
  };

  /** Worker reported its GL context was lost. */
  OnContextLost = (): void => {
    this._contextLost = true;
  };

  /** Worker reported its GL context was restored in place — recovery succeeded. */
  OnContextRestored = (): void => {
    this._contextLost = false;
    this._clearRestore();
  };

  /** Stop all timers (e.g. on teardown). */
  Dispose = (): void => {
    this._clearPong();
    this._clearRestore();
  };

  private _armRestore(): void {
    if (this._restoreTimer !== null || this._fired) return;
    this._restoreTimer = setTimeout(() => {
      this._restoreTimer = null;
      if (this._contextLost) this._fire(); // never came back → reload
    }, this._restoreMs);
  }

  private _clearPong(): void {
    if (this._pongTimer !== null) { clearTimeout(this._pongTimer); this._pongTimer = null; }
  }

  private _clearRestore(): void {
    if (this._restoreTimer !== null) { clearTimeout(this._restoreTimer); this._restoreTimer = null; }
  }

  private _fire(): void {
    if (this._fired) return; // reload exactly once
    this._fired = true;
    this.Dispose();
    this._reload();
  }
}
