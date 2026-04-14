import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JivInstanceBuffer, JIV_FLOATS_PER_INSTANCE } from '../src/Jiv/Jiv.InstanceBuffer';
import { Jiv } from '../src/Jiv/Jiv';
import { LiquidGlass } from '../src/Glass/Glass.Presets';

const mockGl = () => ({
  createBuffer: vi.fn(() => ({ __id: 1 })),
  bindBuffer: vi.fn(),
  bufferData: vi.fn(),
  ARRAY_BUFFER: 0x8892,
  DYNAMIC_DRAW: 0x88E8,
}) as unknown as WebGL2RenderingContext;

beforeEach(() => {
  global.document = {
    createElement: () => ({ getContext: () => null }),
  } as unknown as Document;
});

describe('JivInstanceBuffer (single unified renderer for every Jiv)', () => {
  it('allocates 60 floats per instance', () => {
    expect(JIV_FLOATS_PER_INSTANCE).toBe(60);
  });

  it('stride is 240 bytes', () => {
    expect(JivInstanceBuffer.BytesPerInstance).toBe(240);
  });

  it('packs expected fields for a LiquidGlass Jiv', () => {
    const gl = mockGl();
    const buf = new JivInstanceBuffer(gl);
    const jiv = new Jiv({
      X: 100, Y: 200, Width: 300, Height: 60,
      Style: { ...LiquidGlass, BorderRadius: [30, 30, 30, 30] },
    });

    buf.Begin();
    buf.Push(jiv, 2);
    expect(buf.Count).toBe(1);

    const d = buf.Data;

    // loc 2 a_PanelGeom — center + halfsize in device px (dpr=2)
    // X=100 W=300 → cx = 200*2 + 300*2/2 = 200 + 300 = 500
    expect(d[4]).toBeCloseTo(200 + 300);
    expect(d[5]).toBeCloseTo(200 * 2 + 60 * 2 / 2); // 400 + 60 = 460
    expect(d[6]).toBeCloseTo(300); // halfW
    expect(d[7]).toBeCloseTo(60);  // halfH

    // loc 8 a_StyleParams.w = materialType = 1 for LiquidGlass
    expect(d[31]).toBe(1);

    // loc 10 a_Refraction — thickness * dpr, bezelWidth * dpr, refraction, bezelScale
    expect(d[36]).toBeCloseTo(LiquidGlass.Thickness! * 2);
    expect(d[37]).toBeCloseTo(LiquidGlass.BezelWidth! * 2);
    expect(d[38]).toBeCloseTo(LiquidGlass.Refraction!);
    expect(d[39]).toBeCloseTo(LiquidGlass.BezelScale!);

    // loc 11 a_Lighting — lightDir from LightAngle (135°)
    // cos(135°) ≈ -0.707, -sin(135°) ≈ -0.707
    expect(d[40]).toBeCloseTo(Math.cos((LiquidGlass.LightAngle!) * Math.PI / 180), 2);
    expect(d[41]).toBeCloseTo(-Math.sin((LiquidGlass.LightAngle!) * Math.PI / 180), 2);
    expect(d[42]).toBeCloseTo(LiquidGlass.LightIntensity!);
    expect(d[43]).toBeCloseTo(LiquidGlass.FresnelStrength!);

    // loc 12 a_Specular
    expect(d[44]).toBeCloseTo(LiquidGlass.SpecularIntensity!);
    expect(d[45]).toBeCloseTo(LiquidGlass.SpecularSharpness!);
    expect(d[46]).toBeCloseTo(LiquidGlass.ChromaticAberration!);
    expect(d[47]).toBeCloseTo(LiquidGlass.InnerBlur!);

    // loc 13 a_RimEdge
    expect(d[48]).toBeCloseTo(LiquidGlass.EdgeLightTop!);
    expect(d[49]).toBeCloseTo(LiquidGlass.EdgeLightBottom!);
    expect(d[50]).toBeCloseTo(LiquidGlass.BorderVariance!);
  });

  it('Begin resets count to 0', () => {
    const gl = mockGl();
    const buf = new JivInstanceBuffer(gl);
    buf.Push(new Jiv({ Style: { ...LiquidGlass } }), 1);
    expect(buf.Count).toBe(1);
    buf.Begin();
    expect(buf.Count).toBe(0);
  });

  it('grows capacity when exceeded', () => {
    const gl = mockGl();
    const buf = new JivInstanceBuffer(gl, 2);
    buf.Begin();
    for (let i = 0; i < 5; i++) {
      buf.Push(new Jiv({ Style: { ...LiquidGlass } }), 1);
    }
    expect(buf.Count).toBe(5);
  });
});
