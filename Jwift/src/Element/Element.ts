/**
 * Element — the base scene graph node.
 *
 * Owns the tree structure (parent, children), layout configuration (flex),
 * computed position, scroll state, intrinsic sizing, dirty tracking, and
 * text content. Has NO visual properties — no style, no material, no
 * rendering. Jiv extends Element to add material/glass/border/shadow.
 *
 * Analogy: Element is to Jiv as HTMLElement is to HTMLDivElement.
 * Future element types (TextElement, ImageElement) will extend Element
 * without carrying glass/material baggage.
 */

import type { LayoutConfig, ChildLayout, Overflow } from '../Layout/Layout.Types';
import { DefaultLayoutConfig, DefaultChildLayout } from '../Layout/Layout.Types';
import type { TextStyle, TextMeasurement } from '../Text/Text.Types';
import { DefaultTextStyle } from '../Text/Text.Types';
import type { ResolveContext } from '../Core/Length';
import { DirtyFlag, type DirtyFlags } from '../Core/Types';

export type CursorStyle = 'Default' | 'Pointer' | 'Text' | 'Move' | 'None';

export interface ElementOptions {
  X?: number;
  Y?: number;
  Width?: number;
  Height?: number;
  SnapLayout?: boolean;
  Layout?: Partial<LayoutConfig>;
  ChildLayout?: Partial<ChildLayout>;
  Text?: string;
  TextStyle?: Partial<TextStyle>;
  /** Cascading base unit for the layout solver. Default '1pt'. */
  PointScale?: string;
  Visible?: boolean;
  Overflow?: Overflow;
  Interactive?: boolean;
  PointerEvents?: 'Auto' | 'None';
  Cursor?: CursorStyle;
  UserSelect?: 'Auto' | 'None';
}

export class Element {
  // ── Computed layout position (set by layout solver or manually) ──
  X: number = 0;
  Y: number = 0;
  Width: number = 0;
  Height: number = 0;

  // ── Tree ──
  Parent: Element | null = null;
  Children: Element[] = [];

  // ── Layout ──

  /** Container config — how this element lays out its children. */
  Layout: LayoutConfig;

  /** Child config — how this element behaves as a child of its parent. */
  ChildLayout: ChildLayout;

  /** Cascading base unit. `1pt` anywhere in this element's subtree resolves
   *  to `N × PointScale`. The layout solver reads this during its top-down
   *  PointScale cascade. Default `'1pt'` — inherit parent. */
  PointScale: string;

  // ── Intrinsic sizing ──
  IntrinsicWidth: number | null = null;
  IntrinsicHeight: number | null = null;

  // ── Scroll state ──
  /** Current scroll offset (CSS px). Only meaningful when Overflow === 'Scroll'. */
  ScrollX: number = 0;
  ScrollY: number = 0;
  /** Target scroll offset — what the scroll spring is animating toward. */
  ScrollTargetX: number = 0;
  ScrollTargetY: number = 0;
  /** Content bounds, computed during render collection. */
  ContentWidth: number = 0;
  ContentHeight: number = 0;

  // ── Text content ──
  /** Optional text content. Drives intrinsic sizing. Will move to a dedicated
   *  TextElement in a future refactor. */
  Text: string | null = null;
  TextStyle: TextStyle;
  TextMeasurement: TextMeasurement | null = null;

  // ── Resolve context ──
  /** Populated top-down during layout. Holds this element's resolved PointScale
   *  + the parent dims/viewport needed to turn Length fields into pixels.
   *  Null until the first layout pass has run. */
  ResolveCtx: ResolveContext | null = null;

  /** When true, the layout solver snaps X/Y/Width/Height to the solver result
   *  instead of spring-chasing them. Used for elements whose position is driven
   *  imperatively on every frame (e.g. text-selection highlights following a
   *  drag). Default false: the framework's "everything animates" posture wins
   *  unless a feature opts out. */
  SnapLayout: boolean = false;

