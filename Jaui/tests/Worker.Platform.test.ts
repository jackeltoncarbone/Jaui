import { describe, it, expect, vi } from 'vitest';
import { WorkerPlatform, type WorkerPlatformInit } from '@jaui/Worker/Worker.Platform';
import type { M2W_DprChange, M2W_KeyDown } from '@jaui/Worker/Bridge.Types';

const _init: WorkerPlatformInit = {
  Dpr: 2,
  IsPointerCoarse: false,
  IsTextInputFocused: false,
  UrlSearch: '?profile',
  UrlHash: '#debug',
  FontsAlreadyReady: true,
};

describe('WorkerPlatform — Platform interface', () => {
  it('serves initial state synchronously', () => {
    const p = new WorkerPlatform(_init);
    expect(p.GetDevicePixelRatio()).toBe(2);
    expect(p.IsPointerCoarse()).toBe(false);
    expect(p.IsTextInputFocused()).toBe(false);
    expect(p.GetUrlSearch()).toBe('?profile');
    expect(p.GetUrlHash()).toBe('#debug');
  });

  it('updates DPR when M2W_DprChange ingested', () => {
    const p = new WorkerPlatform(_init);
    p.IngestMessage({ T: 'dpr', DevicePixelRatio: 3 });
    expect(p.GetDevicePixelRatio()).toBe(3);
  });

  it('updates pointer-coarse on M2W_CoarseChange', () => {
    const p = new WorkerPlatform(_init);
    p.IngestMessage({ T: 'coarse', IsPointerCoarse: true });
    expect(p.IsPointerCoarse()).toBe(true);
  });

  it('updates focus state on M2W_FocusChange', () => {
    const p = new WorkerPlatform(_init);
    p.IngestMessage({ T: 'focus', IsTextInputFocused: true });
    expect(p.IsTextInputFocused()).toBe(true);
    p.IngestMessage({ T: 'focus', IsTextInputFocused: false });
    expect(p.IsTextInputFocused()).toBe(false);
  });

  it('returns false from IngestMessage for tags it does not handle', () => {
    const p = new WorkerPlatform(_init);
    // 'init' isn't handled by Platform (the worker entry consumes it directly).
    expect(p.IngestMessage({
      T: 'init', Canvas: null as unknown as OffscreenCanvas,
      Width: 0, Height: 0, DevicePixelRatio: 1, IsPointerCoarse: false,
      UrlSearch: '', UrlHash: '', FontsAlreadyReady: true,
    })).toBe(false);
  });
});

