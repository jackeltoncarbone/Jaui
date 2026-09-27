import { describe, it, expect } from 'vitest';
import {
  Parse, Resolve,
  Pt, Rpt, Pct, PctW, PctH, Vw, Vh,
  type ResolveContext,
} from '../src/Core/Length';

const baseCtx: ResolveContext = {
  ParentWidth: 400,
  ParentHeight: 200,
  PointScale: 16,
  ParentPointScale: 12,
  RootPointScale: 20,
  ViewportWidth: 1000,
  ViewportHeight: 800,
};

describe('Length — helpers produce strings', () => {
  it('unit helpers return strings the parser accepts', () => {
    expect(Pt(1)).toBe('1pt');
    expect(Rpt(1.5)).toBe('1.5rpt');
    expect(Pct(50)).toBe('50%');
    expect(PctW(10)).toBe('10%w');
    expect(PctH(25)).toBe('25%h');
    expect(Vw(100)).toBe('100vw');
    expect(Vh(50)).toBe('50vh');
  });
});

describe('Length — resolver', () => {
  it('plain number resolves to itself (px)', () => {
    expect(Resolve(42, baseCtx, 'W')).toBe(42);
  });

  it('accepts scientific-notation numbers (computed floats stringify that way)', () => {
    expect(Resolve('-7.68987442984957e-14', baseCtx, 'W')).toBeCloseTo(0, 10);
    expect(Resolve('1.5e2', baseCtx, 'W')).toBe(150);
    expect(Resolve('2E-3', baseCtx, 'W')).toBeCloseTo(0.002, 10);
    expect(Resolve('3e+1pt', baseCtx, 'W')).toBe(30 * 16);
  });

  it('pt resolves against current PointScale', () => {
    expect(Resolve('1pt', baseCtx, 'W')).toBe(16);
    expect(Resolve('2.5pt', baseCtx, 'W')).toBe(40);
  });

  it('pt resolves against parent PointScale when ptRefersToParent is set', () => {
    expect(Resolve('1pt', baseCtx, 'W', true)).toBe(12);
  });

  it('rpt resolves against root PointScale', () => {
    expect(Resolve('1.5rpt', baseCtx, 'W')).toBe(30);
  });

  it('% picks parent W or H by axis', () => {
    expect(Resolve('50%', baseCtx, 'W')).toBe(200);
    expect(Resolve('50%', baseCtx, 'H')).toBe(100);
  });

  it('%w and %h override the axis default', () => {
    expect(Resolve('10%w', baseCtx, 'H')).toBe(40);
    expect(Resolve('25%h', baseCtx, 'W')).toBe(50);
  });

  it('vw and vh resolve against viewport', () => {
    expect(Resolve('100vw', baseCtx, 'W')).toBe(1000);
    expect(Resolve('50vh', baseCtx, 'W')).toBe(400);
  });

  it('arithmetic composes correctly', () => {
    expect(Resolve('100% - 2rpt', baseCtx, 'H')).toBe(160);
    expect(Resolve('(1pt + 4) * 2', baseCtx, 'W')).toBe(40);
    expect(Resolve('100vh / 4', baseCtx, 'W')).toBe(200);
  });
});

describe('Length — @Height/@Width builtins (JwiftStretchyHeader\'s own-box reference)', () => {
  it('reads the node\'s own SelfWidth/SelfHeight, not a var table entry', () => {
    const ctx: ResolveContext = { ...baseCtx, SelfWidth: 731, SelfHeight: 82 };
    expect(Resolve('@Height', ctx, 'W')).toBe(82);
    expect(Resolve('@Width', ctx, 'W')).toBe(731);
    // Bare (no `@`) resolves identically — same builtin-identifier path as Presence/Entering/Exiting.
    expect(Resolve('Height', ctx, 'W')).toBe(82);
  });

  it('falls back to 0 when absent (layout-pass / seed contexts)', () => {
    expect(Resolve('@Height', baseCtx, 'W')).toBe(0);
    expect(Resolve('@Width', baseCtx, 'W')).toBe(0);
  });

  it('composes in an expression, e.g. a stretchy header\'s zoom fraction', () => {
    const ctx: ResolveContext = { ...baseCtx, SelfHeight: 100 };
    expect(Resolve('1 + 20 / @Height', ctx, 'W')).toBe(1.2);
  });

  it('never reads a var table entry named the same, even if one is present', () => {
    const ctx: ResolveContext = { ...baseCtx, SelfHeight: 50, Vars: new Map([['Height', '999']]) };
    expect(Resolve('@Height', ctx, 'W')).toBe(50);
  });
});

