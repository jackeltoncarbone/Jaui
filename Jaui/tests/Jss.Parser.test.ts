import { describe, it, expect } from 'vitest';
import { ParseJss } from '../src/Jss/Jss.Parser';
import { EvaluatePredicate } from '../src/Jss/Jss.Predicate';
import { Resolve, TERNARY_SENTINEL, type ResolveContext } from '../src/Core/Length';

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

  it('parses :GroupHover into a PredicateStyles entry', () => {
    const { Sheet: sheet } = ParseJss(`
      TokenZoneWhat {
        BorderRadius: 4
      }
      TokenZoneWhat:GroupHover {
        BackgroundColor: rgba(245, 200, 80, 0.08)
      }
    `);
    expect(sheet.TokenZoneWhat.Style?.BorderRadius).toBe('4');
    expect(sheet.TokenZoneWhat.PredicateStyles?.length).toBe(1);
    const e = sheet.TokenZoneWhat.PredicateStyles![0];
    expect(e.Predicate).toEqual({ Kind: 'State', Name: 'GroupHover' });
    expect(e.Style?.BackgroundColor).toBe('rgba(245, 200, 80, 0.08)');
  });

  it('routes Color in :GroupHover into the predicate entry TextStyle', () => {
    const { Sheet: sheet } = ParseJss(`
      Pill {
        BorderRadius: 2
      }
      Pill:GroupHover {
        Color: rgb(255, 255, 255)
      }
    `);
    expect(sheet.Pill.PredicateStyles![0].TextStyle?.Color).toBe('rgb(255, 255, 255)');
  });

  it('auto-creates the base ruleset when :State is declared first', () => {
    const { Sheet: sheet } = ParseJss(`
      Pill:Hover { Color: rgb(255, 255, 255) }
      Zone:GroupHover { BackgroundColor: rgba(10, 20, 30, 0.1) }
    `);
    expect(sheet.Pill).toBeDefined();
    expect(sheet.Pill.PredicateStyles![0].Predicate).toEqual({ Kind: 'State', Name: 'Hover' });
    expect(sheet.Pill.PredicateStyles![0].TextStyle?.Color).toBe('rgb(255, 255, 255)');
    expect(sheet.Zone).toBeDefined();
    expect(sheet.Zone.PredicateStyles![0].Predicate).toEqual({ Kind: 'State', Name: 'GroupHover' });
    expect(sheet.Zone.PredicateStyles![0].Style?.BackgroundColor).toBe('rgba(10, 20, 30, 0.1)');
  });

  it('accepts empty rulesets as zone-documentation', () => {
    const { Sheet: sheet } = ParseJss(`
      ZoneA { }
      ZoneB { }
      ZoneA:GroupHover { BackgroundColor: rgba(1, 2, 3, 0.5) }
    `);
    expect(sheet.ZoneA).toBeDefined();
    expect(sheet.ZoneB).toBeDefined();
    expect(sheet.ZoneA.PredicateStyles![0].Style?.BackgroundColor).toBe('rgba(1, 2, 3, 0.5)');
  });

  it('keeps :Hover and :GroupHover as distinct predicate entries', () => {
    const { Sheet: sheet } = ParseJss(`
      Tag { BorderRadius: 1 }
      Tag:Hover { BackgroundColor: rgb(10, 10, 10) }
      Tag:GroupHover { BackgroundColor: rgba(20, 20, 20, 0.5) }
    `);
    expect(sheet.Tag.PredicateStyles?.length).toBe(2);
    expect(sheet.Tag.PredicateStyles![0].Predicate).toEqual({ Kind: 'State', Name: 'Hover' });
    expect(sheet.Tag.PredicateStyles![0].Style?.BackgroundColor).toBe('rgb(10, 10, 10)');
    expect(sheet.Tag.PredicateStyles![1].Predicate).toEqual({ Kind: 'State', Name: 'GroupHover' });
    expect(sheet.Tag.PredicateStyles![1].Style?.BackgroundColor).toBe('rgba(20, 20, 20, 0.5)');
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
  it(':Hover and :(Hover) produce equivalent PredicateStyles entries', () => {
    // Both forms parse to a single-state predicate `{ Kind: 'State', Name: 'Hover' }`.
    // The tight `:Hover` form is just authoring sugar for `:(Hover)`.
    const a = ParseJss(`Btn:Hover { BackdropBrightness: 1.85 }`).Sheet;
    const b = ParseJss(`Btn:(Hover) { BackdropBrightness: 1.85 }`).Sheet;
    expect(a.Btn.PredicateStyles).toEqual(b.Btn.PredicateStyles);
    const entry = a.Btn.PredicateStyles![0];
    expect(entry.Predicate).toEqual({ Kind: 'State', Name: 'Hover' });
    expect(entry.Style?.BackdropBrightness).toBe('1.85');
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

  it('preserves source order across multiple pseudo rules on one class', () => {
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
    // All three pseudo rules — both compound and tight :Disabled — land
    // in PredicateStyles in source order. The runtime evaluates them
    // against the live state set and merges matches in declaration order.
    expect(sheet.Btn.PredicateStyles?.length).toBe(3);
    expect(sheet.Btn.PredicateStyles![0].Style?.BackdropBrightness).toBe('1.85');
    expect(sheet.Btn.PredicateStyles![1].Style?.VisualScale).toBe('0.92');
    expect(sheet.Btn.PredicateStyles![2].Predicate).toEqual({ Kind: 'State', Name: 'Disabled' });
    expect(sheet.Btn.PredicateStyles![2].Style?.Opacity).toBe('0.35');
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
      .toThrowError(/expected a state/);
  });

  it('throws on empty parens', () => {
    expect(() => ParseJss(`Btn:() { Opacity: 1 }`))
      .toThrowError(/expected a state/);
  });
});

// ─── @If responsive blocks ────────────────────────────────────────────────
// `@If (cond) { … }` compiles to PredicateStyles carrying all four content
// slots, guarded by viewport-comparison predicates.
describe('JSS — @If responsive', () => {
  it('parses a block @If into a PredicateStyle with a Compare predicate', () => {
    const { Sheet: sheet } = ParseJss(`
      Rail {
        Width: 100vw
        @If (Width >= 1024) { Width: 312pt }
      }
    `);
    expect(sheet.Rail.ChildLayout?.Width).toBe('100vw');
    const ps = sheet.Rail.PredicateStyles!;
    expect(ps.length).toBe(1);
    expect(ps[0].Predicate).toEqual({ Kind: 'Compare', Metric: 'Width', Op: '>=', Value: 1024 });
    expect(ps[0].ChildLayout?.Width).toBe('312pt');
  });

  it('@If carries Layout/ChildLayout/Style/TextStyle slots', () => {
    const { Sheet: sheet } = ParseJss(`
      Panel {
        @If (Width < 600) {
          Padding: 8pt
          Left: 0pt
          Background: rgba(0, 0, 0, 0.4)
          FontSize: 12pt
        }
      }
    `);
    const ps = sheet.Panel.PredicateStyles![0];
    expect(ps.Layout?.Padding).toBe('8pt');
    expect(ps.ChildLayout?.Left).toBe('0pt');
    expect(ps.Style?.Background).toBe('rgba(0, 0, 0, 0.4)');
    expect(ps.TextStyle?.FontSize).toBe('12pt');
  });

  it('resolves @Var thresholds declared above the rule', () => {
    const { Sheet: sheet } = ParseJss(`
      @DesktopMin: 1024
      Field {
        @If (Width >= @DesktopMin) { Left: 312pt }
      }
    `);
    expect(sheet.Field.PredicateStyles![0].Predicate)
      .toEqual({ Kind: 'Compare', Metric: 'Width', Op: '>=', Value: 1024 });
  });

  it('supports compound conditions (Width + state) with precedence', () => {
    const { Sheet: sheet } = ParseJss(`
      Bar {
        @If (Width < 600 && !Recording) { Opacity: 0.5 }
      }
    `);
    expect(sheet.Bar.PredicateStyles![0].Predicate).toEqual({
      Kind: 'And',
      Exprs: [
        { Kind: 'Compare', Metric: 'Width', Op: '<', Value: 600 },
        { Kind: 'Not', Expr: { Kind: 'State', Name: 'Recording' } },
      ],
    });
  });

  it('top-level @If wraps whole classes, guarding each rule', () => {
    const { Sheet: sheet } = ParseJss(`
      @If (Width >= 1024) {
        Rail  { Width: 312pt }
        Field { Left: 312pt }
      }
    `);
    expect(sheet.Rail.PredicateStyles![0].ChildLayout?.Width).toBe('312pt');
    expect(sheet.Rail.PredicateStyles![0].Predicate)
      .toEqual({ Kind: 'Compare', Metric: 'Width', Op: '>=', Value: 1024 });
    expect(sheet.Field.PredicateStyles![0].ChildLayout?.Left).toBe('312pt');
    // Guarded rules emit no base slots — only the predicate entry.
    expect(sheet.Rail.ChildLayout?.Width).toBeUndefined();
  });

  it('AND-merges a top-level guard into an inner pseudo predicate', () => {
    const { Sheet: sheet } = ParseJss(`
      @If (Width >= 1024) {
        Btn:Hover { Opacity: 1 }
      }
    `);
    expect(sheet.Btn.PredicateStyles![0].Predicate).toEqual({
      Kind: 'And',
      Exprs: [
        { Kind: 'Compare', Metric: 'Width', Op: '>=', Value: 1024 },
        { Kind: 'State', Name: 'Hover' },
      ],
    });
  });

  it('nested @If AND-merges conditions', () => {
    const { Sheet: sheet } = ParseJss(`
      Box {
        @If (Width >= 600) {
          @If (Width < 1024) { Padding: 4pt }
        }
      }
    `);
    expect(sheet.Box.PredicateStyles![0].Predicate).toEqual({
      Kind: 'And',
      Exprs: [
        { Kind: 'Compare', Metric: 'Width', Op: '>=', Value: 600 },
        { Kind: 'Compare', Metric: 'Width', Op: '<', Value: 1024 },
      ],
    });
    expect(sheet.Box.PredicateStyles![0].Layout?.Padding).toBe('4pt');
  });

  it('throws on an unknown @If threshold variable', () => {
    expect(() => ParseJss(`Box { @If (Width > @Nope) { Opacity: 1 } }`))
      .toThrowError(/unknown variable/);
  });
});

// ─── Predicate evaluation ─────────────────────────────────────────────────
describe('JSS — EvaluatePredicate', () => {
  const ctx = (w: number, h: number, ...states: string[]) =>
    ({ States: new Set(states), ViewportW: w, ViewportH: h });

  it('evaluates Width/Height comparisons against the viewport', () => {
    const ge = ParseJss(`R { @If (Width >= 1024) { Left: 0pt } }`).Sheet.R.PredicateStyles![0].Predicate;
    expect(EvaluatePredicate(ge, ctx(1440, 900))).toBe(true);
    expect(EvaluatePredicate(ge, ctx(800, 900))).toBe(false);
    const lt = ParseJss(`R { @If (Height < 500) { Left: 0pt } }`).Sheet.R.PredicateStyles![0].Predicate;
    expect(EvaluatePredicate(lt, ctx(844, 390))).toBe(true);
    expect(EvaluatePredicate(lt, ctx(844, 900))).toBe(false);
  });

  it('combines viewport + state under &&/||/!', () => {
    const p = ParseJss(`R { @If (Width < 600 && !Recording) { Opacity: 0.5 } }`)
      .Sheet.R.PredicateStyles![0].Predicate;
    expect(EvaluatePredicate(p, ctx(390, 844))).toBe(true);
    expect(EvaluatePredicate(p, ctx(390, 844, 'Recording'))).toBe(false);
    expect(EvaluatePredicate(p, ctx(900, 844))).toBe(false);
  });

  it('still accepts a bare state Set (states-only, viewport 0)', () => {
    const p = ParseJss(`B:(Hover) { Opacity: 1 }`).Sheet.B.PredicateStyles![0].Predicate;
    expect(EvaluatePredicate(p, new Set(['Hover']))).toBe(true);
    expect(EvaluatePredicate(p, new Set())).toBe(false);
  });
});

// ─── Scoped @If: Self / Parent / Ancestor + contextual nesting ─────────────
describe('JSS — scoped @If (container & ancestor queries)', () => {
  const predOf = (src: string, cls = 'R') => ParseJss(src).Sheet[cls].PredicateStyles![0].Predicate;

  it('parses Self/Parent/Ancestor size scopes', () => {
    expect(predOf(`R { @If (Self.Width < 300) { Direction: Column } }`))
      .toEqual({ Kind: 'Compare', Scope: { Kind: 'Self' }, Metric: 'Width', Op: '<', Value: 300 });
    expect(predOf(`R { @If (Parent.Height >= 600) { Width: 50% } }`))
      .toEqual({ Kind: 'Compare', Scope: { Kind: 'Parent' }, Metric: 'Height', Op: '>=', Value: 600 });
    expect(predOf(`R { @If (Ancestor(Sidebar).Width > 400) { Padding: 8pt } }`))
      .toEqual({ Kind: 'Compare', Scope: { Kind: 'Ancestor', Class: 'Sidebar' }, Metric: 'Width', Op: '>', Value: 400 });
  });

  it('parses Ancestor / Parent / Ancestor:State context predicates', () => {
    expect(predOf(`R { @If (Ancestor(Compact)) { Padding: 6pt } }`))
      .toEqual({ Kind: 'Ancestor', Class: 'Compact', Direct: false });
    expect(predOf(`R { @If (Parent(List)) { Opacity: 1 } }`))
      .toEqual({ Kind: 'Ancestor', Class: 'List', Direct: true });
    expect(predOf(`R { @If (Ancestor(List):Hover) { Opacity: 1 } }`))
      .toEqual({ Kind: 'Ancestor', Class: 'List', Direct: false, State: 'Hover' });
  });

  it('desugars contextual nesting `Ancestor Target { … }` to an Ancestor guard', () => {
    const { Sheet } = ParseJss(`Compact Toolbar { Gap: 4pt }`);
    const ps = Sheet.Toolbar.PredicateStyles![0];
    expect(ps.Predicate).toEqual({ Kind: 'Ancestor', Class: 'Compact', Direct: false });
    expect(ps.Layout?.Gap).toBe('4pt');
    expect(Sheet.Compact).toBeUndefined(); // the leading name is context, not its own rule
  });

  it('AND-merges multiple ancestors in a descendant chain', () => {
    const { Sheet } = ParseJss(`Sidebar Compact Item { Padding: 2pt }`);
    expect(Sheet.Item.PredicateStyles![0].Predicate).toEqual({
      Kind: 'And',
      Exprs: [
        { Kind: 'Ancestor', Class: 'Sidebar', Direct: false },
        { Kind: 'Ancestor', Class: 'Compact', Direct: false },
      ],
    });
  });

  it('combines an ancestor condition with a size condition', () => {
    expect(predOf(`R { @If (Ancestor(Compact) && Width < 900) { Gap: 4pt } }`)).toEqual({
      Kind: 'And',
      Exprs: [
        { Kind: 'Ancestor', Class: 'Compact', Direct: false },
        { Kind: 'Compare', Metric: 'Width', Op: '<', Value: 900 },
      ],
    });
  });

  // ── Evaluation against a mock element tree ──
  type El = { Width: number; Height: number; Parent: El | null; Classes: string[]; States: Set<string> };
  const node = (o: Partial<El>): El =>
    ({ Width: o.Width ?? 0, Height: o.Height ?? 0, Parent: o.Parent ?? null, Classes: o.Classes ?? [], States: o.States ?? new Set() });
  const ctxFor = (el: El) => ({ States: el.States, ViewportW: 0, ViewportH: 0, Element: el });

  it('evaluates Self / Parent / Ancestor sizes against the tree', () => {
    const sidebar = node({ Width: 500, Classes: ['Sidebar'] });
    const parent = node({ Width: 320, Parent: sidebar });
    const self = node({ Width: 280, Parent: parent });

    expect(EvaluatePredicate(predOf(`R { @If (Self.Width < 300) { x: 1 } }`), ctxFor(self))).toBe(true);
    expect(EvaluatePredicate(predOf(`R { @If (Parent.Width >= 320) { x: 1 } }`), ctxFor(self))).toBe(true);
    expect(EvaluatePredicate(predOf(`R { @If (Ancestor(Sidebar).Width > 400) { x: 1 } }`), ctxFor(self))).toBe(true);
    expect(EvaluatePredicate(predOf(`R { @If (Ancestor(Nope).Width > 0) { x: 1 } }`), ctxFor(self))).toBe(false);
  });

  it('evaluates Ancestor / Parent / Ancestor:State context', () => {
    const list = node({ Classes: ['List'], States: new Set(['Hover']) });
    const row = node({ Classes: ['Row'], Parent: list });
    const cell = node({ Parent: row });

    expect(EvaluatePredicate(predOf(`R { @If (Ancestor(List)) { x: 1 } }`), ctxFor(cell))).toBe(true);
    expect(EvaluatePredicate(predOf(`R { @If (Parent(List)) { x: 1 } }`), ctxFor(cell))).toBe(false); // List is grandparent
    expect(EvaluatePredicate(predOf(`R { @If (Parent(Row)) { x: 1 } }`), ctxFor(cell))).toBe(true);
    expect(EvaluatePredicate(predOf(`R { @If (Ancestor(List):Hover) { x: 1 } }`), ctxFor(cell))).toBe(true);
    list.States = new Set();
    expect(EvaluatePredicate(predOf(`R { @If (Ancestor(List):Hover) { x: 1 } }`), ctxFor(cell))).toBe(false);
  });
});

// ─── Inline ternary values (`cond ? a : b`) ───────────────────────────────
describe('JSS — inline ternary values', () => {
  const baseCtx = (over: Partial<ResolveContext>): ResolveContext => ({
    ParentWidth: 0, ParentHeight: 0,
    PointScale: 1, ParentPointScale: 1, RootPointScale: 1,
    ViewportWidth: 0, ViewportHeight: 0, Vars: new Map(),
    ...over,
  });

  it('compiles a ternary value to a sentinel-encoded condition + branches', () => {
    const raw = ParseJss(`R { Left: Width >= 1024 ? 312pt : 0pt }`).Sheet.R.ChildLayout!.Left as string;
    expect(raw.startsWith(TERNARY_SENTINEL)).toBe(true);
    const node = JSON.parse(raw.slice(TERNARY_SENTINEL.length));
    expect(node.Cond).toEqual({ Kind: 'Compare', Metric: 'Width', Op: '>=', Value: 1024 });
    expect(node.T).toBe('312pt');
    expect(node.F).toBe('0pt');
  });

  it('resolves a viewport ternary to the chosen branch', () => {
    const raw = ParseJss(`R { Left: Width >= 1024 ? 312pt : 0pt }`).Sheet.R.ChildLayout!.Left as string;
    expect(Resolve(raw, baseCtx({ ViewportWidth: 1440 }), 'W')).toBe(312); // PointScale 1 → 312pt = 312
    expect(Resolve(raw, baseCtx({ ViewportWidth: 800 }), 'W')).toBe(0);
  });

  it('resolves a chained ternary', () => {
    const raw = ParseJss(`R { Left: Width >= 1024 ? 300 : Width >= 600 ? 150 : 0 }`).Sheet.R.ChildLayout!.Left as string;
    expect(Resolve(raw, baseCtx({ ViewportWidth: 1440 }), 'W')).toBe(300);
    expect(Resolve(raw, baseCtx({ ViewportWidth: 800 }), 'W')).toBe(150);
    expect(Resolve(raw, baseCtx({ ViewportWidth: 400 }), 'W')).toBe(0);
  });

  it('resolves a Self.Width ternary against the element box', () => {
    const raw = ParseJss(`R { Left: Self.Width < 300 ? 4 : 12 }`).Sheet.R.ChildLayout!.Left as string;
    const el = (w: number) => ({ LayoutWidth: w, LayoutHeight: 0, Parent: null, Classes: [], StateSet: new Set<string>() });
    expect(Resolve(raw, baseCtx({ Element: el(280) }), 'W')).toBe(4);
    expect(Resolve(raw, baseCtx({ Element: el(400) }), 'W')).toBe(12);
  });

  it('leaves non-ternary values untouched', () => {
    expect(Resolve('42', baseCtx({}), 'W')).toBe(42);
    const raw = ParseJss(`R { Left: 100 }`).Sheet.R.ChildLayout!.Left as string;
    expect(raw).toBe('100');
  });
});
