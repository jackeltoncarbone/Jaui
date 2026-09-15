/**
 * The glass body Tint resolves from the active theme, and a theme flip re-resolves LIVE.
 *
 * The theme reaches the engine as ordinary JSS vars (`@Dark` / `@Light` twins, and the colour tokens a
 * page reads), pushed through `Canvas.SetJssVars` exactly as `<jaui>` pushes them. A settled style
 * animator sleeps, so these tests drive a real Canvas through real frames to prove the flip lands
 * without anything else waking the tree.
 */
import { describe, it, expect } from 'vitest';
import { Canvas } from '@jaui/Core/Jaui';
import type { Renderer } from '@jaui/Core/Renderer';
import { BrowserPlatform } from '@jaui/Core/Platform';
import { Jiv } from '@jaui/Jiv/Jiv';
import { ResolveStyle, SEED_CONTEXT } from '@jaui/Core/Style.Resolver';
import { DefaultJivStyle } from '@jaui/Jiv/Jiv.Defaults';
import type { JivStyle } from '@jaui/Jiv/Jiv.Types';
import { ResolveTextStyle } from '@jaui/Text/Text.Types';

const tintOf = (style: Partial<JivStyle>, vars: Record<string, string>): number =>
  ResolveStyle({ ...DefaultJivStyle, ...style } as JivStyle, { ...SEED_CONTEXT, Vars: new Map(Object.entries(vars)) }).Tint;

const DARK = { Dark: '1', Light: '0' };
const LIGHT = { Dark: '0', Light: '1' };

describe('Tint + TintTone resolve to a signed tint', () => {
  it('Ground (the default) is black in dark and white in light', () => {
    expect(tintOf({ Tint: '0.4' }, DARK)).toBeCloseTo(-0.4, 6);
    expect(tintOf({ Tint: '0.4' }, LIGHT)).toBeCloseTo(0.4, 6);
  });

  it('Ink is the opposite neutral', () => {
    expect(tintOf({ Tint: '0.2', TintTone: 'Ink' }, DARK)).toBeCloseTo(0.2, 6);
    expect(tintOf({ Tint: '0.2', TintTone: 'Ink' }, LIGHT)).toBeCloseTo(-0.2, 6);
  });

  it('Dark and Light ignore the theme', () => {
    expect(tintOf({ Tint: '0.3', TintTone: 'Dark' }, LIGHT)).toBeCloseTo(-0.3, 6);
    expect(tintOf({ Tint: '0.3', TintTone: 'Light' }, DARK)).toBeCloseTo(0.3, 6);
  });

  it('a per-theme strength is plain var arithmetic on the 0/1 twins', () => {
    const style = { Tint: '0.3 * @Dark + 0.5 * @Light' };
    expect(tintOf(style, DARK)).toBeCloseTo(-0.3, 6);
    expect(tintOf(style, LIGHT)).toBeCloseTo(0.5, 6);
  });

  it('no theme published reads as dark; zero and out-of-range strengths clamp', () => {
    expect(tintOf({ Tint: '0.4' }, {})).toBeCloseTo(-0.4, 6);
    expect(tintOf({ Tint: '0' }, LIGHT)).toBe(0);
    expect(tintOf({ Tint: '3' }, LIGHT)).toBe(1);
  });
});

describe('a material states its per-theme grade in one line', () => {
  const resolve = (vars: Record<string, string>) => ResolveStyle(
    { ...DefaultJivStyle, BackdropFilter: 'Blur(4pt) Saturate(1.6 * @Dark + 1.8 * @Light) Contrast(@ControlContrast)' } as JivStyle,
    { ...SEED_CONTEXT, IsSeed: false, Vars: new Map(Object.entries({ ...vars, ControlContrast: '0.6 * @Dark + 1 * @Light' })) },
  );

  it('grade arguments evaluate var arithmetic, chained vars included', () => {
    const dark = resolve(DARK);
    expect(dark.BackdropSaturation).toBeCloseTo(1.6, 6);
    expect(dark.BackdropContrast).toBeCloseTo(0.6, 6);
    const light = resolve(LIGHT);
    expect(light.BackdropSaturation).toBeCloseTo(1.8, 6);
    expect(light.BackdropContrast).toBeCloseTo(1, 6);
    expect(light.BackdropFrostBlur).toBeCloseTo(4 * 16, 6);
  });
});

/** Every renderer call is a no-op returning undefined: this test reads resolved styles, not pixels. */
const nullRenderer = (): Renderer =>
  new Proxy({}, { get: (_t, key) => (key === 'then' ? undefined : () => undefined) }) as unknown as Renderer;

describe('a theme flip re-resolves live through SetJssVars', () => {
  it('a colour var and the tint follow the flip on the next frames, with nothing else waking the tree', () => {
    const canvas = new Canvas(new OffscreenCanvas(400, 300) as unknown as HTMLCanvasElement, nullRenderer(), BrowserPlatform);
    canvas.SetSizePx(400, 300);
    canvas.SetJssVars({ ...DARK, Ground: 'rgb(0, 0, 0)', Ink: 'rgb(255, 255, 255)' });
    // Constructed with a literal: the constructor's seed resolve has no var table (a browser parses the
    // unresolved name as black and the first tick corrects it; this Node canvas shim throws instead).
    const glass = new Jiv({ Width: 200, Height: 100, Style: { Background: 'rgb(0, 0, 0)', Tint: '0.4', Thickness: '1' } });
    glass.Style.Background = '@Ground';
    canvas.Root.AddChild(glass);
    const label = new Jiv({ Text: 'Aa', TextStyle: { Color: '@Ink' } });
    glass.AddChild(label);
    const inkR = (): number => ResolveTextStyle(label.EffectiveTextStyle(), label.ResolveCtx!).Color.R;

    let t = 1000;
    const frames = (n: number): void => { for (let i = 0; i < n; i++) canvas.RenderHeadless((t += 16)); };

    // Long enough for every spring to settle and every animator to fall asleep.
    frames(200);
    expect(glass.RenderStyle.Background.Color.R).toBeCloseTo(0, 2);
    expect(glass.RenderStyle.Tint).toBeCloseTo(-0.4, 2);
    expect(inkR()).toBeCloseTo(1, 6);

    canvas.SetJssVars({ ...LIGHT, Ground: 'rgb(255, 255, 255)', Ink: 'rgb(0, 0, 0)' });
    // Moving within a few frames: a sleeping animator would sit at the dark values until its backstop.
    frames(4);
    expect(glass.RenderStyle.Background.Color.R).toBeGreaterThan(0.05);
    expect(glass.RenderStyle.Tint).toBeGreaterThan(-0.35);
    frames(60);
    expect(glass.RenderStyle.Background.Color.R).toBeCloseTo(1, 2);
    expect(glass.RenderStyle.Tint).toBeCloseTo(0.4, 2);

    expect(inkR()).toBeCloseTo(0, 6);
    frames(200);
    canvas.SetJssVars({ ...DARK, Ground: 'rgb(0, 0, 0)', Ink: 'rgb(255, 255, 255)' });
    frames(4);
    expect(glass.RenderStyle.Tint).toBeLessThan(0.35);
    frames(60);
    expect(glass.RenderStyle.Background.Color.R).toBeCloseTo(0, 2);
    expect(glass.RenderStyle.Tint).toBeCloseTo(-0.4, 2);
  });
});
