import { describe, it, expect } from 'vitest';
import { LeftChain } from '@jaui/Core/Pointer.Leave';

interface Node { readonly Name: string; readonly Parent: Node | null }
const node = (name: string, parent: Node | null): Node => ({ Name: name, Parent: parent });
const names = (nodes: readonly Node[]): string[] => nodes.map((n) => n.Name);

// The drill field's hovered squad (Drill Sentences lane TT2, item 1, a round 23 blind desktop tester: 8a stayed ringed and
// tagged as hovered after a join, until an undo). The mouse went from 8a straight onto the selection bar standing over the
// field, the field never saw another move of its own, and its `(pointerleave)` never fired, so its hover stayed.
describe('LeftChain: the nodes a pointer leaves, the DOM\'s pointerleave set', () => {
  const root = node('Root', null);
  const workspace = node('Workspace', root);
  const field = node('FieldHit', workspace);
  const bar = node('SelectionBar', workspace);
  const button = node('MoveTogether', bar);

  it('onto chrome standing over a sibling: the sibling is left, the ancestors they share are not', () => {
    expect(names(LeftChain(button, field))).toEqual(['FieldHit']);
  });

  it('from a child back onto its parent: the child alone is left', () => {
    expect(names(LeftChain(bar, button))).toEqual(['MoveTogether']);
  });

  it('off the canvas: the whole chain is left, deepest first', () => {
    expect(names(LeftChain(null, button))).toEqual(['MoveTogether', 'SelectionBar', 'Workspace', 'Root']);
  });

  it('onto a child, or with nothing hovered before, nothing is left', () => {
    expect(LeftChain(button, bar)).toEqual([]);
    expect(LeftChain(field, null)).toEqual([]);
  });
});
