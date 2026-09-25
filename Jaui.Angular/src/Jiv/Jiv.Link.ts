/**
 * Where a canvas tap on `from` goes: the nearest `href` on it or an ancestor host, the way a tap on
 * anything inside an `<a>` follows the anchor. The engine hits the topmost node, which on a card is its
 * art or its words rather than the card that declares the link.
 */
export const LinkTarget = (
  from: Element | null,
  hrefOf: (host: Element) => string | null | undefined,
): string | null => {
  for (let at = from; at; at = at.parentElement) {
    const href = hrefOf(at);
    if (href) return href;
  }
  return null;
};