  // ── Appearance / Interaction ──
  /** Whether this element is visible. Hidden elements are skipped by rendering
   *  and hit testing but still participate in layout. */
  Visible: boolean = true;
  Overflow: Overflow = 'Visible';
  Interactive: boolean = false;
  PointerEvents: 'Auto' | 'None' = 'Auto';
  Cursor: CursorStyle = 'Default';
  UserSelect: 'Auto' | 'None' = 'Auto';

  // ── Image ──
  /** Image source key — matches the key used with ImageCache.LoadUrl/LoadSvg.
   *  When set, the renderer draws the cached image texture inside this element. */
  ImageSrc: string | null = null;

  // ── Dirty tracking ──
  Dirty: DirtyFlags = DirtyFlag.Layout;

  constructor(options?: ElementOptions) {
    this.X = options?.X ?? 0;
    this.Y = options?.Y ?? 0;
    this.Width = options?.Width ?? 0;
    this.Height = options?.Height ?? 0;
    this.SnapLayout = options?.SnapLayout ?? false;
    this.PointScale = options?.PointScale ?? '1pt';

    this.Visible = options?.Visible ?? true;
    this.Overflow = options?.Overflow ?? 'Visible';
    this.Interactive = options?.Interactive ?? false;
    this.PointerEvents = options?.PointerEvents ?? 'Auto';
    this.Cursor = options?.Cursor ?? 'Default';
    this.UserSelect = options?.UserSelect ?? 'Auto';

    this.Layout = { ...DefaultLayoutConfig, ...options?.Layout };

    this.ChildLayout = { ...DefaultChildLayout, ...options?.ChildLayout };
    this.ChildLayout.AttachTargetAnchor = { ...(options?.ChildLayout?.AttachTargetAnchor ?? DefaultChildLayout.AttachTargetAnchor) };
    this.ChildLayout.AttachSelfAnchor = { ...(options?.ChildLayout?.AttachSelfAnchor ?? DefaultChildLayout.AttachSelfAnchor) };

    this.TextStyle = { ...DefaultTextStyle, ...options?.TextStyle };
    if (options?.Text !== undefined) {
      this.Text = options.Text;
      this.Dirty |= DirtyFlag.Text;
    }
  }

  AddChild = (child: Element): void => {
    if (child.Parent) child.Parent.RemoveChild(child);
    child.Parent = this;
    this.Children.push(child);
    this.Dirty |= DirtyFlag.Layout | DirtyFlag.Children;
  };

  RemoveChild = (child: Element): void => {
    const idx = this.Children.indexOf(child);
    if (idx >= 0) {
      this.Children.splice(idx, 1);
      child.Parent = null;
      this.Dirty |= DirtyFlag.Layout | DirtyFlag.Children;
    }
  };

  MarkLayoutDirty = (): void => {
    this.Dirty |= DirtyFlag.Layout;
    if (this.Parent) this.Parent.Dirty |= DirtyFlag.Layout;
  };

  SetText = (text: string | null, style?: Partial<TextStyle>): void => {
    let changed = text !== this.Text;
    this.Text = text;
    if (style) {
      const current = this.TextStyle as unknown as Record<string, unknown>;
      const next = style as unknown as Record<string, unknown>;
      for (const key in next) {
        const v = next[key];
        if (v !== undefined && current[key] !== v) {
          current[key] = v;
          changed = true;
        }
      }
    }
    if (!changed) return;
    this.Dirty |= DirtyFlag.Text | DirtyFlag.Layout;
    if (this.Parent) this.Parent.Dirty |= DirtyFlag.Layout;
  };

  /** Force text re-measurement on next tick. Call after something outside
   *  the node changes (e.g. fonts finished loading) that could invalidate
   *  the cached TextMeasurement. */
  InvalidateText = (): void => {
    if (this.Text === null) return;
    this.TextMeasurement = null;
    this.Dirty |= DirtyFlag.Text | DirtyFlag.Layout;
    if (this.Parent) this.Parent.Dirty |= DirtyFlag.Layout;
  };
}
