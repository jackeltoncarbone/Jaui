import { describe, it, expect, beforeEach } from 'vitest';
import { FLEX_AUTO, FlexHeld, FlexMotion, FlexSpecFor, type FlexAmounts, type FlexKind } from '../src/Core/Flex';
import { ResolveStyle, SEED_CONTEXT } from '../src/Core/Style.Resolver';
import { DefaultJivStyle } from '../src/Jiv/Jiv.Defaults';
import { Jiv } from '../src/Jiv/Jiv';
import { JivStyleAnimator } from '../src/Jiv/Jiv.StyleAnimator';
import type { JivStyle } from '../src/Jiv/Jiv.Types';

beforeEach(() => {
  (global as unknown as { document: object }).document = {
    createElement: () => ({ getContext: () => null }),
  };
});

const resolve = (patch: Partial<JivStyle>) => ResolveStyle({ ...DefaultJivStyle, ...patch } as JivStyle, SEED_CONTEXT);

describe('Flex* resolve', () => {
  it('reads Auto as a weight on the spec and FlexStretch Auto as 1', () => {
    const r = resolve({ Flex: 'Auto' });
    expect(r.Flex).toBe('Auto');
    expect([r.FlexLift, r.FlexLiftAuto, r.FlexBigGlowAuto, r.FlexLittleGlowAuto, r.FlexStretch]).toEqual([0, 1, 1, 1, 1]);
  });

  it('reads numbers as authored, clamped to their ranges', () => {
    const r = resolve({ Flex: 'Auto', FlexLift: '8', FlexBigGlow: '2', FlexLittleGlow: '0.4', FlexStretch: '1.5' });
    expect([r.FlexLift, r.FlexLiftAuto]).toEqual([8, 0]);
    expect([r.FlexBigGlow, r.FlexBigGlowAuto]).toEqual([1, 0]);
    expect([r.FlexLittleGlow, r.FlexLittleGlowAuto]).toEqual([0.4, 0]);
    expect(r.FlexStretch).toBe(1.5);
    expect(resolve({ FlexStretch: '-1' }).FlexStretch).toBe(0);
  });

  it('rejects an unknown kind', () => {
    expect(() => resolve({ Flex: 'Huge' })).toThrow(/Flex/);
  });

  it('FlexHold defaults to 0, has no Auto, and clamps to 0..1', () => {
    expect(resolve({ Flex: 'Auto' }).FlexHold).toBe(0);
    expect(resolve({ Flex: 'Auto', FlexHold: '1' }).FlexHold).toBe(1);
    expect(resolve({ Flex: 'Auto', FlexHold: '0.4' }).FlexHold).toBe(0.4);
    expect(resolve({ Flex: 'Auto', FlexHold: '2' }).FlexHold).toBe(1);
    expect(resolve({ Flex: 'Auto', FlexHold: '-1' }).FlexHold).toBe(0);
  });
});

/** Drives one press: down at the centre, a drag past the right edge, a few frames of acceleration. */
const press = (kind: FlexKind, width: number, height: number, stretch: number): FlexMotion => {
  const motion = new FlexMotion();
  const amounts: FlexAmounts = { ...FLEX_AUTO, FlexStretch: stretch };
  expect(motion.Begin(width / 2, height / 2, width, height, 1, kind, amounts, 0)).toBe(true);
  let t = 0;
  for (let i = 1; i <= 6; i++) {
    t += 16;
    motion.Move(width / 2 + i * i * 12, height / 2 + i * 2, t);
    motion.Step(0.016);
  }
  return motion;
};

describe('FlexStretch math', () => {
  for (const [kind, width, height] of [['Small', 100, 44], ['Large', 320, 200]] as const) {
    it(`scales the stretch and squash linearly about the lift on a ${kind} control`, () => {
      const spec = FlexSpecFor(kind, width, height)!;
      const lift = (Math.max(width, height) + spec.Lift) / Math.max(width, height);
      const [none, apple, more] = [0, 1, 1.5].map((k) => press(kind, width, height, k));
      const dev = (m: FlexMotion) => [m.ScaleX.Target - lift, m.ScaleY.Target - lift, m.TranslateX.Target, m.TranslateY.Target];

      expect(dev(none).every((d) => Math.abs(d) < 1e-9)).toBe(true);
      expect(Math.abs(dev(apple)[0])).toBeGreaterThan(1e-4);
      dev(more).forEach((d, i) => expect(d).toBeCloseTo(1.5 * dev(apple)[i], 9));
      // Apple's squash stays inside its rubber band: past movementPoints only by the band's tanh.
      const band = (spec.MaxScale - spec.MinScale) / 3;
      expect(apple.ScaleY.Target - lift).toBeGreaterThan(-(1 - spec.MinScale) - band - 0.1);
    });
  }

  it('takes a change of amounts mid-press', () => {
    const motion = press('Small', 100, 44, 1);
    const stretched = motion.ScaleX.Target;
    motion.Tune({ ...FLEX_AUTO, FlexStretch: 0, FlexLift: 0, FlexLiftAuto: 0 });
    motion.Step(0.016);
    expect(motion.ScaleX.Target).toBe(1);
    expect(stretched).not.toBe(1);
  });
});

