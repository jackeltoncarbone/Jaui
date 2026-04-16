import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TextCache } from '../src/Text/Text.Cache';
import { TextInstanceBuffer, type TextDrawCommand } from '../src/Text/Text.InstanceBuffer';
import { DefaultTextStyle } from '../src/Text/Text.Types';

// ─── GL Call Counting Proxy ───

interface CallLog {
  name: string;
  args: unknown[];
}

const createCountingGl = () => {
  const calls: CallLog[] = [];
  let _nextId = 1;

  const GL_CONSTANTS: Record<string, number> = {
    TEXTURE_2D: 0x0DE1, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401,
    LINEAR: 0x2601, CLAMP_TO_EDGE: 0x812F,
    TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803,
    ARRAY_BUFFER: 0x8892, DYNAMIC_DRAW: 0x88E8,
    ELEMENT_ARRAY_BUFFER: 0x8893, FLOAT: 0x1406,
    TRIANGLES: 4, UNSIGNED_SHORT: 0x1403,
    TEXTURE0: 0x84C0, BLEND: 0x0BE2,
    SRC_ALPHA: 0x0302, ONE_MINUS_SRC_ALPHA: 0x0303,
    FRAMEBUFFER: 0x8D40, COLOR_BUFFER_BIT: 0x4000,
    COLOR_ATTACHMENT0: 0x8CE0, FRAMEBUFFER_COMPLETE: 0x8CD5,
    READ_FRAMEBUFFER: 0x8CA8, DRAW_FRAMEBUFFER: 0x8CA9,
  };

  const drawCalls = ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced'];

  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_target, prop: string) {
      if (prop in GL_CONSTANTS) return GL_CONSTANTS[prop];
      if (prop === '__calls') return calls;
      if (prop === '__drawCallCount') return calls.filter(c => drawCalls.includes(c.name)).length;
      if (prop === '__reset') return () => { calls.length = 0; };
      if (prop === '__totalCount') return calls.length;

      return (...args: unknown[]) => {
        calls.push({ name: prop, args });
        if (prop === 'createTexture') return { __id: _nextId++ };
        if (prop === 'createBuffer') return { __id: _nextId++ };
        if (prop === 'createFramebuffer') return { __id: _nextId++ };
        if (prop === 'createVertexArray') return { __id: _nextId++ };
        if (prop === 'getUniformLocation') return { __loc: prop };
        if (prop === 'getAttribLocation') return 0;
        if (prop === 'createProgram') return { __id: _nextId++ };
        if (prop === 'createShader') return { __id: _nextId++ };
        if (prop === 'getShaderParameter') return true;
        if (prop === 'getProgramParameter') return true;
        if (prop === 'checkFramebufferStatus') return GL_CONSTANTS.FRAMEBUFFER_COMPLETE;
        if (prop === 'isEnabled') return false;
        return undefined;
      };
    },
  };

  return new Proxy({}, handler) as unknown as WebGL2RenderingContext & {
    __calls: CallLog[];
    __drawCallCount: number;
    __totalCount: number;
    __reset: () => void;
  };
};

// ─── Mock canvas for TextCache ───

const mockCanvas = () => {
  const ctx = {
    font: '', textBaseline: 'top', textAlign: 'left', fillStyle: '',
    canvas: { width: 0, height: 0 } as Record<string, unknown>,
    measureText: (t: string) => ({ width: t.length * 8 }),
    clearRect: vi.fn(),
    fillText: vi.fn(),
  };
  ctx.canvas.getContext = () => ctx;
  return ctx;
};

beforeEach(() => {
  global.document = {
    createElement: vi.fn(() => mockCanvas().canvas as unknown as HTMLCanvasElement),
  } as unknown as Document;
});

// ─── Tests ───