describe('WorkerPlatform — DPR change observer (one-shot)', () => {
  it('fires registered handler on M2W_DprChange', () => {
    const p = new WorkerPlatform(_init);
    const handler = vi.fn();
    p.ObserveDprChange(2, handler);
    p.IngestMessage({ T: 'dpr', DevicePixelRatio: 3 });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('is one-shot — second DPR change after a single arm fires nothing', () => {
    const p = new WorkerPlatform(_init);
    const handler = vi.fn();
    p.ObserveDprChange(2, handler);
    p.IngestMessage({ T: 'dpr', DevicePixelRatio: 3 });
    p.IngestMessage({ T: 'dpr', DevicePixelRatio: 4 });
    expect(handler).toHaveBeenCalledOnce(); // not twice
  });

  it('handler can re-arm itself from inside the callback', () => {
    const p = new WorkerPlatform(_init);
    let count = 0;
    const arm = (): void => {
      p.ObserveDprChange(p.GetDevicePixelRatio(), () => {
        count++;
        arm(); // re-register
      });
    };
    arm();
    p.IngestMessage({ T: 'dpr', DevicePixelRatio: 3 });
    p.IngestMessage({ T: 'dpr', DevicePixelRatio: 4 });
    expect(count).toBe(2);
  });

  it('disposer removes the handler before fire', () => {
    const p = new WorkerPlatform(_init);
    const handler = vi.fn();
    const dispose = p.ObserveDprChange(2, handler);
    dispose();
    p.IngestMessage({ T: 'dpr', DevicePixelRatio: 3 });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('WorkerPlatform — fonts loadingdone observer (persistent)', () => {
  it('fires every time M2W_FontsLoadingDone is ingested', () => {
    const p = new WorkerPlatform(_init);
    const handler = vi.fn();
    p.ObserveFontsLoadingDone(handler);
    p.IngestMessage({ T: 'fonts-done' });
    p.IngestMessage({ T: 'fonts-done' });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('disposer stops the handler', () => {
    const p = new WorkerPlatform(_init);
    const handler = vi.fn();
    const dispose = p.ObserveFontsLoadingDone(handler);
    dispose();
    p.IngestMessage({ T: 'fonts-done' });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('WorkerPlatform — keydown listener', () => {
  it('dispatches a synthesized KeyboardEvent to registered handlers', () => {
    const p = new WorkerPlatform(_init);
    const handler = vi.fn<(e: KeyboardEvent) => void>();
    p.AddKeydownListener(handler, { capture: true });
    const msg: M2W_KeyDown = {
      T: 'keydown',
      Payload: {
        Key: 'a', Code: 'KeyA', Repeat: false,
        Shift: false, Ctrl: false, Alt: false, Meta: true,
        TimeStamp: 12345,
      },
    };
    p.IngestMessage(msg);
    expect(handler).toHaveBeenCalledOnce();
    const e = handler.mock.calls[0][0];
    expect(e.key).toBe('a');
    expect(e.code).toBe('KeyA');
    expect(e.metaKey).toBe(true);
    expect(e.ctrlKey).toBe(false);
    expect(e.timeStamp).toBe(12345);
    // preventDefault should be callable without throwing.
    expect(() => e.preventDefault()).not.toThrow();
  });

  it('multiple listeners all fire', () => {
    const p = new WorkerPlatform(_init);
    const a = vi.fn(); const b = vi.fn();
    p.AddKeydownListener(a);
    p.AddKeydownListener(b);
    p.IngestMessage({
      T: 'keydown',
      Payload: {
        Key: 'Escape', Code: 'Escape', Repeat: false,
        Shift: false, Ctrl: false, Alt: false, Meta: false,
        TimeStamp: 0,
      },
    });
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it('disposer removes a single listener without affecting others', () => {
    const p = new WorkerPlatform(_init);
    const a = vi.fn(); const b = vi.fn();
    const disposeA = p.AddKeydownListener(a);
    p.AddKeydownListener(b);
    disposeA();
    p.IngestMessage({
      T: 'keydown',
      Payload: {
        Key: 'a', Code: 'KeyA', Repeat: false,
        Shift: false, Ctrl: false, Alt: false, Meta: false,
        TimeStamp: 0,
      },
    });
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledOnce();
  });

  it('handler that throws does not stop later listeners', () => {
    const p = new WorkerPlatform(_init);
    const a = vi.fn(() => { throw new Error('boom'); });
    const b = vi.fn();
    p.AddKeydownListener(a);
    p.AddKeydownListener(b);
    // Suppress the console.error noise while we trigger the throw.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    p.IngestMessage({
      T: 'keydown',
      Payload: {
        Key: 'a', Code: 'KeyA', Repeat: false,
        Shift: false, Ctrl: false, Alt: false, Meta: false,
        TimeStamp: 0,
      },
    });
    errSpy.mockRestore();
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });
});

describe('WorkerPlatform — DPR initial change message also updates getter', () => {
  it('GetDevicePixelRatio reflects the most recent DPR change', () => {
    const p = new WorkerPlatform(_init);
    expect(p.GetDevicePixelRatio()).toBe(2);
    p.IngestMessage({ T: 'dpr', DevicePixelRatio: 1.5 } satisfies M2W_DprChange);
    expect(p.GetDevicePixelRatio()).toBe(1.5);
  });
});
