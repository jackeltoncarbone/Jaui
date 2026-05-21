import { describe, it, expect } from 'vitest';
import { ParseJss } from '../src/Jss/Jss.Parser';

describe('JSS — parser', () => {
  it('parses a simple single-class ruleset', () => {
    const { Sheet: sheet } = ParseJss(`
      Toolbar {
        Material: LiquidGlass
        BorderRadius: 1.5pt
        Padding: 0.5pt
      }
    `);
    expect(sheet.Toolbar).toBeDefined();
    expect(sheet.Toolbar.Style?.Material).toBe('LiquidGlass');
    expect(sheet.Toolbar.Style?.BorderRadius).toBe('1.5pt');
    expect(sheet.Toolbar.Layout?.Padding).toBe('0.5pt');
  });

  it('routes each property to the correct slot', () => {
    const { Sheet: sheet } = ParseJss(`
      Button {
        Material: None
        BorderRadius: 8
        Padding: 4 8
        Width: 100
        Height: 40
        FontSize: 14
        Color: rgba(255, 255, 255, 1)
      }
    `);
    const r = sheet.Button;
    expect(r.Style?.Material).toBe('None');
    expect(r.Style?.BorderRadius).toBe('8');
    expect(r.Layout?.Padding).toBe('4 8');
    expect(r.ChildLayout?.Width).toBe('100');
    expect(r.ChildLayout?.Height).toBe('40');
    expect(r.TextStyle?.FontSize).toBe('14');
    expect(r.TextStyle?.Color).toBe('rgba(255, 255, 255, 1)');
  });

  it('accepts commas inside values (rgba, transforms)', () => {
    const { Sheet: sheet } = ParseJss(`
      Panel {
        Background: rgba(0, 0, 0, 0.5)
        Transform: translate(10, 20) scale(1.5)
      }
    `);
    expect(sheet.Panel.Style?.Background).toBe('rgba(0, 0, 0, 0.5)');
    expect(sheet.Panel.Style?.Transform).toBe('translate(10, 20) scale(1.5)');
  });

  it('accepts arithmetic in length values', () => {
    const { Sheet: sheet } = ParseJss(`
      Card {
        Padding: (1pt + 4)
        Width: 100vh - 32
      }
    `);
    expect(sheet.Card.Layout?.Padding).toBe('(1pt + 4)');
    expect(sheet.Card.ChildLayout?.Width).toBe('100vh - 32');
  });

  it('handles block and line comments', () => {
    const { Sheet: sheet } = ParseJss(`
      /* header styles */
      Toolbar {
        // main color
        Background: rgba(0, 0, 0, 0.5)
        Material: LiquidGlass   // glass effect
      }
    `);
    expect(sheet.Toolbar.Style?.Background).toBe('rgba(0, 0, 0, 0.5)');
    expect(sheet.Toolbar.Style?.Material).toBe('LiquidGlass');
  });

  it('accepts semicolon terminators as alternatives to newlines', () => {
    const { Sheet: sheet } = ParseJss(`Foo { Material: None; BorderRadius: 4; Width: 50; }`);
    expect(sheet.Foo.Style?.Material).toBe('None');
    expect(sheet.Foo.Style?.BorderRadius).toBe('4');
    expect(sheet.Foo.ChildLayout?.Width).toBe('50');
  });

  it('parses multiple rulesets', () => {
    const { Sheet: sheet } = ParseJss(`
      Toolbar {
        Material: LiquidGlass
      }
      BackButton {
        Width: 44
        Height: 44
      }
      Title {
        FontSize: 17
        FontWeight: 600
      }
    `);
    expect(Object.keys(sheet).sort()).toEqual(['BackButton', 'Title', 'Toolbar']);
    expect(sheet.BackButton.ChildLayout?.Width).toBe('44');
    expect(sheet.Title.TextStyle?.FontWeight).toBe('600');
  });

  it('merges duplicate class definitions', () => {
    const { Sheet: sheet } = ParseJss(`
      Panel { BorderRadius: 4 }
      Panel { BorderRadius: 8; Padding: 6 }
    `);
    expect(sheet.Panel.Style?.BorderRadius).toBe('8');   // later wins
    expect(sheet.Panel.Layout?.Padding).toBe('6');
  });

  it('rejects malformed input clearly', () => {
    expect(() => ParseJss(`Toolbar { Material: None`)).toThrow(/Unterminated/);
    expect(() => ParseJss(`Toolbar { : value }`)).toThrow(/Expected identifier/);
  });

  it('parses :GroupHover into GroupHoverStyle', () => {
    const { Sheet: sheet } = ParseJss(`
      TokenZoneWhat {
        BorderRadius: 4
      }
      TokenZoneWhat:GroupHover {
        BackgroundColor: rgba(245, 200, 80, 0.08)
      }
    `);
    expect(sheet.TokenZoneWhat.Style?.BorderRadius).toBe('4');
    expect(sheet.TokenZoneWhat.GroupHoverStyle?.BackgroundColor).toBe('rgba(245, 200, 80, 0.08)');
    expect(sheet.TokenZoneWhat.HoverStyle).toBeUndefined();
  });

  it('routes Color in :GroupHover into GroupHoverTextStyle', () => {
    const { Sheet: sheet } = ParseJss(`
      Pill {
        BorderRadius: 2
      }
      Pill:GroupHover {
        Color: rgb(255, 255, 255)
      }
    `);
    expect(sheet.Pill.GroupHoverTextStyle?.Color).toBe('rgb(255, 255, 255)');
  });

  it('auto-creates the base ruleset when :State is declared first', () => {
    const { Sheet: sheet } = ParseJss(`
      Pill:Hover { Color: rgb(255, 255, 255) }
      Zone:GroupHover { BackgroundColor: rgba(10, 20, 30, 0.1) }
    `);
    expect(sheet.Pill).toBeDefined();
    expect(sheet.Pill.HoverTextStyle?.Color).toBe('rgb(255, 255, 255)');
    expect(sheet.Zone).toBeDefined();
    expect(sheet.Zone.GroupHoverStyle?.BackgroundColor).toBe('rgba(10, 20, 30, 0.1)');
  });

  it('accepts empty rulesets as zone-documentation', () => {
    const { Sheet: sheet } = ParseJss(`
      ZoneA { }
      ZoneB { }
      ZoneA:GroupHover { BackgroundColor: rgba(1, 2, 3, 0.5) }
    `);
    expect(sheet.ZoneA).toBeDefined();
    expect(sheet.ZoneB).toBeDefined();
    expect(sheet.ZoneA.GroupHoverStyle?.BackgroundColor).toBe('rgba(1, 2, 3, 0.5)');
  });

  it('keeps :Hover and :GroupHover in distinct slots', () => {
    const { Sheet: sheet } = ParseJss(`
      Tag { BorderRadius: 1 }
      Tag:Hover { BackgroundColor: rgb(10, 10, 10) }
      Tag:GroupHover { BackgroundColor: rgba(20, 20, 20, 0.5) }
    `);
    expect(sheet.Tag.HoverStyle?.BackgroundColor).toBe('rgb(10, 10, 10)');
    expect(sheet.Tag.GroupHoverStyle?.BackgroundColor).toBe('rgba(20, 20, 20, 0.5)');
  });

  it('tolerates whitespace and blank lines', () => {
    const { Sheet: sheet } = ParseJss(`


      Card  {

        Padding:   1pt



        Width:   100

      }


    `);
    expect(sheet.Card.Layout?.Padding).toBe('1pt');
    expect(sheet.Card.ChildLayout?.Width).toBe('100');
  });
});

