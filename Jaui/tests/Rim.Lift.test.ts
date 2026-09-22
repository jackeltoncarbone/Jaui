/**
 * THE ADDITIVE RIM -- `BorderFilter: Lift(n)` on a glass rim that owns its own draw.
 *
 * A rim wants to be two things at once: BRIGHTER than what it rides, and THE SAME COLOR as what it
 * rides. A mix toward `BorderColor` can only deliver the first. `mix(in, white, w)` raises luma and
 * scales chroma by `(1 - w)`, so the ring is always less saturated than the thing it circles, by an
 * amount that varies with the rim's own taper. Measured on the live header avatar: a disc of
 * rgb(81, 45, 168) -- chroma 123, hue 258 -- wearing a ring of rgb(170, 142, 236) -- chroma 94, the
 * same hue. A LIFT is `out = in + k`, which preserves hue and chroma EXACTLY while raising luma.
 *
 * WHAT THIS FILE PINS:
 *
 *   1. THE GRAMMAR. One spelling, `Lift(n)`, signed, in 0-255 units like every other Lift; the
 *      two-argument form refused because the rim already HAS a color and it is `BorderColor`.
 *   2. THE LOCATOR. Style.Resolver parses `BorderFilter` in the BORDER zone. It did not: the call
 *      passed no zone, which is the `'backdrop'` default, so the border zone's refusals never fired
 *      in the app and `BorderFilter: Lift(60)` was accepted and silently dropped. One assertion here
 *      fails on the old code and cannot be satisfied by anything but the fix.
 *   3. THE PACKING. There is no sixteenth vertex attribute, so the AMOUNT is premultiplied into the
 *      rim's own color lane and only a FLAG is spent -- and the flag's arithmetic is exact.
 *   4. THE COMPOSITE. Modelled from the fragment's own expression: at flag 0 it is the line that
 *      shipped, term for term; at flag 1 chroma is preserved exactly, INDEPENDENTLY of the annulus
 *      coverage, which is the falsifiable claim the shots will confirm.
 *   5. THE REFUSALS. A flat stroke and a fused glass rim, each by name, each naming the draw that
 *      could not carry it.
 *
 * WHAT THIS FILE CANNOT SEE: there is no rasteriser here. The composite is modelled from the GLSL
 * expression and pinned to the shader's source; the orchestrator's shots are the proof.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { ParseFilter } from '@jaui/Core/Filter.Parse';
import { ResolveStyle, SEED_CONTEXT } from '@jaui/Core/Style.Resolver';
import { DefaultJivStyle } from '@jaui/Jiv/Jiv.Defaults';
import { Jiv } from '@jaui/Jiv/Jiv';
import { Canvas } from '@jaui/Core/Jaui';
import { BrowserPlatform } from '@jaui/Core/Platform';
import type { Renderer } from '@jaui/Core/Renderer';
import { JivInstanceBuffer, JIV_FLOATS_PER_INSTANCE, RIM_ADDITIVE_FLAG } from '@jaui/Jiv/Jiv.InstanceBuffer';

const FRAG = readFileSync(join(__dirname, '../src/Jiv/Shaders/Jiv.Panel.frag'), 'utf8').replace(/\r\n/g, '\n');

// ── 1. THE GRAMMAR ─────────────────────────────────────────────────────────────────────────────

describe('the grammar: one spelling, and the rim brings its own color', () => {
  it('takes Lift(n) in 0-255 units, signed, exactly as the other three zones do', () => {
    expect(ParseFilter('Lift(120)', 'border').Lift).toBeCloseTo(120 / 255, 12);
    expect(ParseFilter('Lift(-40)', 'border').Lift).toBeCloseTo(-40 / 255, 12);
    expect(() => ParseFilter('Lift(300)', 'border')).toThrow(/signed amount of 255/);
    // A SECOND GRAMMAR FOR THE RIM IS THE THING THIS LANE EXISTS TO AVOID: the same string means the
    // same amount in every zone that takes it, so one wash var drops into any of them unedited.
    for (const zone of ['backdrop', 'foreground', 'text', 'border'] as const) {
      expect(ParseFilter('Lift(120)', zone).Lift).toBeCloseTo(120 / 255, 12);
    }
  });

  it('merges by function beside the rim grade the house already authors', () => {
    // JwiftGlass ships `BorderFilter: Blur(-0.5pt) Brightness(1.4)`; the additive variant appends
    // `Brightness(1) Lift(120)`. Merge-by-function is plain concatenation, last occurrence wins.
    const f = ParseFilter('Blur(-0.5pt) Brightness(1.4) Brightness(1) Lift(120)', 'border');
    expect(f.BlurRaw).toBe('-0.5pt');
    expect(f.Brightness).toBe(1);
    expect(f.Lift).toBeCloseTo(120 / 255, 12);
  });

  it('refuses the two-argument form, naming BorderColor as the property that owns the rim\'s color', () => {
    // The text zone's rule, applied to the zone with the same shape: an element whose zone already
    // HAS a color takes the one-argument form only, because a second color there could only be a
    // per-channel multiplier -- one word, two meanings.
    let msg = '';
    try { ParseFilter('Lift(rgb(255, 220, 180), 18)', 'border'); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/takes <amount> only/);
    expect(msg).toMatch(/BorderColor/);
    // And the backdrop zone still takes it, so this is a per-zone rule and not a new global one.
    expect(ParseFilter('Lift(rgb(255, 220, 180), 18)', 'backdrop').LiftColor).toBe('rgb(255, 220, 180)');
  });

  it('the FRESNEL is the one zone left that refuses a lift outright', () => {
    expect(() => ParseFilter('Lift(18)', 'fresnel')).toThrow(/BorderFresnelFilter takes Brightness and Saturate only/);
  });
});

// ── 2. THE LOCATOR ─────────────────────────────────────────────────────────────────────────────

describe('the locator: BorderFilter is parsed in the BORDER zone', () => {
  it('carries the amount onto the render style, and takes a bare var like its siblings', () => {
    expect(ResolveStyle({ ...DefaultJivStyle, BorderFilter: 'Lift(120)' }, SEED_CONTEXT).BorderLift)
      .toBeCloseTo(120 / 255, 12);
    expect(ResolveStyle({ ...DefaultJivStyle }, SEED_CONTEXT).BorderLift).toBe(0);
    const vars = new Map([['JwiftRimLift', '120 * @Dark + 60 * @Light'], ['Dark', '1'], ['Light', '0']]);
    expect(ResolveStyle({ ...DefaultJivStyle, BorderFilter: 'Lift(@JwiftRimLift)' }, { ...SEED_CONTEXT, Vars: vars }).BorderLift)
      .toBeCloseTo(120 / 255, 12);
  });

  it('THE REGRESSION PIN: a border-zone refusal actually fires through the resolver', () => {
    // THE ONE ASSERTION THAT FAILS ON THE OLD CODE. `ParseFilter(raw)` defaults to the `'backdrop'`
    // zone, and the resolver's BorderFilter call passed no zone at all -- so every border filter in
    // the app was parsed, validated and CACHED as a backdrop one. `_cacheBorder` was unreachable and
    // the border zone's refusals only ever fired in a unit test that named the zone by hand.
    //
    // A two-argument Lift is legal on the backdrop and refused on the border, so it is exactly the
    // string that tells the two zones apart. Under the old locator this resolved silently.
    expect(() => ResolveStyle({ ...DefaultJivStyle, BorderFilter: 'Lift(rgb(255, 0, 0), 18)' }, SEED_CONTEXT))
      .toThrow(/BorderColor/);
  });

  it('every BorderFilter the app ships is still legal in its own zone', () => {
    // Fixing a locator can only be safe if the values it now reaches were always legal. These are the
    // distinct BorderFilter strings authored across Jwift and the app, swept 2026-09-22.
    for (const v of [
      'None',
      'Blur(-0.5pt) Brightness(1.4)',
      'Blur(-0.5pt) Brightness(1.6)',
      'Blur(-0.5pt) Brightness(2) Saturate(2)',
      'Blur(-0.5) Brightness(1.35) Saturate(1.25)',
      'Brightness(1) Saturate(1)',
      'Brightness(1.1) Saturate(1.1)',
      'Brightness(1.25) Saturate(1.5)',
      'Brightness(1.5)',
      'Brightness(1.5) Saturate(1.4)',
      'Brightness(1.7)',
      'Blur(4pt)',
    ]) {
      expect(() => ParseFilter(v, 'border'), v).not.toThrow();
    }
  });
});

// ── 3. THE PACKING ─────────────────────────────────────────────────────────────────────────────

const GLASS = {
  ...DefaultJivStyle,
  Position: 'Placed', Left: '0px', Top: '0px', Width: '48px', Height: '48px',
  Background: 'rgba(0, 0, 0, 0)',
  Thickness: '2',                 // > 0 is what makes _inferMaterial say LiquidGlass
  BorderWidth: '0.675',
  BorderColor: 'rgba(255, 255, 255, 0.5)',
  BorderLayer: '10',
  BorderAlphaVariance: '0.75',
  BorderFresnelStrength: '0.5',
  BorderFresnelBrightness: '1',
  BorderFresnelSaturation: '1.6',
} as Record<string, string>;

const pushed = (style: Record<string, string>, mode: 'Normal' | 'BorderOnly' | 'GlassBorderOnly'): Float32Array => {
  const b = new JivInstanceBuffer();
  b.Begin();
  b.Push(new Jiv({ Style: style }), 1, undefined, 0, 0, -1, mode);
  return b.Data.slice(0, JIV_FLOATS_PER_INSTANCE);
};

describe('the packing: one flag, and the amount rides the color it adds', () => {
  it('the flag cannot collide with the Fresnel grade it shares a lane with, and the sum is exact', () => {
    // _packFresnelGrade's ceiling is 1023 * 1024 + 1023.
    const maxGrade = 1023 * 1024 + 1023;
    expect(RIM_ADDITIVE_FLAG).toBeGreaterThan(maxGrade);
    // And the sum survives a float32 round trip bit for bit, which is the only precision that matters:
    // the lane is a Float32Array element and the shader reads it as a highp float.
    const f = new Float32Array(1);
    f[0] = maxGrade + RIM_ADDITIVE_FLAG;
    expect(f[0]).toBe(maxGrade + RIM_ADDITIVE_FLAG);
    expect(f[0] - RIM_ADDITIVE_FLAG).toBe(maxGrade);
  });

  it('a GlassBorderOnly rim premultiplies BorderColor by the amount and leaves its ALPHA alone', () => {
    const lit = pushed({ ...GLASS, BorderFilter: 'Lift(120)' }, 'GlassBorderOnly');
    const plain = pushed(GLASS, 'GlassBorderOnly');
    const k = Math.fround(120 / 255);
    // rgb: the color times the signed amount -- one vector, which is why no lane was needed for it.
    expect(lit[16]).toBeCloseTo(1 * k, 6);
    expect(lit[17]).toBeCloseTo(1 * k, 6);
    expect(lit[18]).toBeCloseTo(1 * k, 6);
    // alpha: THE WEIGHT, in both modes. A press raises it (0.5 -> 0.85) and must still brighten the
    // rim, so it is the one lane the lift may not touch.
    expect(lit[19]).toBe(plain[19]);
    expect(lit[19]).toBeCloseTo(0.5, 6);
    // the flag, and the Fresnel grade under it, recovered exactly.
    expect(lit[53] - RIM_ADDITIVE_FLAG).toBe(plain[53]);
  });

  it('a negative amount subtracts, which is what makes the rim SIGNED like every other lift', () => {
    const dark = pushed({ ...GLASS, BorderFilter: 'Lift(-60)' }, 'GlassBorderOnly');
    expect(dark[16]).toBeCloseTo(-60 / 255, 6);
    expect(dark[53]).toBeGreaterThan(RIM_ADDITIVE_FLAG);
  });

  it('no other push mode is touched, so a premultiplied color can never reach the flat stroke', () => {
    // The flat stroke path reads v_BorderColor.rgb as the STROKE. A premultiplied color arriving
    // there would paint a dimmed line rather than an additive one, which is why the premultiply lives
    // in the one branch that is guaranteed to reach the glass border zone.
    for (const mode of ['Normal', 'BorderOnly'] as const) {
      const lit = pushed({ ...GLASS, BorderFilter: 'Lift(120)' }, mode);
      const plain = pushed(GLASS, mode);
      expect(Array.from(lit), mode).toEqual(Array.from(plain));
    }
  });

  it('a rim with no lift is byte-identical to the instance that shipped', () => {
    const a = pushed(GLASS, 'GlassBorderOnly');
    const b = pushed({ ...GLASS, BorderFilter: 'Brightness(1.4)' }, 'GlassBorderOnly');
    expect(a[16]).toBe(1); expect(a[17]).toBe(1); expect(a[18]).toBe(1);
    expect(a[53]).toBeLessThan(RIM_ADDITIVE_FLAG);
    expect(b[53]).toBeLessThan(RIM_ADDITIVE_FLAG);
  });
});

// ── 4. THE COMPOSITE ───────────────────────────────────────────────────────────────────────────

/** `Jiv.Panel.frag`'s border composite, term for term:
 *
 *    borderRgb = mix(borderBackdrop, strokeTint, weight * (1 - additive))
 *              + borderColorRgb * (weight * additive)
 *
 *  then `result.rgb = mix(result.rgb, borderRgb, borderBase)`, where `borderBase` is the antialiased
 *  annulus -- the coverage the stroke actually has at a given pixel of its cross-section. */
