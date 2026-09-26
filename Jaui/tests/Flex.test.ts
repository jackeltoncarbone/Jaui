import { describe, it, expect, beforeEach } from 'vitest';
import { FLEX_AUTO, FlexMotion, FlexSpecFor, type FlexAmounts, type FlexKind } from '../src/Core/Flex';
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
});
