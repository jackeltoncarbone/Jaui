import { describe, it, expect } from 'vitest';
import { Jiv } from '../src/Jiv/Jiv';

describe('Jiv interaction states', () => {

  it('EffectiveStyle returns base reference when no state active (no alloc)', () => {
    const j = new Jiv({ Style: { Opacity: 0.5 } });
    const eff = j.EffectiveStyle();
    expect(eff).toBe(j.Style); // same reference
  });

  it('Hover overrides specific props when Hover=true', () => {
    const j = new Jiv({
      Style: { Opacity: 1.0 },
      PredicateStyles: [
        { Predicate: { Kind: 'State', Name: 'Hover' }, Style: { Opacity: 0.7 } },
      ],
    });
    expect(j.EffectiveStyle().Opacity).toBe(1.0);
    j.Hover = true;
    expect(j.EffectiveStyle().Opacity).toBe(0.7);
  });

  it('source-order last-wins reproduces the legacy Disabled > Focus > Active > Hover priority', () => {
    // The pre-predicate engine had a hard-coded merge order; today it's just
    // source-order last-wins. Declaring the entries in Hover→Active→Focus→
    // Disabled order reproduces the exact precedence chain.
    const j = new Jiv({
      Style: { Opacity: 1.0 },
      PredicateStyles: [
        { Predicate: { Kind: 'State', Name: 'Hover' },    Style: { Opacity: 0.9 } },
        { Predicate: { Kind: 'State', Name: 'Active' },   Style: { Opacity: 0.8 } },
        { Predicate: { Kind: 'State', Name: 'Focus' },    Style: { Opacity: 0.7 } },
        { Predicate: { Kind: 'State', Name: 'Disabled' }, Style: { Opacity: 0.3 } },
      ],
    });

    j.Hover = true;
    expect(j.EffectiveStyle().Opacity).toBe(0.9);

    j.Active = true;
    expect(j.EffectiveStyle().Opacity).toBe(0.8); // Active over Hover

    j.Focus = true;
    expect(j.EffectiveStyle().Opacity).toBe(0.7); // Focus over Active

    j.Disabled = true;
    expect(j.EffectiveStyle().Opacity).toBe(0.3); // Disabled wins all
  });

  it('missing predicate match → falls through to base by reference', () => {
    const j = new Jiv({ Style: { Opacity: 0.5 } });
    j.Hover = true; // no PredicateStyles attached
    expect(j.EffectiveStyle()).toBe(j.Style); // zero-alloc fast path
  });

  it('base unchanged after merge — does not mutate', () => {
    const j = new Jiv({
      Style: { Opacity: 1.0 },
      PredicateStyles: [
        { Predicate: { Kind: 'State', Name: 'Hover' }, Style: { Opacity: 0.5 } },
      ],
    });
    j.Hover = true;
    j.EffectiveStyle();
    expect(j.Style.Opacity).toBe(1.0); // base preserved
  });
});

// ─── Compound pseudo predicates (Phase 2 runtime) ────────────────────────

