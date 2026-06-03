import { describe, it, expect, beforeEach } from 'vitest';
import { JivInstanceBuffer, JIV_FLOATS_PER_INSTANCE } from '@jaui/Jiv/Jiv.InstanceBuffer';
import { Jiv } from '@jaui/Jiv/Jiv';
import { LiquidGlass } from '@jaui/Glass/Glass.Presets';

beforeEach(() => {
  global.document = {
    createElement: () => ({ getContext: () => null }),
  } as unknown as Document;
});

describe('JivInstanceBuffer (single unified renderer for every Jiv)', () => {
  // 16 vec4 slots = 64 floats (was 60/15; slot 15 added for Phase 5 Elevation,
  // translateZ, and the Space:World flag — see Three.Renderer INSTANCE_VEC4S).
  it('allocates 64 floats per instance', () => {
    expect(JIV_FLOATS_PER_INSTANCE).toBe(64);
  });

  it('stride is 256 bytes', () => {
    expect(JIV_FLOATS_PER_INSTANCE * 4).toBe(256);
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

  it('default Opacity is Presence — resolves to 0 at mount', () => {
    // Spec: implicit `Opacity: Presence` when the author doesn't set it.
    // At construction, Presence is 0, so resolved Opacity is 0. The style
    // animator's per-frame tick will spring it up to match Presence as the
    // spring value rises toward 1.
    const j = new Jiv({});
    expect(j.Style.Opacity).toBe('Presence');
    expect(j.RenderStyle.Opacity).toBe(0);
  });

  it('explicit Opacity wins over the Presence default — no fade', () => {
    const j = new Jiv({ Style: { Opacity: 1 } });
    expect(j.Style.Opacity).toBe(1);
    expect(j.RenderStyle.Opacity).toBe(1);
  });

  it('packed opacity is style.Opacity alone (no double Presence multiply)', () => {
    // Sanity: InstanceBuffer must pack RenderStyle.Opacity directly —
    // the implicit Presence fade lives in the style default, not in a
    // separate multiply here. Otherwise `Opacity: Presence` would
    // double-fade (Presence × Presence).
    const buf = new JivInstanceBuffer();
    const j = new Jiv({ Style: { Opacity: 1 } });
    buf.Begin();
    buf.Push(j, 1);
    // loc 8 a_StyleParams.z = opacity
    expect(buf.Data[30]).toBe(1);
  });
});
