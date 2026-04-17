import { describe, expect, it, vi } from 'vitest';
import { ParseJss } from '../src/Jss/Jss.Parser';
import { Resolve, type ResolveContext } from '../src/Core/Length';

const seed: Omit<ResolveContext, 'Vars'> = {
  ParentWidth: 1000,
  ParentHeight: 1000,
  PointScale: 1,
  ParentPointScale: 1,
  RootPointScale: 1,
  ViewportWidth: 1000,
  ViewportHeight: 1000,
};

const ctxWith = (vars: Record<string, string>): ResolveContext => ({
  ...seed,
  Vars: new Map(Object.entries(vars)),
});

describe('JSS @var declarations', () => {
  it('parses a top-level @Name: value into the var table', () => {
    const { Vars, Sheet } = ParseJss(`
      @ScreenR: 90
      @ChromePad: 24

      Screen { BorderRadius: @ScreenR }
    `);
    expect(Vars).toEqual({ ScreenR: '90', ChromePad: '24' });
    expect(Sheet.Screen?.Style?.BorderRadius).toBe('@ScreenR');
  });

  it('rejects the legacy @var keyword with a clear error', () => {
    expect(() => ParseJss('@var X: 10')).toThrow(/"@var" is no longer a keyword/);
  });

  it('rejects unknown top-level @ directives', () => {
    expect(() => ParseJss('@Foo 10')).toThrow(/Unexpected "@Foo" at top level/);
  });

  it('rejects declaration of a reserved built-in identifier', () => {
    expect(() => ParseJss('@Presence: 1')).toThrow(/reserved built-in/);
    expect(() => ParseJss('@Entering: 1')).toThrow(/reserved built-in/);
    expect(() => ParseJss('@Exiting: 1')).toThrow(/reserved built-in/);
  });

  it('allows declarations interleaved with rulesets', () => {
    const { Vars, Sheet } = ParseJss(`
      @A: 10
      Screen { BorderRadius: @A }
      @B: 20
      Panel { Padding: @B }
    `);
    expect(Vars).toEqual({ A: '10', B: '20' });
    expect(Sheet.Screen?.Style?.BorderRadius).toBe('@A');
    expect(Sheet.Panel?.Layout?.Padding).toBe('@B');
  });
});

describe('Length resolver: @Name references', () => {
  it('resolves a simple @Name to its value', () => {
    const ctx = ctxWith({ X: '40' });
    expect(Resolve('@X', ctx, 'W')).toBe(40);
  });

  it('resolves arithmetic with @Name references', () => {
    const ctx = ctxWith({ Screen: '90', Pad: '24' });
    expect(Resolve('@Screen - @Pad', ctx, 'W')).toBe(66);
    expect(Resolve('@Screen - @Pad - 4', ctx, 'W')).toBe(62);
    expect(Resolve('(@Screen - @Pad) / 2', ctx, 'W')).toBe(33);
  });

  it('resolves chained vars (var referencing another var)', () => {
    const ctx = ctxWith({ A: '10', B: '@A * 2', C: '@B + 5' });
    expect(Resolve('@C', ctx, 'W')).toBe(25);
  });

  it('resolves units inside var values', () => {
    const ctx: ResolveContext = { ...seed, PointScale: 1.25, Vars: new Map([['X', '40pt']]) };
    expect(Resolve('@X', ctx, 'W')).toBe(50);
  });

  it('warns once and falls back to 0 on undefined var', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ctx = ctxWith({});
    // Use a fresh name each test run so the dedup cache doesn't swallow warns
    expect(Resolve('@UndeclaredJssVarTestOne', ctx, 'W')).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Undefined var "@UndeclaredJssVarTestOne"'),
    );
    warn.mockRestore();
  });

  it('warns on a circular reference and falls back to 0', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ctx = ctxWith({ CycleA: '@CycleB', CycleB: '@CycleA' });
    expect(Resolve('@CycleA', ctx, 'W')).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Circular var reference'),
    );
    warn.mockRestore();
  });

  it('rejects unknown bare identifiers in expressions', () => {
    const ctx = ctxWith({ X: '10' });
    expect(() => Resolve('X', ctx, 'W')).toThrow(/Unknown identifier "X"/);
  });

  it('resolves Presence / Entering / Exiting from the context', () => {
    const ctx: ResolveContext = { ...seed, Vars: new Map(), Presence: 0.5, Entering: 1, Exiting: 0 };
    expect(Resolve('Presence', ctx, 'W')).toBe(0.5);
    expect(Resolve('Entering', ctx, 'W')).toBe(1);
    expect(Resolve('Exiting', ctx, 'W')).toBe(0);
    expect(Resolve('0.96 + 0.04 * Presence', ctx, 'W')).toBeCloseTo(0.98);
    expect(Resolve('Entering * -20 * (1 - Presence)', ctx, 'W')).toBe(-10);
  });

  it('falls back to 0 for Presence builtins when ctx omits them', () => {
    // Layout-pass / seed contexts don't carry per-frame Presence values.
    // They fall through to 0 so layout is deterministic and sizing
    // expressions don't pick up transient animator state.
    const ctx = ctxWith({});
    expect(Resolve('Presence', ctx, 'W')).toBe(0);
    expect(Resolve('Entering', ctx, 'W')).toBe(0);
    expect(Resolve('Exiting', ctx, 'W')).toBe(0);
    expect(Resolve('0.96 + 0.04 * Presence', ctx, 'W')).toBe(0.96);
  });
});
