import { describe, it, expect } from 'vitest';
import { ParseJss } from '../src/Jss/Jss.Parser';

describe('JSS — parser', () => {
  it('parses a simple single-class ruleset', () => {
    const sheet = ParseJss(`
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
    const sheet = ParseJss(`
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
    const sheet = ParseJss(`
      Panel {
        Background: rgba(0, 0, 0, 0.5)
        Transform: translate(10, 20) scale(1.5)
      }
    `);
    expect(sheet.Panel.Style?.Background).toBe('rgba(0, 0, 0, 0.5)');
    expect(sheet.Panel.Style?.Transform).toBe('translate(10, 20) scale(1.5)');
  });

  it('accepts arithmetic in length values', () => {
    const sheet = ParseJss(`
      Card {
        Padding: (1pt + 4)
        Width: 100vh - 32
      }
    `);
    expect(sheet.Card.Layout?.Padding).toBe('(1pt + 4)');
    expect(sheet.Card.ChildLayout?.Width).toBe('100vh - 32');
  });

  it('handles block and line comments', () => {
    const sheet = ParseJss(`
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
    const sheet = ParseJss(`Foo { Material: None; BorderRadius: 4; Width: 50; }`);
    expect(sheet.Foo.Style?.Material).toBe('None');
    expect(sheet.Foo.Style?.BorderRadius).toBe('4');
    expect(sheet.Foo.ChildLayout?.Width).toBe('50');
  });

  it('parses multiple rulesets', () => {
    const sheet = ParseJss(`
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
    const sheet = ParseJss(`
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

  it('tolerates whitespace and blank lines', () => {
    const sheet = ParseJss(`


      Card  {

        Padding:   1pt



        Width:   100

      }


    `);
    expect(sheet.Card.Layout?.Padding).toBe('1pt');
    expect(sheet.Card.ChildLayout?.Width).toBe('100');
  });
});
