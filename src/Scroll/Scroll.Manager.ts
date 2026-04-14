import type { Jiv } from '../Jiv/Jiv';
import type { Animatable } from '../Animation/Animation.Manager';
import { Spring } from '../Animation/Spring';

/**
 * Animates the ScrollX/ScrollY of every Jiv with `Style.Overflow === 'Scroll'`.
 * One Spring per axis per scroll Jiv. Walks the tree each tick — cheap because
 * we early-out on settled springs and Overflow is a fast string compare.
 *
 * ScrollX/ScrollY on the Jiv are the spring's *current* value (read by the
 * render-collection passes). ScrollTargetX/Y are the spring target, mutated
 * by wheel/touch handlers.
 */
export class ScrollManager implements Animatable {
  private _springs = new WeakMap<Jiv, { X: Spring; Y: Spring }>();

  constructor(
    private _root: Jiv,
    public Stiffness: number = 220,
    public Damping: number = 32,
  ) {}

  /** Push a delta into a scroll container's target. Wheel handler calls this. */
  ApplyDelta = (jiv: Jiv, dx: number, dy: number): void => {
    const maxX = Math.max(0, jiv.ContentWidth - jiv.Width);
    const maxY = Math.max(0, jiv.ContentHeight - jiv.Height);
    jiv.ScrollTargetX = Math.max(0, Math.min(maxX, jiv.ScrollTargetX + dx));
    jiv.ScrollTargetY = Math.max(0, Math.min(maxY, jiv.ScrollTargetY + dy));
  };

  /** Snap immediately (no animation). Used on resize / programmatic jumps. */
  Snap = (jiv: Jiv): void => {
    jiv.ScrollX = jiv.ScrollTargetX;
    jiv.ScrollY = jiv.ScrollTargetY;
    const s = this._springs.get(jiv);
    if (s) {
      s.X.Value = s.X.Target = jiv.ScrollX;
      s.Y.Value = s.Y.Target = jiv.ScrollY;
      s.X.Velocity = 0;
      s.Y.Velocity = 0;
    }
  };

  /** DOM-style scroll target: find the topmost Jiv at (cssX, cssY) that accepts
   *  pointer events, then walk UP the tree to the nearest scrollable ancestor.
   *  Returns null if no ancestor is scrollable (e.g. pointer is over a floating
   *  tab bar whose ancestors are not scroll containers — the wheel should NOT
   *  fall through to a sibling scroll container behind it). */
  ResolveScrollTarget = (cssX: number, cssY: number): Jiv | null => {
    const hit = this._hitTopmost(this._root, cssX, cssY, 0, 0);
    if (!hit) return null;
    // Walk up (including the hit itself) for the nearest scrollable
    let cur: Jiv | null = hit;
    while (cur) {
      if (cur.Style.Overflow === 'Scroll') return cur;
      cur = cur.Parent;
    }
    return null;
  };


  Tick = (dt: number): boolean => {
    let active = false;
    this._stepWalk(this._root, (jiv) => {
      let s = this._springs.get(jiv);
      if (!s) {
        s = {
          X: new Spring(jiv.ScrollX, this.Stiffness, this.Damping),
          Y: new Spring(jiv.ScrollY, this.Stiffness, this.Damping),
        };
        this._springs.set(jiv, s);
      }
      // Sync targets from public mutable fields
      s.X.Set(jiv.ScrollTargetX);
      s.Y.Set(jiv.ScrollTargetY);

      const ax = s.X.Step(dt);
      const ay = s.Y.Step(dt);
      if (ax) active = true;
      if (ay) active = true;

      jiv.ScrollX = s.X.Value;
      jiv.ScrollY = s.Y.Value;
    });
    return active;
  };

  private _stepWalk = (node: Jiv, fn: (j: Jiv) => void): void => {
    if (node.Style.Overflow === 'Scroll') fn(node);
    for (const c of node.Children) this._stepWalk(c, fn);
  };

  /** Front-to-back topmost hit test. Mirrors render order: children drawn
   *  later (higher in Children array) are ON TOP, so reverse iterate and
   *  return the first hit. Respects PointerEvents: 'None' (skips the node
   *  AND its subtree, like CSS pointer-events: none). */
  private _hitTopmost = (node: Jiv, x: number, y: number, offX: number, offY: number): Jiv | null => {
    if (!node.Style.Visible || node.Style.PointerEvents === 'None') return null;

    const ox = node.X + offX;
    const oy = node.Y + offY;
    const inside = node === this._root
      ? true   // root always covers everything
      : x >= ox && x < ox + node.Width && y >= oy && y < oy + node.Height;

    if (!inside) return null;

    // Descend (reverse = topmost first). A matching child wins over self.
    const dx = node.Style.Overflow === 'Scroll' ? offX - node.ScrollX : offX;
    const dy = node.Style.Overflow === 'Scroll' ? offY - node.ScrollY : offY;
    for (let i = node.Children.length - 1; i >= 0; i--) {
      const hit = this._hitTopmost(node.Children[i], x, y, dx, dy);
      if (hit) return hit;
    }

    // No child hit — this node is the topmost at this point
    return node;
  };
}
