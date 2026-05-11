import { describe, it, expect } from 'vitest';
import { JivAnimationDriver } from '../src/Animation/Animation.Driver';
import type { AnimationDefinition } from '../src/Animation/Animation.Types';

const makeDef = (overrides?: Partial<AnimationDefinition>): AnimationDefinition => ({
  Name: 'Test',
  Duration: 1000,
  Loop: 'Once',
  Ease: null,
  Stops: [
    { Phase: 0, Values: { Opacity: '0' } },
    { Phase: 1, Values: { Opacity: '1' } },
  ],
  ...overrides,
});

describe('JivAnimationDriver', () => {
  describe('phase advancement', () => {
    it('Once advances 0 to 1 over Duration and stops', () => {
      const d = new JivAnimationDriver();
      d.Apply([{ Kind: 'Inline', Property: 'Opacity', Definition: makeDef() }], {});
      // Quarter of duration
      expect(d.Tick(0.25)).toBe(true);
      expect(d.Patch().Opacity).toBe('0.25');
      // Half
      expect(d.Tick(0.25)).toBe(true);
      expect(d.Patch().Opacity).toBe('0.5');
      // Full
      expect(d.Tick(0.5)).toBe(true); // last active frame
      expect(d.Patch().Opacity).toBe('1');
      // After settling, Tick returns false (Once is done)
      expect(d.Tick(0.1)).toBe(false);
      expect(d.Patch().Opacity).toBe('1');
    });

    it('Repeat wraps phase from 1 back to 0 continuously', () => {
      const d = new JivAnimationDriver();
      d.Apply([{ Kind: 'Inline', Property: 'Opacity', Definition: makeDef({ Loop: 'Repeat' }) }], {});
      d.Tick(0.75);
      expect(parseFloat(d.Patch().Opacity)).toBeCloseTo(0.75, 2);
      d.Tick(0.5); // 0.75 + 0.5 = 1.25, wraps to 0.25
      expect(parseFloat(d.Patch().Opacity)).toBeCloseTo(0.25, 2);
      // Never stops
      expect(d.Tick(1.0)).toBe(true);
    });

    it('Mirror reverses direction at boundaries', () => {
      const d = new JivAnimationDriver();
      d.Apply([{ Kind: 'Inline', Property: 'Opacity', Definition: makeDef({ Loop: 'Mirror' }) }], {});
      d.Tick(0.75);
      expect(parseFloat(d.Patch().Opacity)).toBeCloseTo(0.75, 2);
      d.Tick(0.5); // 0.75 + 0.5 = 1.25, mirrors to 2 - 1.25 = 0.75, direction flips
      expect(parseFloat(d.Patch().Opacity)).toBeCloseTo(0.75, 2);
      d.Tick(0.5); // 0.75 - 0.5 = 0.25 (direction is now -1)
      expect(parseFloat(d.Patch().Opacity)).toBeCloseTo(0.25, 2);
      d.Tick(0.5); // 0.25 - 0.5 = -0.25, mirrors to 0.25, direction flips back
      expect(parseFloat(d.Patch().Opacity)).toBeCloseTo(0.25, 2);
    });
  });

  describe('value lerp', () => {
    it('lerps unitless numerics', () => {
      const d = new JivAnimationDriver();
      d.Apply([{
        Kind: 'Inline',
        Property: 'Opacity',
        Definition: makeDef({
          Stops: [
            { Phase: 0, Values: { Opacity: '0.2' } },
            { Phase: 1, Values: { Opacity: '0.8' } },
          ],
        }),
      }], {});
      d.Tick(0.5);
      expect(parseFloat(d.Patch().Opacity)).toBeCloseTo(0.5, 2);
    });

    it('lerps numerics with units, preserving the unit', () => {
      const d = new JivAnimationDriver();
      d.Apply([{
        Kind: 'Inline',
        Property: 'Width',
        Definition: makeDef({
          Stops: [
            { Phase: 0, Values: { Width: '10pt' } },
            { Phase: 1, Values: { Width: '30pt' } },
          ],
        }),
      }], {});
      d.Tick(0.5);
      expect(d.Patch().Width).toBe('20pt');
    });

    it('lerps rgb() colors per channel', () => {
      const d = new JivAnimationDriver();
      d.Apply([{
        Kind: 'Inline',
        Property: 'Background',
        Definition: makeDef({
          Stops: [
            { Phase: 0, Values: { Background: 'rgb(0, 0, 0)' } },
            { Phase: 1, Values: { Background: 'rgb(100, 200, 50)' } },
          ],
        }),
      }], {});
      d.Tick(0.5);
      // Round to handle floating-point
      expect(d.Patch().Background).toBe('rgb(50, 100, 25)');
    });

    it('snaps at midpoint for unrecognized formats', () => {
      const d = new JivAnimationDriver();
      d.Apply([{
        Kind: 'Inline',
        Property: 'Material',
        Definition: makeDef({
          Stops: [
            { Phase: 0, Values: { Material: 'None' } },
            { Phase: 1, Values: { Material: 'LiquidGlass' } },
          ],
        }),
      }], {});
      d.Tick(0.25);
      expect(d.Patch().Material).toBe('None');
      d.Tick(0.5); // phase now 0.75
      expect(d.Patch().Material).toBe('LiquidGlass');
    });
  });

  describe('Apply integrations', () => {
    it('resolves Named applications against the animation table', () => {
      const def = makeDef({ Name: 'Pulse', Loop: 'Mirror' });
      const d = new JivAnimationDriver();
      d.Apply([{ Kind: 'Named', Name: 'Pulse' }], { Pulse: def });
      expect(d.HasAnimations).toBe(true);
      d.Tick(0.5);
      expect(d.Patch().Opacity).toBe('0.5');
    });

    it('throws on Named applications that reference an unknown name', () => {
      const d = new JivAnimationDriver();
      expect(() => d.Apply([{ Kind: 'Named', Name: 'NotDefined' }], {}))
        .toThrow(/not defined/);
    });

    it('clears previous animations on re-Apply', () => {
      const d = new JivAnimationDriver();
      d.Apply([{ Kind: 'Inline', Property: 'Opacity', Definition: makeDef() }], {});
      expect(d.HasAnimations).toBe(true);
      d.Apply([], {});
      expect(d.HasAnimations).toBe(false);
    });

    it('layers multiple animations source-order last-wins on conflict', () => {
      const d = new JivAnimationDriver();
      const a = makeDef({
        Stops: [
          { Phase: 0, Values: { Opacity: '0' } },
          { Phase: 1, Values: { Opacity: '1' } },
        ],
      });
      const b = makeDef({
        Stops: [
          { Phase: 0, Values: { Opacity: '0.5' } },
          { Phase: 1, Values: { Opacity: '0.5' } },
        ],
      });
      d.Apply([
        { Kind: 'Inline', Property: 'Opacity', Definition: a },
        { Kind: 'Inline', Property: 'Opacity', Definition: b },
      ], {});
      d.Tick(0.5);
      // Second animation pins Opacity at 0.5 across the whole timeline,
      // and source-order last-wins makes it the visible target.
      expect(d.Patch().Opacity).toBe('0.5');
    });
  });
});
