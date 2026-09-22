import { describe, it, expect } from 'vitest';
import { ScrollManager } from '../src/Scroll/Scroll.Manager';
import type { Jiv } from '../src/Jiv/Jiv';

/**
 * A LATER SIBLING'S EMPTY BOX TAKES THE PRESS, AND `PointerEvents: None` IS HOW IT GIVES IT BACK.
 *
 * This is the rule that made Show Studio's home hero pager a dead control, and it is not a defect in the
 * hit test — it is the hit test agreeing with paint. A hero whose faded foot carries a NEGATIVE bottom
 * margin hands the bottom of its own box to the section after it; that section's border box therefore
 * starts above the hero's pager, its first 40pt is padding, and it paints nothing there. But `_hitTopmost`
 * is BOX-BASED, not alpha-based, and at the same Layer it walks insertion order REVERSED so the later
 * sibling is tested first — exactly matching paint, where the later sibling lands on top. So the press
 * went to a band that draws nothing and handles nothing.
 *
 * The web has the same arrangement and the same answer: `pointer-events: none`. What is pinned here is
 * that Jaui's answer behaves the way an author expects it to:
 *
 *   1. without it, the overlapping band wins (so the geometry below really is the defect, not a story);
 *   2. with it, the walk CONTINUES to the earlier sibling and reaches the control underneath;
 *   3. with it, the band's own CHILDREN are untouched — the node is descended through, not skipped;
 *   4. a press on the band over nothing at all falls through to what is behind it, so scroll-target
 *      resolution (`ResolveScrollTarget` walks UP from the hit) still finds the page's scroller.
 *
 * The numbers are the ones measured off the live page — a 1599 x 731 faded hero, the band's box starting
 * at 572 — so a reader can check the arrangement against the screen it came from.
 */

type Box = [x: number, y: number, w: number, h: number];

interface Spec {
  Name: string;
  Box: Box;
  Layer?: number;
  PointerEvents?: 'Auto' | 'None';
  Clips?: boolean;
  Kids?: Spec[];
}

const build = (spec: Spec): Jiv => {
  const [X, Y, Width, Height] = spec.Box;
  const node = {
    X, Y, Width, Height,
    Name: spec.Name,
    Visible: true,
    Overflow: 'Visible',
    ClipsChildren: spec.Clips ?? false,
    ScrollX: 0, ScrollY: 0,
    PointerEvents: spec.PointerEvents ?? 'Auto',
    ChildLayout: { Position: 'Flow' },
    RenderStyle: { Transform: { Rotation: 0, OriginX: 0.5, OriginY: 0.5 }, Layer: spec.Layer ?? 0 },
    Children: (spec.Kids ?? []).map(build),
    Parent: null,
  } as unknown as Jiv;
  for (const kid of node.Children as Jiv[]) (kid as unknown as { Parent: Jiv }).Parent = node;
  return node;
};

const nameOf = (n: Jiv | null): string => (n as unknown as { Name?: string } | null)?.Name ?? 'null';

/** The hero's body as it lays out under each pager, and the band that overlaps its foot. `band` is the
 *  only variable. The pager's boxes are the live ones: control 538-609, glass pill 558-588, track
 *  570.5-575.5 with the fill running to 60.8% of it; the dot row 561-609 with its dots on 581-588. */
const pagerBody = (pager: Spec[]): Spec => ({
  Name: 'HeroBody', Box: [0, 282, 1599, 448], Layer: 2,
  Kids: [{ Name: 'HeroPill', Box: [710, 490, 180, 48] }, ...pager],
});

const TIMELINE: Spec[] = [{
  Name: 'HeroTimeline', Box: [590, 538, 420, 71],
  Kids: [{
    Name: 'HeroTimelinePill', Box: [590, 558, 420, 30],
    Kids: [{
      Name: 'HeroTimelineTrack', Box: [710, 570.5, 286, 5], Clips: true,
      Kids: [{ Name: 'HeroTimelineFill', Box: [710, 570.5, 174, 5] }],
    }],
  }],
}];

const DOTS: Spec[] = [{
  Name: 'HeroDots', Box: [590, 561, 420, 48],
  Kids: [{ Name: 'HeroDotOn', Box: [796, 581, 20, 7] }],
}];

const page = (pager: Spec[], bandPointerEvents: 'Auto' | 'None') => {
  const root = build({
    Name: 'Root', Box: [0, 0, 1599, 1472],
    Kids: [{
      Name: 'Column', Box: [0, 0, 1599, 1472],
      Kids: [
        {
          Name: 'HeroFaded', Box: [0, 0, 1599, 731], Clips: true,
          Kids: [{ Name: 'HeroShade', Box: [0, 0, 1599, 731], Layer: 1 }, pagerBody(pager)],
        },
        {
          Name: 'Section', Box: [0, 572, 1599, 900], PointerEvents: bandPointerEvents,
          Kids: [{ Name: 'SectionHead', Box: [20, 612, 1559, 32] }],
        },
      ],
    }],
  });
  const manager = new ScrollManager(root);
  return (x: number, y: number): string => nameOf(manager.HitTopmost(x, y));
};

describe('an overlapping later sibling swallows the press', () => {
  it('the press on the bar reaches the empty band, not the bar', () => {
    // 573 is where the defect was measured: 1pt inside the band, on the visible 5pt track.
    expect(page(TIMELINE, 'Auto')(716, 573)).toBe('Section');
  });

  it('every dot of the dot pager is inside the band, so that pager is dead outright', () => {
    const at = page(DOTS, 'Auto');
    for (const y of [581, 584, 587]) expect(at(806, y), `dot at y=${y}`).toBe('Section');
  });

  it("the hero's own action pill sits above the band and was never affected", () => {
    // This is the fact that splits the diagnosis: one Interactive control in the same parent still works.
    expect(page(TIMELINE, 'Auto')(800, 514)).toBe('HeroPill');
    expect(page(TIMELINE, 'None')(800, 514)).toBe('HeroPill');
  });
});

describe('PointerEvents: None hands the press back', () => {
  it('the same press now reaches the deepest node of the bar', () => {
    expect(page(TIMELINE, 'None')(716, 573)).toBe('HeroTimelineFill');
  });

  it('the whole control is reachable at every depth, including inside the band', () => {
    const at = page(TIMELINE, 'None');
    // The glass pill beside the track, 8pt deep into the band.
    expect(at(600, 580)).toBe('HeroTimelinePill');
    // The track past the fill's right edge, on the same line as the measured press.
    expect(at(960, 573)).toBe('HeroTimelineTrack');
    // The control's own bottom padding, 32pt deep into the band — the part that was most dead.
    expect(at(716, 604)).toBe('HeroTimeline');
    // And its top padding, which never was.
    expect(at(716, 545)).toBe('HeroTimeline');
  });

  it('every dot of the dot pager is reachable', () => {
    const at = page(DOTS, 'None');
    for (const y of [581, 584, 587]) expect(at(806, y), `dot at y=${y}`).toBe('HeroDotOn');
  });

  it("the band's own children keep their press: it is descended through, not skipped", () => {
    expect(page(TIMELINE, 'None')(700, 620)).toBe('SectionHead');
  });

  it('a press on the band over nothing at all falls through to what is behind it', () => {
    // Past the hero's box entirely: the column behind, which is what resolves the scroll target.
    expect(page(TIMELINE, 'None')(700, 1200)).toBe('Column');
  });
});
