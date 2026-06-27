import type { Jiv } from '../../Jiv/Jiv';

/** Live semantic state for one node — projected out to the DOM mirror and
 *  consumed by focus-ring rendering. Phase 0: stub with only what InputRouter
 *  and FocusManager need. Phase 3 adds aria-expanded/selected/checked/etc. */
export interface AccessibilityNode {
  Jiv: Jiv;
  Role: string | null;
  Label: string | null;
  /** Layout rect in canvas-space CSS px — populated after layout each frame. */
  X: number;
  Y: number;
  Width: number;
  Height: number;
}

/** Canonical semantic layer — single source of truth shared by the canvas
 *  (visual projection) and the DOM mirror (AT/focus projection).
 *
 *  Phase 0: registration/lookup only. Phase 3 adds live ARIA state projection
 *  to the DOM mirror nodes. */
export class AccessibilityTree {
  private _nodes = new Map<Jiv, AccessibilityNode>();

  Register = (jiv: Jiv, role: string | null, label: string | null): AccessibilityNode => {
    let node = this._nodes.get(jiv);
    if (!node) {
      node = { Jiv: jiv, Role: role, Label: label, X: 0, Y: 0, Width: 0, Height: 0 };
      this._nodes.set(jiv, node);
    } else {
      node.Role = role;
      node.Label = label;
    }
    return node;
  };

  Unregister = (jiv: Jiv): void => {
    this._nodes.delete(jiv);
  };

  Get = (jiv: Jiv): AccessibilityNode | undefined => this._nodes.get(jiv);
}
