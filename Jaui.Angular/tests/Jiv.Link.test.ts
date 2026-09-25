import { describe, expect, it } from 'vitest';
import { LinkTarget } from '../src/Jiv/Jiv.Link';

// A card declares its href on the root and is covered by its art, its words and its pill, so the
// engine's topmost hit is never the card itself.
const card = (): { root: Element; art: Element; pillText: Element; hrefs: Map<Element, string> } => {
  const root = document.createElement('jiv');
  const art = document.createElement('jiv');
  const foot = document.createElement('jiv');
  const pill = document.createElement('jiv');
  const pillText = document.createElement('jext');
  pill.appendChild(pillText);
  foot.appendChild(pill);
  root.append(art, foot);
  return { root, art, pillText, hrefs: new Map([[root, '/show/spring-show']]) };
};

describe('LinkTarget', () => {
  it('follows the card href from a tap on its art', () => {
    const { art, hrefs } = card();
    expect(LinkTarget(art, (h) => hrefs.get(h))).toBe('/show/spring-show');
  });

  it('follows the card href from a tap on the price pill text', () => {
    const { pillText, hrefs } = card();
    expect(LinkTarget(pillText, (h) => hrefs.get(h))).toBe('/show/spring-show');
  });

  it('follows the card href from a jext title and from inside a wrapper component such as an icon', () => {
    const { root, hrefs } = card();
    const title = document.createElement('jext');
    const icon = document.createElement('icon');
    const glyph = document.createElement('jext');
    icon.appendChild(glyph);
    root.lastElementChild!.append(title, icon);
    expect(LinkTarget(title, (h) => hrefs.get(h))).toBe('/show/spring-show');
    expect(LinkTarget(glyph, (h) => hrefs.get(h))).toBe('/show/spring-show');
  });

  it('prefers the nearest href, as a nested anchor does', () => {
    const { root, pillText, hrefs } = card();
    hrefs.set(pillText.parentElement!, '/checkout');
    expect(LinkTarget(pillText, (h) => hrefs.get(h))).toBe('/checkout');
    expect(LinkTarget(root, (h) => hrefs.get(h))).toBe('/show/spring-show');
  });

  it('goes nowhere outside any link', () => {
    const lone = document.createElement('jiv');
    expect(LinkTarget(lone, () => null)).toBeNull();
    expect(LinkTarget(null, () => '/x')).toBeNull();
  });
});
