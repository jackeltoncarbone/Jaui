import { describe, it, expect, beforeEach } from 'vitest';
import { JivInstanceBuffer, JIV_FLOATS_PER_INSTANCE } from '../src/Jiv/Jiv.InstanceBuffer';
import { Jiv } from '../src/Jiv/Jiv';
import { LiquidGlass } from '../src/Glass/Glass.Presets';

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
    expect(JIV_FLOATS_PER_INSTANCE * 4).toBe(240);
  });

  it('packs expected fields for a LiquidGlass Jiv', () => {
    const buf = new JivInstanceBuffer();
    const jiv = new Jiv({
      X: 100, Y: 200, Width: 300, Height: 60,
      Style: { ...LiquidGlass, BorderRadius: [30, 30, 30, 30] },
    });

    buf.Begin();
    buf.Push(jiv, 2);
    expect(buf.Count).toBe(1);

    const d = buf.Data;

    // loc 2 a_PanelGeom — center + halfsize in device px (dpr=2)
    expect(d[4]).toBeCloseTo(200 + 300);
    expect(d[5]).toBeCloseTo(200 * 2 + 60 * 2 / 2);
    expect(d[6]).toBeCloseTo(300);
    expect(d[7]).toBeCloseTo(60);

    // loc 8 a_StyleParams.w = materialType = 1 for LiquidGlass
    expect(d[31]).toBe(1);

    // loc 10 a_Refraction
    expect(d[36]).toBeCloseTo(LiquidGlass.Thickness! * 2);
    expect(d[37]).toBeCloseTo(LiquidGlass.BezelWidth! * 2);
    expect(d[38]).toBeCloseTo(LiquidGlass.Refraction!);
    expect(d[39]).toBeCloseTo(LiquidGlass.BezelScale!);

    // loc 11 a_Lighting
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
    const buf = new JivInstanceBuffer();
    buf.Push(new Jiv({ Style: { ...LiquidGlass } }), 1);
    expect(buf.Count).toBe(1);
    buf.Begin();
    expect(buf.Count).toBe(0);
  });

  it('grows capacity when exceeded', () => {
    const buf = new JivInstanceBuffer(2);
    buf.Begin();
    for (let i = 0; i < 5; i++) {
      buf.Push(new Jiv({ Style: { ...LiquidGlass } }), 1);
    }
    expect(buf.Count).toBe(5);
  });
});
