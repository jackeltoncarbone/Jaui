import { describe, it, expect } from 'vitest';
import { ParseJss } from '@jaui/Jss/Jss.Parser';

describe('JSS @Animation parser', () => {
  describe('root-level named definitions', () => {
    it('parses a basic @Animation with From/To class-refs and resolves them', () => {
      const { Animations: anims } = ParseJss(`
        PulseDim {
          Opacity: 0
          Background: rgb(0, 0, 0)
        }
        PulseBright {
          Opacity: 1
          Background: rgb(34, 34, 34)
        }
        @Animation Pulse {
          Duration: 1800ms
          Loop: Mirror
          From: PulseDim
          To: PulseBright
        }
      `);
      expect(anims.Pulse).toBeDefined();
      expect(anims.Pulse.Name).toBe('Pulse');
      expect(anims.Pulse.Duration).toBe(1800);
      expect(anims.Pulse.Loop).toBe('Mirror');
      expect(anims.Pulse.Stops).toHaveLength(2);
      expect(anims.Pulse.Stops[0].Phase).toBe(0);
      expect(anims.Pulse.Stops[1].Phase).toBe(1);
      // class-ref baked from the referenced ruleset
      expect(anims.Pulse.Stops[0].Values).toEqual({
        Opacity: '0',
        Background: 'rgb(0, 0, 0)',
      });
      expect(anims.Pulse.Stops[1].Values).toEqual({
        Opacity: '1',
        Background: 'rgb(34, 34, 34)',
      });
    });

    it('parses percent stops with class-ref shorthand', () => {
      const { Animations: anims } = ParseJss(`
        StopA { Opacity: 0 }
        StopB { Opacity: 0.5 }
        StopC { Opacity: 1 }
        @Animation Wave {
          Duration: 2000ms
          Loop: Repeat
          0%: StopA
          50%: StopB
          100%: StopC
        }
      `);
      expect(anims.Wave.Stops).toHaveLength(3);
      expect(anims.Wave.Stops.map(s => s.Phase)).toEqual([0, 0.5, 1]);
      expect(anims.Wave.Stops[1].Values).toEqual({ Opacity: '0.5' });
    });

    it('parses inline property blocks at stops', () => {
      const { Animations: anims } = ParseJss(`
        @Animation Inline {
          Duration: 1000ms
          Loop: Once
          0% { Opacity: 0; Background: rgb(0, 0, 0) }
          100% { Opacity: 1; Background: rgb(255, 255, 255) }
        }
      `);
      expect(anims.Inline.Stops).toHaveLength(2);
      expect(anims.Inline.Stops[0].Values).toEqual({
        Opacity: '0',
        Background: 'rgb(0, 0, 0)',
      });
    });

    it('defaults Loop to Once when omitted', () => {
      const { Animations: anims } = ParseJss(`
        A { Opacity: 0 }
        B { Opacity: 1 }
        @Animation FadeIn {
          Duration: 600ms
          From: A
          To: B
        }
      `);
      expect(anims.FadeIn.Loop).toBe('Once');
    });

    it('rejects undefined class-ref stops with a clear message', () => {
      expect(() => ParseJss(`
        @Animation Bad {
          Duration: 1000ms
          From: NotARealClass
          To: AlsoNot
        }
      `)).toThrow(/references unknown class "NotARealClass"/);
    });

    it('rejects animations with fewer than two stops', () => {
      expect(() => ParseJss(`
        A { Opacity: 0 }
        @Animation Bad {
          Duration: 1000ms
          From: A
        }
      `)).toThrow(/at least two stops/);
    });

    it('rejects non-positive Duration', () => {
      expect(() => ParseJss(`
        A { Opacity: 0 }
        B { Opacity: 1 }
        @Animation Bad {
          Duration: 0ms
          From: A
          To: B
        }
      `)).toThrow(/Duration must be > 0/);
    });

    it('rejects duplicate @Animation names', () => {
      expect(() => ParseJss(`
        A { Opacity: 0 }
        B { Opacity: 1 }
        @Animation Dup { Duration: 100ms; From: A; To: B }
        @Animation Dup { Duration: 200ms; From: A; To: B }
      `)).toThrow(/declared more than once/);
    });

    it('parses Ease: Linear', () => {
      const { Animations: anims } = ParseJss(`
        A { Opacity: 0 }
        B { Opacity: 1 }
        @Animation L {
          Duration: 1000ms
          Ease: Linear
          From: A
          To: B
        }
      `);
      expect(anims.L.Ease).toBe('Linear');
    });

    it('parses Ease: Spring(...) with custom tuning', () => {
      const { Animations: anims } = ParseJss(`
        A { Opacity: 0 }
        B { Opacity: 1 }
        @Animation S {
          Duration: 1000ms
          Ease: Spring(Stiffness: 60, Damping: 22, Mass: 1)
          From: A
          To: B
        }
      `);
      expect(anims.S.Ease).toEqual({ Stiffness: 60, Damping: 22, Mass: 1 });
    });
  });

  describe('in-class application and inline forms', () => {
    it('records `@Animation Pulse` as a Named application on the class', () => {
      const { Sheet: sheet } = ParseJss(`
        A { Opacity: 0 }
        B { Opacity: 1 }
        @Animation Pulse {
          Duration: 1000ms
          From: A
          To: B
        }
        LoaderOverlay {
          @Animation Pulse
        }
      `);
      expect(sheet.LoaderOverlay.Animations).toHaveLength(1);
      expect(sheet.LoaderOverlay.Animations![0]).toEqual({
        Kind: 'Named',
        Name: 'Pulse',
      });
    });

    it('records inline anonymous animations with raw From/To values', () => {
      const { Sheet: sheet } = ParseJss(`
        LoaderOverlay {
          @Animation Opacity {
            From: 0
            To: 1
            Duration: 1800ms
            Loop: Mirror
          }
        }
      `);
      expect(sheet.LoaderOverlay.Animations).toHaveLength(1);
      const app = sheet.LoaderOverlay.Animations![0];
      expect(app.Kind).toBe('Inline');
      if (app.Kind !== 'Inline') throw new Error('unreachable');
      expect(app.Property).toBe('Opacity');
      expect(app.Definition.Loop).toBe('Mirror');
      expect(app.Definition.Stops[0].Values).toEqual({ Opacity: '0' });
      expect(app.Definition.Stops[1].Values).toEqual({ Opacity: '1' });
    });

    it('supports multiple animations on one class in source order', () => {
      const { Sheet: sheet } = ParseJss(`
        A { Opacity: 0 }
        B { Opacity: 1 }
        @Animation One { Duration: 1000ms; From: A; To: B }
        @Animation Two { Duration: 1000ms; From: A; To: B }
        Multi {
          @Animation One
          @Animation Two
        }
      `);
      expect(sheet.Multi.Animations).toHaveLength(2);
      expect(sheet.Multi.Animations![0]).toMatchObject({ Kind: 'Named', Name: 'One' });
      expect(sheet.Multi.Animations![1]).toMatchObject({ Kind: 'Named', Name: 'Two' });
    });

    it('inherits Animations through `extends` (base first, own after)', () => {
      const { Sheet: sheet } = ParseJss(`
        A { Opacity: 0 }
        B { Opacity: 1 }
        @Animation Pulse { Duration: 1000ms; From: A; To: B }
        @Animation Fade  { Duration: 500ms;  From: A; To: B }
        Base { @Animation Pulse }
        Sub : Base { @Animation Fade }
      `);
      expect(sheet.Sub.Animations).toHaveLength(2);
      expect(sheet.Sub.Animations![0]).toMatchObject({ Name: 'Pulse' });
      expect(sheet.Sub.Animations![1]).toMatchObject({ Name: 'Fade' });
    });

    it('comma-separates multiple named applications on one line', () => {
      const { Sheet: sheet } = ParseJss(`
        A { Opacity: 0 }
        B { Opacity: 1 }
        @Animation Pulse  { Duration: 1000ms; From: A; To: B }
        @Animation FadeIn { Duration: 500ms;  From: A; To: B }
        Multi {
          @Animation Pulse, FadeIn
        }
      `);
      expect(sheet.Multi.Animations).toHaveLength(2);
      expect(sheet.Multi.Animations![0]).toMatchObject({ Kind: 'Named', Name: 'Pulse' });
      expect(sheet.Multi.Animations![1]).toMatchObject({ Kind: 'Named', Name: 'FadeIn' });
    });

    it('rejects comma-separated multi-apply where one entry has an inline block', () => {
      expect(() => ParseJss(`
        A { Opacity: 0 }
        B { Opacity: 1 }
        @Animation Pulse { Duration: 1000ms; From: A; To: B }
        Bad {
          @Animation Pulse, Opacity { From: 0; To: 1; Duration: 100ms }
        }
      `)).toThrow(/comma-separated multi-apply only supports named animations/);
    });

    it('accepts `s` (seconds) Duration suffix', () => {
      const { Animations: anims } = ParseJss(`
        A { Opacity: 0 } B { Opacity: 1 }
        @Animation Slow { Duration: 1.8s; From: A; To: B }
      `);
      expect(anims.Slow.Duration).toBe(1800);
    });
  });
});

