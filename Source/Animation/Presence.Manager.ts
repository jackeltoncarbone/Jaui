/**
 * PresenceManager — ticks every Element's Presence spring each frame, and
 * hard-removes leaving elements from their parents once their spring settles
 * at 0. See Presence.md for the full contract.
 *
 * Walks the root's subtree on each tick. Presence is a per-Element concept,
 * not a per-feature animator, so one manager covers the whole scene graph
 * without per-node registration ceremony.
 */

import type { Element } from '../Element/Element';
import type { Animatable } from './Animation.Manager';

export class PresenceManager implements Animatable {
  private _root: Element;
  /** Collected during the walk; applied after so we don't mutate the tree
   *  mid-traversal. */
  private _toRemove: Element[] = [];

  constructor(root: Element) {
    this._root = root;
  }

  Tick = (dt: number): boolean => {
    this._toRemove.length = 0;
    const anyActive = this._tickNode(this._root, dt);
    for (const node of this._toRemove) {
      const parent = node.Parent;
      if (parent) parent.RemoveChild(node);
    }
    return anyActive;
  };

  private _tickNode = (node: Element, dt: number): boolean => {
    let anyActive = false;
    const spring = node.PresenceSpring;
    if (!spring.IsSettled) {
      const moved = spring.Step(dt);
      if (moved) anyActive = true;
    }
    // Settled + leaving = time to hard-remove. Only after the spring has
    // actually reached 0 (not just been asked to); prevents ripping out a
    // node whose leave target was flipped back to 1 mid-flight.
    if (node.LeaveRequested && spring.IsSettled && spring.Target === 0) {
      this._toRemove.push(node);
    }
    for (const child of node.Children) {
      if (this._tickNode(child, dt)) anyActive = true;
    }
    return anyActive;
  };
}