const composite = (
  under: number[], gather: number[], strokeTint: number[], rgb: number[],
  weight: number, additive: number, coverage: number,
): number[] => under.map((u, i) => {
  const mixed = gather[i]! * (1 - weight * (1 - additive)) + strokeTint[i]! * (weight * (1 - additive));
  const borderRgb = mixed + rgb[i]! * (weight * additive);
  return u + (borderRgb - u) * coverage;
});

const chroma = (c: number[]): number => Math.max(...c) - Math.min(...c);
const hue = (c: number[]): number => {
  const [r, g, b] = c as [number, number, number];
  const hi = Math.max(r, g, b), lo = Math.min(r, g, b), d = hi - lo;
  if (d === 0) return 0;
  const h = hi === r ? ((g - b) / d) % 6 : hi === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return ((h * 60) % 360 + 360) % 360;
};

describe('the composite: a mix loses the color, an add keeps it', () => {
  // The header avatar, measured. The rim gathers the disc it floats over, so the disc IS the gather.
  const DISC = [81 / 255, 45 / 255, 168 / 255];
  const WHITE = [1, 1, 1];
  const K = 120 / 255;
  const LIT = 0.5 * 1.0;          // BorderColor.a 0.5, strokeBrightness 1 on the lit arc
  const DIM = 0.5 * 0.25;         // ... and its floor, 1 - BorderAlphaVariance 0.75, on the far side

  it('at flag 0 it is the line that shipped, term for term', () => {
    for (const w of [LIT, DIM, 0, 1]) {
      const old = DISC.map((u, i) => u + ((DISC[i]! * (1 - w) + WHITE[i]! * w) - u) * 1);
      expect(composite(DISC, DISC, WHITE, [K, K, K], w, 0, 1)).toEqual(old);
    }
  });

  it('the MIX scales chroma by (1 - weight): 123 becomes 94 at the measured ring', () => {
    // 94 / 123 = 0.764, and the ring measured 94. Solving (1 - w) = 0.764 puts the measured pixel at
    // an effective weight of 0.236 -- one point on a taper that runs 0.125 to 0.5. The claim being
    // pinned is the SHAPE of the loss, not that one pixel: chroma falls as the rim brightens.
    const ring = (w: number): number[] => composite(DISC, DISC, WHITE, [0, 0, 0], w, 0, 1);
    expect(chroma(ring(0)) * 255).toBeCloseTo(123, 6);
    expect(chroma(ring(LIT)) * 255).toBeCloseTo(123 * (1 - LIT), 6);
    expect(chroma(ring(DIM)) * 255).toBeCloseTo(123 * (1 - DIM), 6);
    // AND IT VARIES AROUND THE RING, which is the artefact: the lit arc is measurably less saturated
    // than the arc opposite it, although the content under both is the same color.
    expect(chroma(ring(LIT))).toBeLessThan(chroma(ring(DIM)) - 0.05);
  });

  it('the ADD preserves chroma and hue EXACTLY, at every point of the taper', () => {
    const ring = (w: number): number[] => composite(DISC, DISC, WHITE, [K, K, K], w, 1, 1);
    for (const w of [0, DIM, 0.25, LIT]) {
      expect(chroma(ring(w)) * 255).toBeCloseTo(123, 6);
      expect(hue(ring(w))).toBeCloseTo(hue(DISC), 6);
    }
    // ... and the LUMA taper is intact and linear in the weight, which is what keeps the varying
    // thickness Jack asked for: the lit arc's rise above the disc is exactly 4x the far side's,
    // because strokeBrightness runs from its 0.25 floor to 1.
    const rise = (w: number): number => ring(w)[0]! - DISC[0]!;
    expect(rise(LIT) / rise(DIM)).toBeCloseTo(4, 6);
  });

  it('chroma survives the ANTIALIASED ANNULUS, which is the prediction a shot can falsify', () => {
    // A measured ring pixel is `mix(disc, borderRgb, coverage)` for whatever coverage that pixel of
    // the hairline has. Under the ADD both ends of that segment have the SAME chroma and hue, so
    // every point on it does -- the measurement cannot be diluted by antialiasing. Under the MIX the
    // two ends differ, so the measured chroma depends on where in the stroke the probe landed, which
    // is exactly why the shipped ring measured 94 rather than a number anyone predicted.
    for (const c of [0.1, 0.25, 0.5, 0.75, 1]) {
      expect(chroma(composite(DISC, DISC, WHITE, [K, K, K], LIT, 1, c)) * 255).toBeCloseTo(123, 6);
      expect(hue(composite(DISC, DISC, WHITE, [K, K, K], LIT, 1, c))).toBeCloseTo(hue(DISC), 6);
    }
    const mixedChroma = [0.1, 0.5, 1].map((c) => chroma(composite(DISC, DISC, WHITE, [0, 0, 0], LIT, 0, c)));
    expect(new Set(mixedChroma.map((v) => Math.round(v * 255))).size).toBe(3);
  });

  it('the first 8-bit backdrop code at which each amount starts to clip', () => {
    // A lift CLIPS at 255 and clipping is the one thing that shifts a hue: the channel that reaches
    // full stops moving while the others keep going, so the rim converges on white -- the mix again,
    // by another route. Derived, not restated.
    const clipsFrom = (n: number, w: number): number => {
      for (let k = 0; k <= 255; k++) if (k / 255 + (n / 255) * w > 1 + 1e-9) return k;
      return -1;
    };
    // The rule is `256 - n`, and stating it is what stops the three numbers drifting apart. The brief
    // this lane was written from carried 238 / 226 / 205; the first two are the rule and the third is
    // a slip -- 205 + 50 is exactly 255, the last code that still lands unclipped.
    for (const n of [18, 30, 50, 120]) expect(clipsFrom(n, 1), `Lift(${n})`).toBe(256 - n);
    expect(clipsFrom(18, 1)).toBe(238);
    expect(clipsFrom(30, 1)).toBe(226);
    expect(clipsFrom(50, 1)).toBe(206);
    // At the shipped amount and the fully lit arc the rim adds 60, so it clips from a backdrop
    // channel of 196. The header avatar's disc peaks at 168 on blue, which leaves 27 to spare.
    expect(clipsFrom(120, LIT)).toBe(196);
    expect(168 + Math.round(120 * LIT)).toBeLessThan(255);
  });

  it('the shader carries exactly this expression, and unpacks the flag before the grade', () => {
    expect(FRAG).toContain('float rimAdditive = step(2097152.0, v_Outline.y);');
    expect(FRAG).toContain('float fresnelPacked = v_Outline.y - rimAdditive * 2097152.0;');
    expect(FRAG).toContain('float rimWeight = v_BorderColor.a * strokeBrightness;');
    expect(FRAG).toContain('mix(borderBackdrop, strokeTint, rimWeight * (1.0 - rimAdditive))');
    expect(FRAG).toContain('+ v_BorderColor.rgb * (rimWeight * rimAdditive);');
    // The Fresnel grade must come off `fresnelPacked`, never the raw lane, or an additive rim would
    // read a Fresnel brightness 2048x too high.
    expect(FRAG).toContain('float fbCode = floor(fresnelPacked / 1024.0);');
    expect(FRAG).not.toContain('float fbCode = floor(v_Outline.y / 1024.0);');
  });
});

