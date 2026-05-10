import { describe, it, expect } from 'vitest';
import {
  isMessage,
  type M2W_Init,
  type M2W_PointerEvent,
  type M2W_DprChange,
  type W2M_Cursor,
  type W2M_Ready,
} from '@jaui/Worker/Bridge.Types';

describe('Worker.Bridge.Types — isMessage narrower', () => {
  it('matches the tag and narrows the type', () => {
    const msg: unknown = { T: 'init', Width: 100, Height: 200 } as M2W_Init;
    expect(isMessage<M2W_Init>(msg, 'init')).toBe(true);
  });

  it('rejects mismatched tags', () => {
    const msg: unknown = { T: 'pointer' } as M2W_PointerEvent;
    expect(isMessage<M2W_Init>(msg, 'init')).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(isMessage(null, 'init')).toBe(false);
    expect(isMessage(undefined, 'init')).toBe(false);
    expect(isMessage('init', 'init')).toBe(false);
    expect(isMessage(42, 'init')).toBe(false);
  });

  it('rejects objects without a T tag', () => {
    expect(isMessage({}, 'init')).toBe(false);
    expect(isMessage({ kind: 'init' }, 'init')).toBe(false);
  });

  it('handles every message tag round-trip', () => {
    const tags = [
      ['init', { T: 'init' }],
      ['pointer', { T: 'pointer' } as M2W_PointerEvent],
      ['dpr', { T: 'dpr', DevicePixelRatio: 2 } as M2W_DprChange],
      ['cursor', { T: 'cursor', Cursor: 'pointer' } as W2M_Cursor],
      ['ready', { T: 'ready' } as W2M_Ready],
    ] as const;
    for (const [tag, msg] of tags) {
      expect(isMessage(msg, tag)).toBe(true);
      expect(isMessage(msg, 'unknown-tag' as never)).toBe(false);
    }
  });
});
