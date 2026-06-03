import { describe, it, expect, vi } from 'vitest';
import { WorkerBridge, PlatformInitFromMessage } from '@jaui/Worker/Bridge.Worker';
import { WorkerPlatform } from '@jaui/Worker/Worker.Platform';
import type { M2W_Init, W2M, PointerPayload } from '@jaui/Worker/Bridge.Types';

const _initMsg = (): M2W_Init => ({
  T: 'init',
  Canvas: null as unknown as OffscreenCanvas,
  Width: 800, Height: 600,
  DevicePixelRatio: 2,
  IsPointerCoarse: false,
  UrlSearch: '',
  UrlHash: '',
  FontsAlreadyReady: true,
});

const _ptr = (over: Partial<PointerPayload> = {}): PointerPayload => ({
  PointerId: 1,
  PointerType: 'mouse',
  X: 50, Y: 50,
  ClientX: 50, ClientY: 50,
  Buttons: 0,
  Button: 0,
  Shift: false, Ctrl: false, Alt: false, Meta: false,
  TimeStamp: 100,
  ...over,
});

// Minimal Canvas mock — bridge calls IngestEvent / ResizeFromBridge /
// SetJssVars / Start / Stop / OnCursorChange / OnPointerCaptureRequest.
const _mockCanvas = () => ({
  IngestEvent: vi.fn(),
  IngestPointerCaptureGranted: vi.fn(),
  IngestPointerCaptureReleased: vi.fn(),
  ResizeFromBridge: vi.fn(),
  SetJssVars: vi.fn(),
  Start: vi.fn(),
  Stop: vi.fn(),
  OnCursorChange: vi.fn(),
  OnPointerCaptureRequest: vi.fn(),
  OnSelectionTextChange: vi.fn(),
});

describe('WorkerBridge — inbound dispatch', () => {
  it('routes M2W_Init through OnInit hook', () => {
    const post = vi.fn();
    const bridge = new WorkerBridge(post);
    const onInit = vi.fn();
    bridge.OnInit = onInit;

    const m = _initMsg();
    bridge.HandleMessage(m);
    expect(onInit).toHaveBeenCalledWith(m);
  });

  it('routes M2W_PointerEvent to Canvas.IngestEvent with synth payload', () => {
    const post = vi.fn<PostFn>();
    const bridge = new WorkerBridge(post);
    const canvas = _mockCanvas();
    const platform = new WorkerPlatform(PlatformInitFromMessage(_initMsg()));
    bridge.AttachPlatform(platform);
    bridge.AttachCanvas(canvas as never);

    bridge.HandleMessage({
      T: 'pointer',
      Kind: 'pointermove',
      Payload: _ptr({ X: 100, Y: 200 }),
    });
    expect(canvas.IngestEvent).toHaveBeenCalledOnce();
    const [kind, e] = canvas.IngestEvent.mock.calls[0];
    expect(kind).toBe('pointermove');
    expect(e.clientX).toBe(100); // pre-translated to canvas-local
    expect(e.clientY).toBe(200);
    expect(e.pointerId).toBe(1);
    expect(typeof e.preventDefault).toBe('function');
    expect(typeof e.getCoalescedEvents).toBe('function');
    expect(e.getCoalescedEvents()).toEqual([]);
  });

  it('forwards coalesced pointermove samples to getCoalescedEvents()', () => {
    const post = vi.fn();
    const bridge = new WorkerBridge(post);
    const canvas = _mockCanvas();
    const platform = new WorkerPlatform(PlatformInitFromMessage(_initMsg()));
    bridge.AttachPlatform(platform);
    bridge.AttachCanvas(canvas as never);

    bridge.HandleMessage({
      T: 'pointer',
      Kind: 'pointermove',
      Payload: _ptr({ X: 100, Y: 100 }),
      Coalesced: [
        _ptr({ X: 90, Y: 95 }),
        _ptr({ X: 95, Y: 98 }),
      ],
    });
    const e = canvas.IngestEvent.mock.calls[0][1];
    const coalesced = e.getCoalescedEvents();
    expect(coalesced).toHaveLength(2);
    expect(coalesced[0].clientX).toBe(90);
    expect(coalesced[1].clientX).toBe(95);
  });

  it('routes M2W_WheelEvent with deltaX/Y/Mode preserved', () => {
    const post = vi.fn();
    const bridge = new WorkerBridge(post);
    const canvas = _mockCanvas();
    const platform = new WorkerPlatform(PlatformInitFromMessage(_initMsg()));
    bridge.AttachPlatform(platform);
    bridge.AttachCanvas(canvas as never);

    bridge.HandleMessage({
      T: 'wheel',
      Payload: { ..._ptr(), DeltaX: 0, DeltaY: 120, DeltaMode: 0 },
    });
    expect(canvas.IngestEvent).toHaveBeenCalledOnce();
    const [kind, e] = canvas.IngestEvent.mock.calls[0];
    expect(kind).toBe('wheel');
    expect(e.deltaY).toBe(120);
    expect(e.deltaMode).toBe(0);
  });

  it('routes touchstart as a no-payload IngestEvent', () => {
    const post = vi.fn();
    const bridge = new WorkerBridge(post);
    const canvas = _mockCanvas();
    const platform = new WorkerPlatform(PlatformInitFromMessage(_initMsg()));
    bridge.AttachPlatform(platform);
    bridge.AttachCanvas(canvas as never);

    bridge.HandleMessage({ T: 'touchstart' });
    expect(canvas.IngestEvent).toHaveBeenCalledOnce();
    expect(canvas.IngestEvent.mock.calls[0][0]).toBe('touchstart');
  });

  it('routes M2W_Resize to ResizeFromBridge', () => {
    const post = vi.fn();
    const bridge = new WorkerBridge(post);
    const canvas = _mockCanvas();
    const platform = new WorkerPlatform(PlatformInitFromMessage(_initMsg()));
    bridge.AttachPlatform(platform);
    bridge.AttachCanvas(canvas as never);

    bridge.HandleMessage({ T: 'resize', Width: 1024, Height: 768 });
    expect(canvas.ResizeFromBridge).toHaveBeenCalledWith(1024, 768);
  });

  it('routes M2W_DprChange through Platform (does NOT call Canvas)', () => {
    const post = vi.fn();
    const bridge = new WorkerBridge(post);
    const canvas = _mockCanvas();
    const platform = new WorkerPlatform(PlatformInitFromMessage(_initMsg()));
    bridge.AttachPlatform(platform);
    bridge.AttachCanvas(canvas as never);

    bridge.HandleMessage({ T: 'dpr', DevicePixelRatio: 3 });
    expect(platform.GetDevicePixelRatio()).toBe(3);
    expect(canvas.IngestEvent).not.toHaveBeenCalled();
    expect(canvas.ResizeFromBridge).not.toHaveBeenCalled();
  });

  it('routes M2W_JssVars to SetJssVars with deserialized Map', () => {
    const post = vi.fn();
    const bridge = new WorkerBridge(post);
    const canvas = _mockCanvas();
    const platform = new WorkerPlatform(PlatformInitFromMessage(_initMsg()));
    bridge.AttachPlatform(platform);
    bridge.AttachCanvas(canvas as never);

    bridge.HandleMessage({ T: 'jss-vars', Entries: [['Primary', '#fff'], ['Gap', '8pt']] });
    expect(canvas.SetJssVars).toHaveBeenCalledOnce();
    const map = canvas.SetJssVars.mock.calls[0][0] as Map<string, string>;
    expect(map.get('Primary')).toBe('#fff');
    expect(map.get('Gap')).toBe('8pt');
  });

  it('routes M2W_Control start → Canvas.Start, stop → Canvas.Stop', () => {
    const post = vi.fn();
    const bridge = new WorkerBridge(post);
    const canvas = _mockCanvas();
    const platform = new WorkerPlatform(PlatformInitFromMessage(_initMsg()));
    bridge.AttachPlatform(platform);
    bridge.AttachCanvas(canvas as never);

    bridge.HandleMessage({ T: 'control', Action: 'start' });
    expect(canvas.Start).toHaveBeenCalledOnce();
    bridge.HandleMessage({ T: 'control', Action: 'stop' });
    expect(canvas.Stop).toHaveBeenCalledOnce();
  });

  it('ignores garbage / non-message payloads silently', () => {
    const post = vi.fn();
    const bridge = new WorkerBridge(post);
    expect(() => {
      bridge.HandleMessage(null);
      bridge.HandleMessage('not-an-object');
      bridge.HandleMessage(42);
      bridge.HandleMessage({ unknownTag: true });
    }).not.toThrow();
  });
});

