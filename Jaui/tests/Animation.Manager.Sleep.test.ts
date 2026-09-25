import { describe, it, expect, afterEach } from 'vitest';
import { AnimationManager, type Animatable } from '../src/Animation/Animation.Manager';
import { PerfLevers } from '../src/Core/Perf.Levers';
import { Jiv } from '../src/Jiv/Jiv';
import { JivAnimator } from '../src/Jiv/Jiv.Animator';
import { JivStyleAnimator } from '../src/Jiv/Jiv.StyleAnimator';

/** Moves for `frames` ticks, then rests; records every Tick. */
class Mover implements Animatable {
  Rouse: (() => void) | null = null;
  Ticks: number[] = [];
  constructor(public Name: string, public Frames: number, private _log: string[]) {}
  Tick = (): boolean => {
    this._log.push(this.Name);
    this.Ticks.push(this.Ticks.length);
    if (this.Frames <= 0) return false;
    this.Frames--;
    return true;
  };
  Move = (frames: number): void => { this.Frames = frames; this.Rouse?.(); };
}

afterEach(() => { PerfLevers.SleepingAnimators = true; });

describe('AnimationManager: an animatable at rest is not stepped', () => {
  it('steps a sleeper until it rests, then never again until roused', () => {
    const log: string[] = [];
    const m = new AnimationManager();
    const a = new Mover('a', 2, log);
    m.Register(a);
    for (let i = 0; i < 10; i++) m.StepFrame(1 / 60);
    expect(a.Ticks.length).toBe(3);
    a.Move(1);
    for (let i = 0; i < 10; i++) m.StepFrame(1 / 60);
    expect(a.Ticks.length).toBe(5);
  });

  it('keeps registration order among the roused', () => {
    const log: string[] = [];
    const m = new AnimationManager();
    const movers = ['a', 'b', 'c', 'd'].map((n) => new Mover(n, 0, log));
    for (const x of movers) m.Register(x);
    m.StepFrame(1 / 60);
    log.length = 0;
    movers[3].Move(1); movers[0].Move(1); movers[2].Move(1);
    m.StepFrame(1 / 60);
    expect(log).toEqual(['a', 'c', 'd']);
  });

  it('a mover roused mid-frame ahead of the cursor steps this frame, behind it next frame', () => {
    const log: string[] = [];
    const m = new AnimationManager();
    const a = new Mover('a', 0, log);
    const b = new Mover('b', 0, log);
    const c = new Mover('c', 0, log);
    let fire = false;
    const trigger: Animatable = { Tick: () => { log.push('t'); if (fire) { fire = false; a.Move(1); c.Move(1); } return false; } };
    m.Register(a); m.Register(trigger); m.Register(b); m.Register(c);
    m.StepFrame(1 / 60);
    log.length = 0;
    fire = true;
    m.StepFrame(1 / 60);
    // The trigger never sleeps (no Rouse slot). `a` is behind it, `c` ahead of it.
    expect(log).toEqual(['t', 'c']);
    log.length = 0;
    m.StepFrame(1 / 60);
    // `c` moved on the frame it was roused and rests on this one; `a` takes its first step now.
    expect(log).toEqual(['a', 't', 'c']);
  });

  it('never sleeps an animatable without a Rouse slot', () => {
    const m = new AnimationManager();
    let n = 0;
    m.Register({ Tick: () => { n++; return false; } });
    for (let i = 0; i < 5; i++) m.StepFrame(1 / 60);
    expect(n).toBe(5);
  });

  it('runs a sleeper\'s backstop on the frame the guard would have', () => {
    const log: string[] = [];
    const m = new AnimationManager();
    const a = new Mover('a', 0, log);
    let backstops = 0;
    Object.assign(a, { BackstopIn: () => 5, Backstop: () => { backstops++; } });
    m.Register(a);
    m.StepFrame(1 / 60);
    for (let i = 0; i < 4; i++) m.StepFrame(1 / 60);
    expect(a.Ticks.length).toBe(1);
    m.StepFrame(1 / 60);
    expect(backstops).toBe(1);
    expect(a.Ticks.length).toBe(2);
  });

  it('with the lever off steps everything every frame, and relists when it comes back on', () => {
    const log: string[] = [];
    const m = new AnimationManager();
    const a = new Mover('a', 0, log);
    m.Register(a);
    m.StepFrame(1 / 60);
    PerfLevers.SleepingAnimators = false;
    for (let i = 0; i < 3; i++) m.StepFrame(1 / 60);
    expect(a.Ticks.length).toBe(4);
    PerfLevers.SleepingAnimators = true;
    m.StepFrame(1 / 60);
    m.StepFrame(1 / 60);
    expect(a.Ticks.length).toBe(5);
  });

  it('drops an unregistered sleeper for good', () => {
    const log: string[] = [];
    const m = new AnimationManager();
    const a = new Mover('a', 3, log);
    m.Register(a);
    m.StepFrame(1 / 60);
    m.Unregister(a);
    a.Move(3);
    for (let i = 0; i < 3; i++) m.StepFrame(1 / 60);
    expect(a.Ticks.length).toBe(1);
    expect(a.Rouse).toBe(null);
  });
});

describe('the engine\'s animators as sleepers', () => {
  it('a JivAnimator at rest sleeps and SetTargets wakes it', () => {
    const m = new AnimationManager();
    const node = new Jiv();
    const anim = new JivAnimator(node, null);
    m.Register(anim);
    m.StepFrame(1 / 60);
    anim.SetTargets({ X: 40 });
    for (let i = 0; i < 120; i++) m.StepFrame(1 / 60);
    expect(node.X).toBe(40);
    expect(m.IsRunning).toBe(false);
  });

  it('a JivStyleAnimator sleeps at rest and Wake brings its resolve back', () => {
    const m = new AnimationManager();
    const node = new Jiv();
    node.PresenceSpring.Value = 1;
    node.PresenceSpring.Target = 1;
    const anim = new JivStyleAnimator(node);
    m.Register(anim);
    m.StepFrame(1 / 60);
    expect(anim.CanSleep()).toBe(true);
    node.Style = { ...node.Style, Opacity: 0.5 } as typeof node.Style;
    anim.Wake();
    for (let i = 0; i < 120; i++) m.StepFrame(1 / 60);
    expect(node.RenderStyle.Opacity).toBeCloseTo(0.5, 5);
    node.RequestLeave();
    expect(anim.CanSleep()).toBe(false);
  });
});