describe('JSS @Spring / @Transition parser', () => {
  it('parses comma-separated keys on one line in @Transition', () => {
    const { Sheet: sheet } = ParseJss(`
      Drawer {
        @Transition Opacity { Duration: 180ms, Easing: EaseOut }
      }
    `);
    expect(sheet.Drawer.Springs).toBeDefined();
    expect(sheet.Drawer.Springs!.Opacity).toBeDefined();
    // Critical-damped spring derived from 180ms duration. Author's `Easing: EaseOut`
    // doesn't change the math (only EaseInOut lowers damping ratio); the test
    // verifies the parse landed, not the exact coefficients.
    expect(sheet.Drawer.Springs!.Opacity.Stiffness).toBeGreaterThan(0);
    expect(sheet.Drawer.Springs!.Opacity.Damping).toBeGreaterThan(0);
  });

  it('parses @Spring * universal selector', () => {
    const { Sheet: sheet } = ParseJss(`
      Card {
        @Spring * { Stiffness: 200, Damping: 28 }
      }
    `);
    expect(sheet.Card.Springs!['*']).toEqual({ Stiffness: 200, Damping: 28 });
  });

  it('rejects @Transition * (universal only valid for @Spring)', () => {
    expect(() => ParseJss(`
      Card {
        @Transition * { Duration: 200ms }
      }
    `)).toThrow(/@Transition cannot target "\*"/);
  });

  it('lets @Spring win over @Transition on the same property regardless of source order', () => {
    // @Transition first, @Spring second — @Spring should win.
    const { Sheet: sheet1 } = ParseJss(`
      A {
        @Transition Opacity { Duration: 200ms }
        @Spring Opacity { Stiffness: 99, Damping: 11, Mass: 1 }
      }
    `);
    expect(sheet1.A.Springs!.Opacity).toMatchObject({ Stiffness: 99, Damping: 11, Mass: 1 });

    // @Spring first, @Transition second — @Spring still wins (later @Transition no-op).
    const { Sheet: sheet2 } = ParseJss(`
      B {
        @Spring Opacity { Stiffness: 99, Damping: 11, Mass: 1 }
        @Transition Opacity { Duration: 200ms }
      }
    `);
    expect(sheet2.B.Springs!.Opacity).toMatchObject({ Stiffness: 99, Damping: 11, Mass: 1 });
  });

  it('lets @Transition replace @Transition (both Transition kind, last-wins)', () => {
    const { Sheet: sheet } = ParseJss(`
      A {
        @Transition Opacity { Duration: 100ms }
        @Transition Opacity { Duration: 400ms }
      }
    `);
    // The latter (400ms → softer spring) should win. Compare relative stiffness.
    const stiffness = sheet.A.Springs!.Opacity.Stiffness!;
    // 5/(0.4) ≈ 12.5 → stiffness ≈ 156. 5/(0.1) ≈ 50 → stiffness ≈ 2500. Pick the soft one.
    expect(stiffness).toBeLessThan(500);
  });
});
