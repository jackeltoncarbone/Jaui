import { describe, it, expect, beforeEach } from 'vitest';
import { Jiv } from '../src/Jiv/Jiv';
import { JivStyleAnimator } from '../src/Jiv/Jiv.StyleAnimator';
import type {
  AnimationApplication,
  AnimationDefinition,
} from '../src/Animation/Animation.Types';

beforeEach(() => {
  // ResolveStyle paths may want a document for font loading; provide a stub.
  (global as unknown as { document: object }).document = {
    createElement: () => ({ getContext: () => null }),
  };
});

const _mkInlineOpacity = (
  from: string,
  to: string,
  durationMs: number,
  loop: 'Once' | 'Repeat' | 'Mirror',
  ease: AnimationDefinition['Ease'] = null,
): AnimationApplication => ({
  Kind: 'Inline',
  Property: 'Opacity',
  Definition: {
    Name: '',
    Duration: durationMs,
    Loop: loop,
    Ease: ease,
    Stops: [
      { Phase: 0, Values: { Opacity: from } },
      { Phase: 1, Values: { Opacity: to } },
    ],
  },
});

describe('JivStyleAnimator + JivAnimationDriver integration', () => {
  it('drives Opacity from 0 toward 1 over the timeline (Mirror)', () => {
    const jiv = new Jiv({
      Style: { Opacity: 0 },
      Animations: [_mkInlineOpacity('0', '1', 1000, 'Mirror', 'Linear')],
    });
    const anim = new JivStyleAnimator(jiv);
    anim.SnapToTargets();

    // Step 500ms — phase ≈ 0.5 → Opacity ≈ 0.5 (Linear Ease = exact snap, no spring overshoot).
    anim.Tick(0.5);
    expect(jiv.RenderStyle.Opacity).toBeCloseTo(0.5, 1);

    // Step another 500ms — phase reaches 1.0; Mirror flips direction. Opacity at 1.0.
    anim.Tick(0.5);
    expect(jiv.RenderStyle.Opacity).toBeCloseTo(1.0, 1);

    // Step another 500ms — backward to phase 0.5 → Opacity ≈ 0.5.
    anim.Tick(0.5);
    expect(jiv.RenderStyle.Opacity).toBeCloseTo(0.5, 1);
  });

  it('Ease: Linear snaps the per-channel spring (no smoothing)', () => {
    // Linear means each tick the spring's Value is forced to Target.
    // Starting Opacity at 0 and asking for a one-shot snap to 1 at phase=1
    // should land exactly on 1 with no spring overshoot or settle delay.
    const jiv = new Jiv({
      Style: { Opacity: 0 },
      Animations: [_mkInlineOpacity('0', '1', 100, 'Once', 'Linear')],
    });
    const anim = new JivStyleAnimator(jiv);
    anim.SnapToTargets();
    // 100ms = one full Duration → Once goes Done at phase 1 = Opacity 1.
    anim.Tick(0.1);
    expect(jiv.RenderStyle.Opacity).toBeCloseTo(1.0, 2);
  });

  it('Ease: Spring(...) override retunes the channel for the animation lifetime', () => {
    // Stiffness=10, Damping=2 is far softer than the default 260/32, so the
    // value should lag noticeably behind a step-target compared to default.
    // The test asserts the override took effect by stepping a small dt and
    // verifying we're nowhere near the target yet.
    const soft = _mkInlineOpacity('0', '1', 1000, 'Mirror', { Stiffness: 10, Damping: 2, Mass: 1 });
    const jiv = new Jiv({
      Style: { Opacity: 0 },
      Animations: [soft],
    });
    const anim = new JivStyleAnimator(jiv);
    anim.SnapToTargets();
    // At phase ~0.5 the animation's bare target is 0.5. With a very soft
    // spring, Opacity will be behind the target — well below 0.5.
    anim.Tick(0.5);
    expect(jiv.RenderStyle.Opacity).toBeLessThan(0.5);
    // Spec sanity: the per-channel spring config was actually mutated.
    // Access private via cast — testing internal state is intentional here.
    const springs = (anim as unknown as { _springs: { Stiffness: number; Damping: number }[] })._springs;
    const opacityBinding = springs.find(s => s.Stiffness === 10 && s.Damping === 2);
    expect(opacityBinding).toBeDefined();
  });

  it('ReapplyAnimations swaps the active animation set without recreating the animator', () => {
    const jiv = new Jiv({
      Style: { Opacity: 0 },
      Animations: [_mkInlineOpacity('0', '1', 1000, 'Mirror', 'Linear')],
    });
    const anim = new JivStyleAnimator(jiv);
    anim.SnapToTargets();
    expect(anim.HasAnimations).toBe(true);

    // Class swap: remove all animations. HasAnimations flips off, render
    // chases the now-bare Style.Opacity which is 0.
    anim.ReapplyAnimations(null, null);
    expect(anim.HasAnimations).toBe(false);
    // Step once — spring should settle at 0 (the bare style's Opacity).
    for (let i = 0; i < 20; i++) anim.Tick(1 / 60);
    expect(jiv.RenderStyle.Opacity).toBeCloseTo(0, 2);

    // Class swap back: a new animation kicks in starting phase 0.
    anim.ReapplyAnimations(
      [_mkInlineOpacity('0', '1', 1000, 'Once', 'Linear')],
      null,
    );
    expect(anim.HasAnimations).toBe(true);
    anim.Tick(1.0); // full duration → phase=1 → Opacity=1
    expect(jiv.RenderStyle.Opacity).toBeCloseTo(1.0, 2);
  });

  it('RetuneSprings updates baseConfigs so later animation-Ease overrides can restore correctly', () => {
    const jiv = new Jiv({
      Style: { Opacity: 0 },
      Springs: { Opacity: { Stiffness: 50, Damping: 14, Mass: 1 } },
    });
    const anim = new JivStyleAnimator(jiv);
    anim.SnapToTargets();
    const baseConfigs = (anim as unknown as { _baseConfigs: { Stiffness: number }[] })._baseConfigs;
    expect(baseConfigs.some(c => c.Stiffness === 50)).toBe(true);

    // Retune with a different config; baseConfigs should reflect it.
    anim.RetuneSprings({ Opacity: { Stiffness: 99, Damping: 22, Mass: 1 } });
    const baseConfigs2 = (anim as unknown as { _baseConfigs: { Stiffness: number }[] })._baseConfigs;
    expect(baseConfigs2.some(c => c.Stiffness === 99)).toBe(true);
    expect(baseConfigs2.some(c => c.Stiffness === 50)).toBe(false);
  });

  it('@Spring * universal fallback applies to every binding without per-prop entry', () => {
    const jiv = new Jiv({
      Style: { Opacity: 0 },
      Springs: { '*': { Stiffness: 77, Damping: 19, Mass: 1 } },
    });
    const anim = new JivStyleAnimator(jiv);
    anim.SnapToTargets();
    const baseConfigs = (anim as unknown as { _baseConfigs: { Stiffness: number }[] })._baseConfigs;
    // Every binding should have inherited 77/19/1 from the universal selector.
    expect(baseConfigs.every(c => c.Stiffness === 77)).toBe(true);
  });

  it('per-property @Spring overrides @Spring * universal default', () => {
    const jiv = new Jiv({
      Style: { Opacity: 0 },
      Springs: {
        '*': { Stiffness: 77, Damping: 19, Mass: 1 },
        Opacity: { Stiffness: 99, Damping: 11, Mass: 1 },
      },
    });
    const anim = new JivStyleAnimator(jiv);
    anim.SnapToTargets();
    const baseConfigs = (anim as unknown as { _baseConfigs: { Stiffness: number }[] })._baseConfigs;
    // Opacity binding (only one in BINDINGS with that name) carries 99/11.
    expect(baseConfigs.some(c => c.Stiffness === 99)).toBe(true);
    // Everything else carries the universal 77.
    const others = baseConfigs.filter(c => c.Stiffness !== 99);
    expect(others.every(c => c.Stiffness === 77)).toBe(true);
  });

  it('exposes itself on Jiv.StyleAnimator for worker registry re-apply', () => {
    const jiv = new Jiv({ Style: { Opacity: 0 } });
    expect(jiv.StyleAnimator).toBeNull();
    const anim = new JivStyleAnimator(jiv);
    expect(jiv.StyleAnimator).toBe(anim);
  });
});