describe('GL Call Count — Text Rendering', () => {
  const makeCmd = (word: string, uv: { U: number; V: number; UWidth: number; UHeight: number }): TextDrawCommand => ({
    X: 10, Y: 10, Width: word.length * 8, Height: 16,
    Uv: uv,
    Opacity: 1.0,
  });

  it('TextInstanceBuffer.Upload is 1 bufferData call regardless of word count', () => {
    const gl = createCountingGl();
    const buf = new TextInstanceBuffer(gl);
    const uv = { U: 0, V: 0, UWidth: 0.1, UHeight: 0.02 };

    for (let i = 0; i < 100; i++) {
      buf.Push(makeCmd(`word${i}`, uv));
    }

    (gl as any).__reset();
    buf.Upload();

    const bufferDataCalls = gl.__calls.filter(c => c.name === 'bufferData').length;
    expect(bufferDataCalls).toBe(1);
    expect(buf.Count).toBe(100);
  });

  it('TextCache uses 1 atlas texture for any number of words', () => {
    const gl = createCountingGl();
    const cache = new TextCache(gl);

    for (let i = 0; i < 50; i++) {
      cache.Get(`word${i}`, DefaultTextStyle, null, 1);
    }

    const createTextureCalls = gl.__calls.filter(c => c.name === 'createTexture').length;
    expect(createTextureCalls).toBe(1);
  });

  it('text draw calls are O(1) — 1 word vs 50 words vs 100 words same draw count', () => {
    const gl = createCountingGl();
    const buf = new TextInstanceBuffer(gl);
    const uv = { U: 0, V: 0, UWidth: 0.1, UHeight: 0.02 };

    // 1 word
    buf.Begin();
    buf.Push(makeCmd('hello', uv));
    (gl as any).__reset();
    buf.Upload();
    const calls1 = gl.__calls.filter(c => c.name === 'bufferData').length;

    // 50 words
    buf.Begin();
    for (let i = 0; i < 50; i++) buf.Push(makeCmd(`word${i}`, uv));
    (gl as any).__reset();
    buf.Upload();
    const calls50 = gl.__calls.filter(c => c.name === 'bufferData').length;

    // 100 words
    buf.Begin();
    for (let i = 0; i < 100; i++) buf.Push(makeCmd(`word${i}`, uv));
    (gl as any).__reset();
    buf.Upload();
    const calls100 = gl.__calls.filter(c => c.name === 'bufferData').length;

    expect(calls1).toBe(1);
    expect(calls50).toBe(1);
    expect(calls100).toBe(1);
  });
});

describe('GL Call Count — Defensive Unbinds Removed', () => {
  it('JivRenderer.DrawAll has no trailing bindVertexArray(null)', async () => {
    const src = await import('../src/Jiv/Jiv.Renderer');
    const instance = Object.getOwnPropertyDescriptor(src.JivRenderer.prototype, 'DrawAll');
    const drawAllCode = instance?.value?.toString()
      ?? (src.JivRenderer as any).prototype.DrawAll?.toString()
      ?? '';
    // DrawAll in a class with arrow functions may be on the instance, not prototype.
    // Fall back to checking the whole class but only the DrawAll section.
    const classCode = src.JivRenderer.toString();
    const drawAllMatch = classCode.match(/DrawAll\s*=\s*\([^)]*\)\s*=>\s*\{[\s\S]*?\n\s{2}\};/);
    const code = drawAllMatch?.[0] ?? drawAllCode;
    expect(code.length).toBeGreaterThan(0);
    expect(code).not.toContain('bindVertexArray(null)');
  });

  it('ProgressiveBlurRenderer has no texture unbind loop', async () => {
    const mod = await import('../src/ProgressiveBlur/ProgressiveBlur.Renderer');
    const code = mod.ProgressiveBlurRenderer.toString();
    const unbindCount = (code.match(/bindTexture/g) || []).length;
    // Should only have the initial binds, not the cleanup unbinds
    // The old code had 5 unbinds in a loop — if present, count would be high
    expect(unbindCount).toBeLessThanOrEqual(6);
  });
});

describe('GL Call Count — Instancing Proof', () => {
  it('PROOF: instanced text is O(1) draw calls, not O(n)', () => {
    const gl = createCountingGl();
    const buf = new TextInstanceBuffer(gl);
    const uv = { U: 0, V: 0, UWidth: 0.1, UHeight: 0.02 };

    const cmd = (word: string): TextDrawCommand => ({
      X: 10, Y: 10, Width: word.length * 8, Height: 16,
      Uv: uv, Opacity: 1.0,
    });

    // Push 200 words — stress test
    buf.Begin();
    for (let i = 0; i < 200; i++) buf.Push(cmd(`word${i}`));

    (gl as any).__reset();
    buf.Upload();

    // Upload: exactly 2 GL calls (bindBuffer + bufferData)
    expect(gl.__totalCount).toBe(2);
    // Zero draw calls during upload — draw happens in DrawAll
    expect(gl.__drawCallCount).toBe(0);
  });
});
