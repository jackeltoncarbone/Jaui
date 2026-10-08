/** A node on a hover chain: the hit itself and every ancestor above it. */
interface ChainNode { readonly Parent: unknown }

/** The nodes the pointer has left as the topmost hit moves from `oldTopmost` to `newTopmost`: every node on the
 *  old hit's chain that is not on the new one, deepest first, the DOM's own `pointerleave` set. Moving onto a
 *  sibling leaves the node and none of the ancestors the two share; leaving the canvas (`newTopmost` null) leaves
 *  the whole chain. */
export const LeftChain = <T extends ChainNode>(newTopmost: T | null, oldTopmost: T | null): T[] => {
  const kept = new Set<T>();
  for (let n: T | null = newTopmost; n; n = n.Parent as T | null) kept.add(n);
  const left: T[] = [];
  for (let n: T | null = oldTopmost; n; n = n.Parent as T | null) if (!kept.has(n)) left.push(n);
  return left;
};