// ── 5. THE REFUSALS ────────────────────────────────────────────────────────────────────────────

const canvas = (): Canvas => new Canvas(
  new OffscreenCanvas(64, 64) as unknown as HTMLCanvasElement,
  new Proxy({}, { get: (_t, k) => (k === 'then' ? undefined : () => undefined) }) as unknown as Renderer,
  BrowserPlatform,
);
const refuse = (style: Record<string, string>): string => {
  const c = canvas() as unknown as { _refuseRimLift: (n: Jiv) => void };
  try { c._refuseRimLift(new Jiv({ Style: style })); } catch (e) { return (e as Error).message; }
  return '';
};

describe('the refusals: each names the draw that could not carry it', () => {
  it('a FLAT stroke refuses, because it has no gather to add to', () => {
    // The obstacle `Filter.Parse._refuseLift` measured, and the half of it that still stands. It is
    // enforced HERE rather than at the parse because the parse cannot see the material.
    const msg = refuse({ ...GLASS, Thickness: '0', BorderFilter: 'Lift(120)' });
    expect(msg).toMatch(/FLAT stroke/);
    expect(msg).toMatch(/same fragment as the fill/);   // one draw, one blend state
    expect(msg).toMatch(/borders-only element/);        // and what DOES work instead
    expect(msg).toMatch(/BackdropFilter/);              // the property that owns the alternative
  });

  it('a FUSED glass rim refuses, because its gather is not what it rides', () => {
    // BorderLayer 0 leaves the stroke in the panel's own fragment, where it gathers the scene BEHIND
    // the card -- which the card's fill then covers. Adding to that lifts what nobody can see.
    const msg = refuse({ ...GLASS, BorderLayer: '0', BorderFilter: 'Lift(120)' });
    expect(msg).toMatch(/BorderLayer is 0/);
    expect(msg).toMatch(/gathers the scene BEHIND/);
  });

  it('a rim with nothing to lift refuses, and says which half of BorderColor is missing', () => {
    // The lift rides BorderColor: its rgb is what gets added and its ALPHA is the weight, so a zero
    // alpha multiplies the whole offset away. That is a silent no-op, which this file refuses on
    // principle -- the same principle the Fresnel zone's Blur() refusal is written from.
    expect(refuse({ ...GLASS, BorderColor: 'rgba(255, 255, 255, 0)', BorderFilter: 'Lift(120)' }))
      .toMatch(/no stroke at all/);
    expect(refuse({ ...GLASS, BorderWidth: '0', BorderFilter: 'Lift(120)' }))
      .toMatch(/no stroke at all/);
  });

  it('the rim the header avatar actually wears passes all three', () => {
    expect(refuse({ ...GLASS, BorderFilter: 'Lift(120)' })).toBe('');
  });

  it('the refusal is asked ONLY of a node that authored one', () => {
    // Gated on the amount at the call site, so a node with no rim lift pays one compare against a
    // float already in cache and never reaches the predicate at all.
    const src = readFileSync(join(__dirname, '../src/Core/Jaui.ts'), 'utf8').replace(/\r\n/g, '\n');
    expect(src).toContain('if (phasedPaints && node.RenderStyle.BorderLift !== 0) this._refuseRimLift(node);');
  });
});