describe('FlexHeld math (the lift and glow with no finger down)', () => {
  it('0 gives no lift and no glow', () => {
    const held = FlexHeld('Small', 100, 44, 1, { ...FLEX_AUTO, FlexHold: 0 });
    expect(held).toEqual({ Lift: 1, Glow: 0 });
  });

  it('1 gives the spec\'s own lift (1 + Lift / longer side) and big glow, same as a full press at rest', () => {
    const spec = FlexSpecFor('Small', 100, 44)!;
    const held = FlexHeld('Small', 100, 44, 1, { ...FLEX_AUTO, FlexHold: 1 });
    expect(held.Lift).toBeCloseTo((100 + spec.Lift) / 100, 9);
    expect(held.Glow).toBeCloseTo(spec.BigGlow, 9);
  });

  it('interpolates linearly between 0 and 1', () => {
    const full = FlexHeld('Small', 100, 44, 1, { ...FLEX_AUTO, FlexHold: 1 });
    const half = FlexHeld('Small', 100, 44, 1, { ...FLEX_AUTO, FlexHold: 0.5 });
    expect(half.Lift - 1).toBeCloseTo((full.Lift - 1) / 2, 9);
    expect(half.Glow).toBeCloseTo(full.Glow / 2, 9);
  });

  it('takes the authored FlexLift / FlexBigGlow under their Auto weight, same as a press', () => {
    const held = FlexHeld('Small', 100, 44, 1, {
      ...FLEX_AUTO, FlexHold: 1, FlexLift: 8, FlexLiftAuto: 0, FlexBigGlow: 0.2, FlexBigGlowAuto: 0,
    });
    expect(held.Lift).toBeCloseTo(1 + 8 / 100, 9);
    expect(held.Glow).toBeCloseTo(0.2, 9);
  });

  it('Flex: None gives no hold, whatever FlexHold says', () => {
    expect(FlexHeld('None', 100, 44, 1, { ...FLEX_AUTO, FlexHold: 1 })).toEqual({ Lift: 1, Glow: 0 });
  });
});