describe('WorkerBridge — outbound (W2M) wiring', () => {
  it('AttachCanvas wires cursor relay → post({T:"cursor", Cursor})', () => {
    const post = vi.fn<PostFn>();
    const bridge = new WorkerBridge(post);
    let cursorCb: ((c: string) => void) | null = null;
    const canvas = {
      ..._mockCanvas(),
      OnCursorChange: vi.fn((cb) => { cursorCb = cb; }),
    };
    bridge.AttachCanvas(canvas as never);
    cursorCb!('pointer');
    expect(post).toHaveBeenCalledWith({ T: 'cursor', Cursor: 'pointer' });
  });

  it('AttachCanvas wires pointer-capture relay → post({T:"capture", ...})', () => {
    const post = vi.fn<PostFn>();
    const bridge = new WorkerBridge(post);
    let captureCb: ((a: 'set' | 'release', id: number) => void) | null = null;
    const canvas = {
      ..._mockCanvas(),
      OnPointerCaptureRequest: vi.fn((cb) => { captureCb = cb; }),
    };
    bridge.AttachCanvas(canvas as never);
    captureCb!('set', 7);
    expect(post).toHaveBeenCalledWith({ T: 'capture', Action: 'set', PointerId: 7 });
    captureCb!('release', 7);
    expect(post).toHaveBeenCalledWith({ T: 'capture', Action: 'release', PointerId: 7 });
  });
});

describe('PlatformInitFromMessage helper', () => {
  it('maps init fields to WorkerPlatformInit', () => {
    const init = PlatformInitFromMessage(_initMsg());
    expect(init.Dpr).toBe(2);
    expect(init.IsPointerCoarse).toBe(false);
    expect(init.IsTextInputFocused).toBe(false); // default false; main pushes via M2W_FocusChange
    expect(init.FontsAlreadyReady).toBe(true);
  });
});

// Avoid unused-type imports — keep the local alias visible.
type PostFn = (msg: W2M) => void;
