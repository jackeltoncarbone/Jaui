import { describe, it, expect } from 'vitest';
import { PickClaimant } from '../src/Scroll/Scroll.PanClaim';
import type { PanClaim } from '../src/Element/Element';

describe('PickClaimant: which ancestor takes a pan', () => {
  it('Horizontal claims a sideways-dominant pan', () => {
    expect(PickClaimant(['Horizontal'], 20, 4, true)).toBe(0);
    expect(PickClaimant(['Horizontal'], 4, 20, true)).toBe(-1);
  });

  it('Down claims a downward-dominant pan only when the vertical scroller is at its top', () => {
    expect(PickClaimant(['Down'], 0, 20, true)).toBe(0);
    expect(PickClaimant(['Down'], 0, 20, false)).toBe(-1);
    // Upward travel is never Down's.
    expect(PickClaimant(['Down'], 0, -20, true)).toBe(-1);
  });

  it('Vertical claims either direction, same top gate as Down', () => {
    expect(PickClaimant(['Vertical'], 0, 20, true)).toBe(0);
    expect(PickClaimant(['Vertical'], 0, -20, true)).toBe(0);
    expect(PickClaimant(['Vertical'], 0, -20, false)).toBe(-1);
  });

  it('VerticalAlways claims either direction whether or not the scroller is at its top', () => {
    expect(PickClaimant(['VerticalAlways'], 0, 20, true)).toBe(0);
    expect(PickClaimant(['VerticalAlways'], 0, -20, true)).toBe(0);
    expect(PickClaimant(['VerticalAlways'], 0, -20, false)).toBe(0);
    expect(PickClaimant(['VerticalAlways'], 0, 20, false)).toBe(0);
    // A sideways pan is never a vertical claim's.
    expect(PickClaimant(['VerticalAlways'], 20, 4, false)).toBe(-1);
  });

  it('Hold never claims, however it is pushed', () => {
    expect(PickClaimant(['Hold'], 20, 0, true)).toBe(-1);
    expect(PickClaimant(['Hold'], 0, 20, true)).toBe(-1);
    expect(PickClaimant(['Hold'], 0, -20, true)).toBe(-1);
  });

  it('None never claims', () => {
    expect(PickClaimant(['None'], 20, 0, true)).toBe(-1);
  });

  it('walks nearest first: an inner claimant wins over an outer one that would also match', () => {
    const claims: PanClaim[] = ['Horizontal', 'Vertical'];
    // A sideways pan: only the inner (index 0) Horizontal claim matches.
    expect(PickClaimant(claims, 20, 0, true)).toBe(0);
  });

  it('skips a non-matching nearer claimant and falls through to one further out', () => {
    const claims: PanClaim[] = ['Hold', 'Down'];
    expect(PickClaimant(claims, 0, 20, true)).toBe(1);
  });

  it('returns -1 when no claimant in the chain matches', () => {
    const claims: PanClaim[] = ['Hold', 'Horizontal'];
    expect(PickClaimant(claims, 0, 20, true)).toBe(-1);
  });

  it('an empty chain never claims', () => {
    expect(PickClaimant([], 20, 20, true)).toBe(-1);
  });
});