describe('Flex* spring like any numeric property', () => {
  const pressedJiv = (style: Partial<JivStyle>, springs?: Jiv['Springs']) => {
    const jiv = new Jiv({ Style: { Flex: 'Auto', ...style }, ...(springs ? { Springs: springs } : {}) });
    jiv.Width = 100;
    jiv.Height = 44;
    const anim = new JivStyleAnimator(jiv);
    anim.SnapToTargets();
    return { jiv, anim };
  };

  it('eases FlexStretch to 0 rather than snapping, and settles there', () => {
    const { jiv, anim } = pressedJiv({ FlexStretch: '1' });
    expect(jiv.RenderStyle.FlexStretch).toBe(1);
    jiv.Style.FlexStretch = '0';
    anim.Wake();
    anim.Tick(0.016);
    const mid = jiv.RenderStyle.FlexStretch;
    expect(mid).toBeGreaterThan(0.05);
    expect(mid).toBeLessThan(1);
    for (let i = 0; i < 120; i++) anim.Tick(0.016);
    expect(jiv.RenderStyle.FlexStretch).toBeCloseTo(0, 2);
  });

  it('honors @Transition / @Spring under the property name', () => {
    const { jiv, anim } = pressedJiv({ FlexStretch: '1' }, { FlexStretch: { Stiffness: Infinity } });
    jiv.Style.FlexStretch = '0';
    anim.Wake();
    anim.Tick(0.016);
    expect(jiv.RenderStyle.FlexStretch).toBe(0);
  });

  it('eases Auto into a number through its weight', () => {
    const { jiv, anim } = pressedJiv({});
    expect(jiv.RenderStyle.FlexLiftAuto).toBe(1);
    jiv.Style.FlexLift = '0';
    anim.Wake();
    anim.Tick(0.016);
    expect(jiv.RenderStyle.FlexLiftAuto).toBeGreaterThan(0);
    expect(jiv.RenderStyle.FlexLiftAuto).toBeLessThan(1);
  });

  it('reads the sprung amounts into a running press, and Flex: None lets it settle', () => {
    const { jiv, anim } = pressedJiv({ FlexStretch: '1' });
    const motion = new FlexMotion();
    motion.Begin(50, 22, 100, 44, 1, 'Auto', jiv.RenderStyle, 0);
    motion.Move(150, 22, 16);
    jiv.Flex = motion;
    anim.Tick(0.016);
    // A 100 x 44 control is UltraSmall: lift (100 + 16) / 100.
    const stretch = () => motion.ScaleY.Target - 1.16;
    const before = stretch();
    jiv.Style.FlexStretch = '0';
    anim.Wake();
    anim.Tick(0.016);
    const ratio = stretch() / before;
    expect(ratio).toBeGreaterThan(0);
    expect(ratio).toBeLessThan(0.99);
    jiv.Style.Flex = 'None';
    anim.Wake();
    anim.Tick(0.016);
    expect(motion.Active).toBe(false);
  });

  it('FlexHold 0 renders nothing at rest: no lift, no glow, no running press', () => {
    const { jiv } = pressedJiv({ FlexHold: '0' });
    expect(jiv.RenderStyle.VisualScaleX).toBe(1);
    expect(jiv.RenderStyle.VisualScaleY).toBe(1);
    expect(jiv.RenderStyle.GlassGlow).toBe(0);
    expect(jiv.Flex).toBeNull();
  });

  it('FlexHold 1 gives the spec\'s lift and big glow at rest, with no press ever begun', () => {
    const { jiv } = pressedJiv({ FlexHold: '1' });
    // A 100 x 44 control is UltraSmall: lift (100 + 16) / 100, big glow 1.
    expect(jiv.RenderStyle.VisualScaleX).toBeCloseTo(1.16, 5);
    expect(jiv.RenderStyle.VisualScaleY).toBeCloseTo(1.16, 5);
    expect(jiv.RenderStyle.GlassGlow).toBeCloseTo(1, 5);
    expect(jiv.Flex).toBeNull();
  });

  it('a transition eases FlexHold\'s lift in rather than snapping it', () => {
    const { jiv, anim } = pressedJiv({ FlexHold: '0' });
    expect(jiv.RenderStyle.VisualScaleX).toBe(1);
    jiv.Style.FlexHold = '1';
    anim.Wake();
    anim.Tick(0.016);
    const mid = jiv.RenderStyle.VisualScaleX;
    expect(mid).toBeGreaterThan(1);
    expect(mid).toBeLessThan(1.16);
    for (let i = 0; i < 120; i++) anim.Tick(0.016);
    expect(jiv.RenderStyle.VisualScaleX).toBeCloseTo(1.16, 3);
  });

  it('a running press on top of a full hold reads the same lift, not a doubled one', () => {
    const { jiv, anim } = pressedJiv({ Flex: 'Small', FlexHold: '1' });
    const heldOnly = jiv.RenderStyle.VisualScaleX;
    expect(heldOnly).toBeCloseTo(1.16, 5);

    // A fresh press begins at the exact same spec, no drag yet: its own lift target is 1.16 too, so
    // composing it with the already-held 1.16 must read as 1.16 -- never 1.16 * 1.16 or 1.16 + 0.16.
    const motion = new FlexMotion();
    motion.Begin(50, 22, 100, 44, 1, 'Small', jiv.RenderStyle, 0);
    jiv.Flex = motion;
    for (let i = 0; i < 40; i++) anim.Tick(0.016);
    expect(jiv.RenderStyle.VisualScaleX).toBeCloseTo(1.16, 2);
    expect(jiv.RenderStyle.VisualScaleX).not.toBeCloseTo(1.16 * 1.16, 2);

    // A dragged press stretches past the held lift: the larger (the press's own) wins outright.
    motion.Move(50 + 12 * 6 * 6, 22, 96);
    for (let i = 0; i < 6; i++) anim.Tick(0.016);
    const dragged = jiv.RenderStyle.VisualScaleX;
    expect(dragged).toBeGreaterThan(1.16 + 0.02);
  });
});