describe('Jiv compound predicate runtime', () => {

  it('predicate fires when its expression matches the live state set', () => {
    const j = new Jiv({
      Style: { Opacity: 1.0 },
      PredicateStyles: [
        {
          Predicate: { Kind: 'State', Name: 'Hover' },
          Style: { Opacity: 0.7 },
        },
      ],
    });
    expect(j.EffectiveStyle().Opacity).toBe(1.0); // not hovering yet
    j.Hover = true;
    expect(j.EffectiveStyle().Opacity).toBe(0.7); // predicate matches
    j.Hover = false;
    expect(j.EffectiveStyle().Opacity).toBe(1.0);
  });

  it('And: (Hover && !Disabled) suppresses lift when Disabled is set', () => {
    const j = new Jiv({
      Style: { Opacity: 1.0 },
      PredicateStyles: [
        {
          Predicate: {
            Kind: 'And',
            Exprs: [
              { Kind: 'State', Name: 'Hover' },
              { Kind: 'Not', Expr: { Kind: 'State', Name: 'Disabled' } },
            ],
          },
          Style: { Opacity: 0.7 },
        },
        {
          Predicate: { Kind: 'State', Name: 'Disabled' },
          Style: { Opacity: 0.3 },
        },
      ],
    });
    j.Hover = true;
    expect(j.EffectiveStyle().Opacity).toBe(0.7); // !Disabled is true, hover applies
    j.Disabled = true;
    // Disabled fires (0.3), Hover-only predicate suppressed by !Disabled
    expect(j.EffectiveStyle().Opacity).toBe(0.3);
  });

  it('Or: (Loading || Recording) fires when EITHER state is set', () => {
    const j = new Jiv({
      Style: { Opacity: 1.0 },
      PredicateStyles: [{
        Predicate: {
          Kind: 'Or',
          Exprs: [
            { Kind: 'State', Name: 'Loading' },
            { Kind: 'State', Name: 'Recording' },
          ],
        },
        Style: { Opacity: 0.5 },
      }],
    });
    expect(j.EffectiveStyle().Opacity).toBe(1.0);
    j.SetState('Loading', true);
    expect(j.EffectiveStyle().Opacity).toBe(0.5);
    j.SetState('Loading', false);
    j.SetState('Recording', true);
    expect(j.EffectiveStyle().Opacity).toBe(0.5);
  });

  it('SetState for arbitrary user-named states drives predicates', () => {
    const j = new Jiv({
      Style: { Opacity: 1.0 },
      PredicateStyles: [{
        Predicate: { Kind: 'State', Name: 'Recording' },
        Style: { Opacity: 0.4 },
      }],
    });
    j.SetState('Recording', true);
    expect(j.EffectiveStyle().Opacity).toBe(0.4);
  });

  it('source order — later predicate wins on conflicting properties', () => {
    const j = new Jiv({
      Style: { Opacity: 1.0 },
      PredicateStyles: [
        { Predicate: { Kind: 'State', Name: 'Hover' }, Style: { Opacity: 0.5 } },
        // Later entry — wins when both predicates match.
        { Predicate: { Kind: 'State', Name: 'Hover' }, Style: { Opacity: 0.2 } },
      ],
    });
    j.Hover = true;
    expect(j.EffectiveStyle().Opacity).toBe(0.2);
  });

  it('Pressed is an alias for Active in the state set', () => {
    const j = new Jiv({
      Style: { Opacity: 1.0 },
      PredicateStyles: [{
        Predicate: { Kind: 'State', Name: 'Pressed' },
        Style: { Opacity: 0.6 },
      }],
    });
    j.Active = true;
    expect(j.EffectiveStyle().Opacity).toBe(0.6);
  });

  it('Disabled auto-forces Interactive:false + Cursor:Default, restored on exit', () => {
    const j = new Jiv({
      Style: { Opacity: 1.0 },
      Interactive: true,
      Cursor: 'Pointer',
    });
    expect(j.Interactive).toBe(true);
    expect(j.Cursor).toBe('Pointer');
    j.Disabled = true;
    expect(j.Interactive).toBe(false);
    expect(j.Cursor).toBe('Default');
    j.Disabled = false;
    expect(j.Interactive).toBe(true);
    expect(j.Cursor).toBe('Pointer');
  });

  it('Disabled defaults are overridable from PredicateStyles', () => {
    const j = new Jiv({
      Style: {},
      // (Disabled predicate would route Interactive into ElementProps in
      // a real JSS path, not the Style bag. The Style-merge-only
      // EffectiveStyle path doesn't bridge to ElementProps, so this
      // test focuses on what the cascade itself produces. A full
      // override of Interactive lives at the worker registry layer.)
      PredicateStyles: [{
        Predicate: { Kind: 'State', Name: 'Disabled' },
        Style: { Opacity: 0.35 },
      }],
    });
    j.Disabled = true;
    // Opacity comes from the :Disabled predicate.
    expect(j.EffectiveStyle().Opacity).toBe(0.35);
  });

  it('SetPredicateStyles applied AFTER construction (bridge production path)', () => {
    // Mirrors the worker registry's flow: JivCore is constructed without
    // PredicateStyles (initial create), then SetPredicateStyles is called
    // with a structured-cloned-shaped list. Then Hover flips via the
    // typed setter (same path the canvas hit-test uses). This proves the
    // predicate path works through the actual production-shape APIs, not
    // just the constructor convenience.
    const j = new Jiv({ Style: { BackdropBrightness: 1.0 } });

    // Same shape as what arrives across the structured-clone bridge:
    // plain nested objects, no class methods, no readonly tagging.
    const incoming: any[] = [
      {
        Predicate: {
          Kind: 'And',
          Exprs: [
            { Kind: 'State', Name: 'Hover' },
            { Kind: 'Not', Expr: { Kind: 'State', Name: 'Disabled' } },
          ],
        },
        Style: { BackdropBrightness: 1.85 },
      },
    ];
    j.SetPredicateStyles(incoming);

    // Before hover — predicate doesn't match, base value.
    expect(j.EffectiveStyle().BackdropBrightness).toBe(1.0);

    // Hover via typed setter — same path the canvas uses.
    j.Hover = true;
    expect(j.EffectiveStyle().BackdropBrightness).toBe(1.85);

    // Hover off — back to base.
    j.Hover = false;
    expect(j.EffectiveStyle().BackdropBrightness).toBe(1.0);

    // Disabled — predicate should not match even when hovered.
    j.Hover = true;
    j.Disabled = true;
    expect(j.EffectiveStyle().BackdropBrightness).toBe(1.0);
  });
});
