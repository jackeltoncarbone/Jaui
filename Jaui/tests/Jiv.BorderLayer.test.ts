import { describe, it, expect, beforeEach } from 'vitest';
import { JivInstanceBuffer } from '../src/Jiv/Jiv.InstanceBuffer';
import { Jiv } from '../src/Jiv/Jiv';

beforeEach(() => {
  global.document = {
    createElement: () => ({ getContext: () => null }),
  } as unknown as Document;
});

// A Jiv with a solid orange fill, a visible border, and a drop shadow — the
// three channels BorderLayer's paint-reordering manipulates.
const Bordered = {
  Background: 'rgb(255, 138, 0)',
  BorderColor: 'rgba(255, 255, 255, 1)',
  BorderWidth: 16,
  ShadowColor: 'rgba(0, 0, 0, 1)',
  ShadowBlur: 8,
  Opacity: 1,
};

describe('BorderLayer — resolution + default', () => {
  it('defaults to 0 (border fused with the panel, today\'s order)', () => {
    const j = new Jiv({});
    expect(j.Style.BorderLayer).toBe('0');
    expect(j.RenderStyle.BorderLayer).toBe(0);
  });

  it('resolves an authored negative value', () => {
    const j = new Jiv({ Style: { BorderLayer: -1 } });
    expect(j.RenderStyle.BorderLayer).toBe(-1);
  });

  it('resolves an authored positive value', () => {
    const j = new Jiv({ Style: { BorderLayer: 2 } });
    expect(j.RenderStyle.BorderLayer).toBe(2);
  });
});

describe('BorderLayer — InstanceBuffer borderMode packing', () => {
  it("'Normal' keeps border + fill + shadow (byte-identical to default)", () => {
    const buf = new JivInstanceBuffer();
    const j = new Jiv({ Width: 100, Height: 100, Style: { ...Bordered } });
    buf.Begin();
    buf.Push(j, 1, undefined, 0, 0, -1, 'Normal');
    const d = buf.Data;
    expect(d[27]).toBeGreaterThan(0);   // borderWidth present
    expect(d[19]).toBeCloseTo(1);       // BorderColor.A present
    expect(d[15]).toBeCloseTo(1);       // Background.A present
    expect(d[23]).toBeCloseTo(1);       // ShadowColor.A present
  });

  it("'Suppress' zeroes the border so the fused panel paints no stroke", () => {
    const buf = new JivInstanceBuffer();
    const j = new Jiv({ Width: 100, Height: 100, Style: { ...Bordered } });
    buf.Begin();
    buf.Push(j, 1, undefined, 0, 0, -1, 'Suppress');
    const d = buf.Data;
    expect(d[27]).toBe(0);              // borderWidth zeroed
    expect(d[16]).toBe(0);              // BorderColor.R
    expect(d[19]).toBe(0);              // BorderColor.A
    // Fill + shadow untouched — the panel still draws its background.
    expect(d[15]).toBeCloseTo(1);       // Background.A intact
    expect(d[23]).toBeCloseTo(1);       // ShadowColor.A intact
  });

  it("'BorderOnly' strips fill + shadow + thickness, keeps the stroke", () => {
    const buf = new JivInstanceBuffer();
    const j = new Jiv({ Width: 100, Height: 100, Style: { ...Bordered } });
    buf.Begin();
    buf.Push(j, 1, undefined, 0, 0, -1, 'BorderOnly');
    const d = buf.Data;
    expect(d[15]).toBe(0);              // Background.A → no fill
    expect(d[23]).toBe(0);              // ShadowColor.A → no shadow
    expect(d[36]).toBe(0);              // Thickness → non-glass stroke path
    // The stroke itself survives.
    expect(d[27]).toBeGreaterThan(0);   // borderWidth intact
    expect(d[19]).toBeCloseTo(1);       // BorderColor.A intact
  });
});
