import type { Platform } from '../Platform';
import type { ScrollManager } from '../../Scroll/Scroll.Manager';
import type { FocusManager } from '../Focus/FocusManager';
import type { SelectionManager } from '../../Selection/Selection.Manager';
import type { AnimationManager } from '../../Animation/Animation.Manager';
import type { Jiv } from '../../Jiv/Jiv';

/** Arrow key scroll distance in CSS px — Chrome's kPixelsPerLineStep = 40. */
const LINE_PX = 40;

/** Unified window-level keydown dispatcher. Absorbs selection shortcuts
 *  (Cmd/Ctrl+A, Esc) with no behavior change, and adds scroll-key routing
 *  (Arrow / PageUp/Down / Space / Home / End / Ctrl+Home/End) to the focused
 *  scroller, falling back to the page-level scroll container when nothing
 *  is explicitly focused — matching browser behavior. */
export class InputRouter {
  constructor(
    private readonly _platform: Platform,
    private readonly _scrollManager: ScrollManager,
    private readonly _focusManager: FocusManager,
    private readonly _selectionManager: SelectionManager,
    private readonly _animationManager: AnimationManager,
    private readonly _getRoot: () => Jiv,
  ) {}

  /** Attach the keydown listener; returns a disposer. */
  Listen = (): (() => void) => {
    return this._platform.AddKeydownListener((e: KeyboardEvent) => {
      if (this._platform.IsTextInputFocused()) return;
      this._route(e);
    }, { capture: true });
  };

  private _route = (e: KeyboardEvent): void => {
    const meta = e.ctrlKey || e.metaKey;

    // ── Selection shortcuts ───────────────────────────────────────────────
    if (meta && (e.key === 'a' || e.key === 'A')) {
      const sel = this._selectionManager;
      const root = this._getRoot();
      const first = sel.FirstTextJiv(root);
      const last = sel.LastTextJiv(root);
      if (first && last) {
        const [, lastChar] = sel.FullRange(last);
        sel.Set({ AnchorJiv: first, AnchorChar: 0, ExtentJiv: last, ExtentChar: lastChar }, root);
        this._animationManager.Kick();
        e.preventDefault();
      }
      return;
    }
    if (e.key === 'Escape') {
      if (this._selectionManager.Current) {
        this._selectionManager.Set(null, this._getRoot());
        this._animationManager.Kick();
        e.preventDefault();
      }
      return;
    }

    // ── Scroll keys ───────────────────────────────────────────────────────
    // Shift+Arrow is text-selection extension (Phase 4); don't scroll.
    if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown' ||
                       e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;

    // Ctrl/Cmd+Home/End scroll the root page scroller (browser behavior).
    const scroller = (meta && (e.key === 'Home' || e.key === 'End'))
      ? this._findRootScroller()
      : (this._focusManager.FocusedScroller ?? this._findDefaultScroller());

    if (!scroller) return;

    let dx = 0, dy = 0, handled = true;
    switch (e.key) {
      case 'ArrowDown':  dy = LINE_PX; break;
      case 'ArrowUp':    dy = -LINE_PX; break;
      case 'ArrowRight': dx = LINE_PX; break;
      case 'ArrowLeft':  dx = -LINE_PX; break;
      case 'PageDown':   dy = scroller.Height * 0.875; break;
      case 'PageUp':     dy = -(scroller.Height * 0.875); break;
      case ' ':          dy = e.shiftKey ? -(scroller.Height * 0.875) : scroller.Height * 0.875; break;
      // 1e9 clamps to the scroll bounds inside ApplyDelta.
      case 'Home':       dy = -1e9; break;
      case 'End':        dy = 1e9; break;
      default: handled = false;
    }
    if (!handled || (dx === 0 && dy === 0)) return;

    this._focusManager.SetModality('keyboard');
    // Eased, not instant: the browser animates its line and page steps, and a
    // teleporting Home/End reads as a glitch rather than a jump.
    this._scrollManager.ApplyDelta(scroller, dx, dy);
    this._animationManager.Kick();
    e.preventDefault();
  };

  /** The page-level scroller: first direct Overflow:Scroll child of Root,
   *  falling back to any scrollable in the tree. */
  private _findDefaultScroller = (): Jiv | null => {
    const root = this._getRoot();
    for (const child of root.Children as Jiv[]) {
      if (child.Overflow === 'Scroll') return child;
    }
    return this._findScrollableDfs(root);
  };

  /** Root-level scroller for Ctrl+Home/End — same as default for now;
   *  Phase 2 wires this to the topmost scroll container in the focus tree. */
  private _findRootScroller = (): Jiv | null => {
    return this._findDefaultScroller();
  };

  private _findScrollableDfs = (node: Jiv): Jiv | null => {
    if (node.Overflow === 'Scroll') return node;
    for (const child of node.Children as Jiv[]) {
      const found = this._findScrollableDfs(child);
      if (found) return found;
    }
    return null;
  };
}