describe('Length — string parser', () => {
  it('parses bare numbers and unit literals', () => {
    expect(Resolve('16', baseCtx, 'W')).toBe(16);
    expect(Resolve('1pt', baseCtx, 'W')).toBe(16);
    expect(Resolve('0.5pt', baseCtx, 'W')).toBe(8);
    expect(Resolve('1.5rpt', baseCtx, 'W')).toBe(30);
    expect(Resolve('100%', baseCtx, 'W')).toBe(400);
    expect(Resolve('50%h', baseCtx, 'W')).toBe(100);
  });

  it('px suffix collapses to plain number', () => {
    // Parse returns a non-number (Relative wrapper) but Resolve still gives
    // back the plain pixel count.
    expect(Resolve('16px', baseCtx, 'W')).toBe(16);
    expect(Resolve('42', baseCtx, 'W')).toBe(42);
    expect(Parse('16px')).toBe(16);
    expect(Parse('42')).toBe(42);
  });

  it('parses arithmetic with standard precedence', () => {
    expect(Resolve('1pt + 4', baseCtx, 'W')).toBe(20);
    expect(Resolve('2 * 3 + 4', baseCtx, 'W')).toBe(10);
    expect(Resolve('2 + 3 * 4', baseCtx, 'W')).toBe(14);
  });

  it('parens override precedence', () => {
    expect(Resolve('(100vh - 64) / 3', baseCtx, 'W')).toBeCloseTo(245.333, 2);
    expect(Resolve('(2 + 3) * 4', baseCtx, 'W')).toBe(20);
  });

  it('handles unary minus', () => {
    expect(Resolve('-4', baseCtx, 'W')).toBe(-4);
    expect(Resolve('-0.5pt', baseCtx, 'W')).toBe(-8);
    expect(Resolve('10 + -4', baseCtx, 'W')).toBe(6);
    expect(Resolve('-(2 + 3)', baseCtx, 'W')).toBe(-5);
  });

  it('tolerates whitespace (or lack of it) around operators', () => {
    expect(Resolve('1pt+4', baseCtx, 'W')).toBe(20);
    expect(Resolve('1pt + 4', baseCtx, 'W')).toBe(20);
    expect(Resolve('  1pt  +  4  ', baseCtx, 'W')).toBe(20);
  });

  it('unit matching is case-insensitive', () => {
    expect(Resolve('1PT', baseCtx, 'W')).toBe(16);
    expect(Resolve('100Vh', baseCtx, 'W')).toBe(800);
    expect(Resolve('50%W', baseCtx, 'H')).toBe(200);
  });

  it('caches parse results across calls', () => {
    // Same string resolved twice should produce identical numeric output;
    // the cache doesn't affect correctness, just perf. This test just
    // verifies nothing goes wrong on repeat.
    expect(Resolve('1pt + 4', baseCtx, 'W')).toBe(20);
    expect(Resolve('1pt + 4', baseCtx, 'W')).toBe(20);
    expect(Resolve('1pt + 4', baseCtx, 'W')).toBe(20);
  });

  it('rejects malformed input with a clear error', () => {
    expect(() => Parse('1pt +')).toThrow();
    expect(() => Parse('(1pt')).toThrow();
    expect(() => Parse('1em')).toThrow();
    expect(() => Parse('1pt 2pt')).toThrow();
  });
});
