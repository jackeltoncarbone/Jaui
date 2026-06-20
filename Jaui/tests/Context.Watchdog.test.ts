import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContextWatchdog, type ContextWatchdogOptions } from '@jaui/Worker/Context.Watchdog';

describe('ContextWatchdog — main-thread eviction self-heal', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function make(over: Partial<ContextWatchdogOptions> = {}) {
    const post = vi.fn();
    const reload = vi.fn();
    const wd = new ContextWatchdog({
      PostPing: post, Reload: reload, PongTimeoutMs: 1000, RestoreTimeoutMs: 2000, ...over,
    });
    return { wd, post, reload };
  }

  it('pings the worker on visible; a pong before the timeout means NO reload (worker alive)', () => {
    const { wd, post, reload } = make();
    wd.OnVisible();
    expect(post).toHaveBeenCalledTimes(1);
    wd.OnPong();
    vi.advanceTimersByTime(5000);
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads when no pong arrives within the timeout (worker evicted)', () => {
    const { wd, reload } = make();
    wd.OnVisible();
    vi.advanceTimersByTime(999);
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('context lost then restored before becoming visible → pong → NO reload', () => {
    const { wd, reload } = make();
    wd.OnContextLost();
    wd.OnContextRestored();
    wd.OnVisible();
    wd.OnPong();
    vi.advanceTimersByTime(5000);
    expect(reload).not.toHaveBeenCalled();
  });

  it('context lost, visible, restored within the grace window → NO reload', () => {
    const { wd, reload } = make();
    wd.OnContextLost();
    wd.OnVisible();
    wd.OnPong();              // worker is alive…
    vi.advanceTimersByTime(1500);
    wd.OnContextRestored();   // …and recovered in time
    vi.advanceTimersByTime(5000);
    expect(reload).not.toHaveBeenCalled();
  });

  it('context lost, visible, alive, but NEVER restored within the grace window → reload', () => {
    const { wd, reload } = make();
    wd.OnContextLost();
    wd.OnVisible();
    wd.OnPong();              // worker alive, but its in-place recovery never completes
    vi.advanceTimersByTime(1999);
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads at most once across repeated failures', () => {
    const { wd, reload } = make();
    wd.OnVisible();
    vi.advanceTimersByTime(1000); // no pong → reload
    wd.OnVisible();
    vi.advanceTimersByTime(5000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('Dispose cancels pending timers — no reload after teardown', () => {
    const { wd, reload } = make();
    wd.OnVisible();
    wd.Dispose();
    vi.advanceTimersByTime(5000);
    expect(reload).not.toHaveBeenCalled();
  });

  it('OnVisible after a reload has fired is a no-op (no extra ping, no second reload)', () => {
    const { wd, post, reload } = make();
    wd.OnVisible();
    vi.advanceTimersByTime(1000); // reload fires
    post.mockClear();
    wd.OnVisible();
    expect(post).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
