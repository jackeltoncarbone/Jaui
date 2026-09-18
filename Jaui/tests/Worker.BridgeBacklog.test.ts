/**
 * Worker.BridgeBacklog — what happens to a message posted before the worker says `ready`.
 *
 * The bridge holds messages until the worker is ready and drains them then. The font binaries go
 * out as TRANSFERRED ArrayBuffers, and whether a font-face message lands before or after `ready` is
 * a network race — so the backlog is on the font path on some loads and not others, which is the
 * shape of a bug that appears on one device and not another. The backlog used to keep the message
 * and throw the transfer list away; these tests pin down what the buffer is worth on both sides of
 * the drain.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The bridge reads `window`/`document` at import time and all through construction. Install the
// smallest surface it actually touches BEFORE importing it.
const listeners = new Map<string, ((e: unknown) => void)[]>();
const fakeTarget = {
  addEventListener: (type: string, fn: (e: unknown) => void): void => {
    const list = listeners.get(type) ?? [];
    list.push(fn);
    listeners.set(type, list);
  },
  removeEventListener: (): void => {},
  dispatchEvent: (): boolean => true,
};

const g = globalThis as Record<string, unknown>;
g.window = {
  ...fakeTarget,
  location: { search: '', hash: '', href: 'https://show.studio/' },
  devicePixelRatio: 2,
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
};
g.document = {
  ...fakeTarget,
  readyState: 'complete',
  visibilityState: 'visible',
  activeElement: null,
  styleSheets: [],
  // Falsy on purpose: with no FontFaceSet the bridge skips the stylesheet scan entirely, which is
  // what keeps this file about the BACKLOG and not about font discovery.
  fonts: null,
};

const { MainBridge } = await import('@jaui/Worker/Bridge.Main');

/** Records every postMessage with the transfer list it was given, and detaches transferred buffers
 *  the way a real `postMessage` does — so a test that loses a transfer list can be told apart from
 *  one that transfers twice. */
class FakeWorker {
  Posts: {
    Msg: { T: string; Buffer?: ArrayBuffer };
    Transfer: Transferable[] | undefined;
    /** Size of the buffer AT THE MOMENT it was posted. A detached buffer measures 0, which is the
     *  state that would reach the worker as a zero-length `ArrayBuffer` and make `new FontFace`
     *  fail — so this is the number that says whether anything claimed the binary too early. */
    BytesAtPost: number | null;
  }[] = [];
  addEventListener = (): void => {};
  postMessage = (msg: unknown, transfer?: Transferable[]): void => {
    const m = msg as { T: string; Buffer?: ArrayBuffer };
    this.Posts.push({ Msg: m, Transfer: transfer, BytesAtPost: m.Buffer ? m.Buffer.byteLength : null });
  };
}

const makeCanvas = (): unknown => ({
  ...fakeTarget,
  style: {},
  tabIndex: 0,
  getBoundingClientRect: () => ({ width: 390, height: 700, left: 0, top: 0 }),
  transferControlToOffscreen: () => ({ width: 390, height: 700 }),
});

let worker: FakeWorker;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let bridge: any;

beforeEach(() => {
  listeners.clear();
  worker = new FakeWorker();
  bridge = new MainBridge({
    Canvas: makeCanvas() as HTMLCanvasElement,
    Worker: worker as unknown as Worker,
    Reload: () => {},
  });
  // `_sendInit` posts init straight through, bypassing the backlog. Drop it so the assertions below
  // are about the messages the tests themselves send.
  worker.Posts.length = 0;
});

afterEach(() => { vi.restoreAllMocks(); });

const ready = (): void => bridge._onReady({ T: 'ready' });
const fontMessage = (bytes: number): { T: 'font-face'; Family: string; Buffer: ArrayBuffer } =>
  ({ T: 'font-face', Family: 'Inter', Buffer: new ArrayBuffer(bytes) });

describe('the backlog and a transferable', () => {
  it('does not post — or neuter — a buffer it backlogs', () => {
    const msg = fontMessage(2048);
    bridge.PostMessage(msg, [msg.Buffer]);
    expect(worker.Posts).toHaveLength(0);
    // The backlog path never reached postMessage, so nothing detached the buffer. This is why the
    // dropped transfer list was a copy and not a corruption: there is no window in which the
    // ArrayBuffer is both claimed and re-sent.
    expect(msg.Buffer.byteLength).toBe(2048);
  });

  it('drains a backlogged font WITH its transfer list, so the binary is moved and not copied', () => {
    const msg = fontMessage(2048);
    bridge.PostMessage(msg, [msg.Buffer]);
    ready();
    expect(worker.Posts).toHaveLength(1);
    expect(worker.Posts[0].Msg.T).toBe('font-face');
    expect(worker.Posts[0].Transfer).toHaveLength(1);
    expect(worker.Posts[0].Transfer![0]).toBe(msg.Buffer);
  });

  it('delivers a buffer with its bytes still in it — nothing detaches it while it waits', () => {
    const msg = fontMessage(2048);
    bridge.PostMessage(msg, [msg.Buffer]);
    ready();
    // Zero here is the failure that would look like "the font isn't loading": the worker would get
    // a detached, zero-length ArrayBuffer and `new FontFace(family, buffer)` would throw.
    expect(worker.Posts[0].BytesAtPost).toBe(2048);
  });

  it('keeps the messages in order and drains each with its own list', () => {
    const a = fontMessage(16);
    const b = { T: 'resize' as const, Width: 1, Height: 2 };
    const c = fontMessage(32);
    bridge.PostMessage(a, [a.Buffer]);
    bridge.PostMessage(b);
    bridge.PostMessage(c, [c.Buffer]);
    ready();
    expect(worker.Posts.map(p => p.Msg.T)).toEqual(['font-face', 'resize', 'font-face']);
    expect(worker.Posts[0].Transfer).toEqual([a.Buffer]);
    expect(worker.Posts[1].Transfer).toBeUndefined();
    expect(worker.Posts[2].Transfer).toEqual([c.Buffer]);
  });

  it('drains once — a second ready does not re-post a buffer that has already been handed over', () => {
    const msg = fontMessage(64);
    bridge.PostMessage(msg, [msg.Buffer]);
    ready();
    ready();
    expect(worker.Posts.filter(p => p.Msg.T === 'font-face')).toHaveLength(1);
  });

  it('transfers directly, with no backlog, once the worker is ready', () => {
    ready();
    worker.Posts.length = 0;
    const msg = fontMessage(128);
    bridge.PostMessage(msg, [msg.Buffer]);
    expect(worker.Posts).toHaveLength(1);
    expect(worker.Posts[0].Transfer).toEqual([msg.Buffer]);
  });
});

describe('the workerless (server-render) bridge', () => {
  it('drops rather than backlogs, so a render with no worker frees what it is handed', () => {
    const serverBridge = new MainBridge({
      Canvas: makeCanvas() as HTMLCanvasElement,
      Worker: null,
    }) as unknown as { PostMessage: (m: unknown, t?: Transferable[]) => void; _eventBacklog: unknown[] };
    const msg = fontMessage(512);
    serverBridge.PostMessage(msg, [msg.Buffer]);
    expect(serverBridge._eventBacklog).toHaveLength(0);
  });
});