// ─── Compound pseudo predicates (Phase 1) ────────────────────────────────
//
// `:Foo` (single-state pseudo) continues to populate the legacy *Style
// slots — these tests guard that path. New `:(expr)` syntax compiles to
// a PredicateStyles entry whose Predicate is a JSON-safe boolean AST.
// Runtime evaluation lands in Phase 2; here we only verify the parser
// produces the expected AST shape and routes styles into the right slot.

describe('JSS — compound pseudo predicates', () => {
  it('routes :(Single) the same as :Single semantically (own predicate entry)', () => {
    const { Sheet: sheet } = ParseJss(`
      Btn {
        Background: rgba(0, 0, 0, 1)
      }
      Btn:(Hover) {
        BackdropBrightness: 1.85
      }
    `);
    expect(sheet.Btn.PredicateStyles?.length).toBe(1);
    const entry = sheet.Btn.PredicateStyles![0];
    expect(entry.Predicate).toEqual({ Kind: 'State', Name: 'Hover' });
    expect(entry.Style?.BackdropBrightness).toBe('1.85');
    // Legacy slot stays untouched — :(Single) routes ONLY to PredicateStyles.
    expect(sheet.Btn.HoverStyle).toBeUndefined();
  });

  it('parses && into an And node', () => {
    const { Sheet: sheet } = ParseJss(`
      Btn:(Hover && !Disabled) {
        BackdropBrightness: 1.85
      }
    `);
    const entry = sheet.Btn.PredicateStyles![0];
    expect(entry.Predicate).toEqual({
      Kind: 'And',
      Exprs: [
        { Kind: 'State', Name: 'Hover' },
        { Kind: 'Not', Expr: { Kind: 'State', Name: 'Disabled' } },
      ],
    });
  });

  it('parses || into an Or node', () => {
    const { Sheet: sheet } = ParseJss(`
      Btn:(Loading || Recording) {
        Opacity: 0.6
      }
    `);
    expect(sheet.Btn.PredicateStyles![0].Predicate).toEqual({
      Kind: 'Or',
      Exprs: [
        { Kind: 'State', Name: 'Loading' },
        { Kind: 'State', Name: 'Recording' },
      ],
    });
  });

  it('honors !> && > || precedence', () => {
    const { Sheet: sheet } = ParseJss(`
      Btn:(!Disabled && Hover || Pressed) {
        VisualScale: 1
      }
    `);
    // (!Disabled && Hover) || Pressed
    expect(sheet.Btn.PredicateStyles![0].Predicate).toEqual({
      Kind: 'Or',
      Exprs: [
        {
          Kind: 'And',
          Exprs: [
            { Kind: 'Not', Expr: { Kind: 'State', Name: 'Disabled' } },
            { Kind: 'State', Name: 'Hover' },
          ],
        },
        { Kind: 'State', Name: 'Pressed' },
      ],
    });
  });

  it('honors explicit grouping with inner parens', () => {
    const { Sheet: sheet } = ParseJss(`
      Btn:(!(Disabled || Loading)) {
        Opacity: 1
      }
    `);
    expect(sheet.Btn.PredicateStyles![0].Predicate).toEqual({
      Kind: 'Not',
      Expr: {
        Kind: 'Or',
        Exprs: [
          { Kind: 'State', Name: 'Disabled' },
          { Kind: 'State', Name: 'Loading' },
        ],
      },
    });
  });

  it('preserves source order across multiple predicate rules on one class', () => {
    const { Sheet: sheet } = ParseJss(`
      Btn {
        Background: rgba(0, 0, 0, 1)
      }
      Btn:(Hover && !Disabled) {
        BackdropBrightness: 1.85
      }
      Btn:(Pressed && !Disabled) {
        VisualScale: 0.92
      }
      Btn:Disabled {
        Opacity: 0.35
      }
    `);
    expect(sheet.Btn.PredicateStyles?.length).toBe(2);
    expect(sheet.Btn.PredicateStyles![0].Style?.BackdropBrightness).toBe('1.85');
    expect(sheet.Btn.PredicateStyles![1].Style?.VisualScale).toBe('0.92');
    // Legacy :Disabled still routes to the legacy slot.
    expect(sheet.Btn.DisabledStyle?.Opacity).toBe('0.35');
  });

  it('compound predicates inherit through extends', () => {
    const { Sheet: sheet } = ParseJss(`
      BaseBtn {
        Background: rgba(0, 0, 0, 1)
      }
      BaseBtn:(Hover && !Disabled) {
        BackdropBrightness: 1.85
      }
      LargeBtn : BaseBtn {
        Width: 56pt
      }
    `);
    // LargeBtn inherits BaseBtn's predicate rule.
    expect(sheet.LargeBtn.PredicateStyles?.length).toBe(1);
    expect(sheet.LargeBtn.PredicateStyles![0].Style?.BackdropBrightness).toBe('1.85');
  });

  it('routes TextStyle declarations inside :(...) blocks', () => {
    const { Sheet: sheet } = ParseJss(`
      Label:(Hover && !Disabled) {
        Color: rgba(255, 255, 255, 1)
      }
    `);
    const entry = sheet.Label.PredicateStyles![0];
    expect(entry.TextStyle?.Color).toBe('rgba(255, 255, 255, 1)');
    expect(entry.Style?.Color).toBeUndefined();
  });

  it('throws on unbalanced parens', () => {
    expect(() => ParseJss(`Btn:(Hover && Disabled { Opacity: 1 }`))
      .toThrowError(/expected "\)"/);
  });

  it('throws on bare !operand without identifier', () => {
    expect(() => ParseJss(`Btn:(!) { Opacity: 1 }`))
      .toThrowError(/expected state name/);
  });

  it('throws on empty parens', () => {
    expect(() => ParseJss(`Btn:() { Opacity: 1 }`))
      .toThrowError(/expected state name/);
  });
});
