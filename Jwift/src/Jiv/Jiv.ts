import type { JivStyle, JivRenderStyle, ProgressiveBlurConfig } from './Jiv.Types';
import type { ResolveContext } from '../Core/Length';
import { ResolveStyle, SEED_CONTEXT } from '../Core/Style.Resolver';
import { DefaultJivStyle } from './Jiv.Defaults';
import type { LayoutConfig, ChildLayout } from '../Layout/Layout.Types';
import { DefaultLayoutConfig, DefaultChildLayout } from '../Layout/Layout.Types';
import type { TextStyle, TextMeasurement } from '../Text/Text.Types';
import { DefaultTextStyle } from '../Text/Text.Types';
import { DirtyFlag, type DirtyFlags } from '../Core/Types';

export class Jiv {
  // Computed layout position (set by layout solver or manually)
  X: number = 0;
  Y: number = 0;
  Width: number = 0;
  Height: number = 0;

  // Tree
  Parent: Jiv | null = null;
  Children: Jiv[] = [];

  // Style — user's declarative base. The renderer does NOT read this directly;
  // it reads `RenderStyle`, which the style animator springs toward the
  // EffectiveStyle (base + active state overrides) every frame. Mutating
  // Style triggers the springs naturally.
  Style: JivStyle;

  // RenderStyle — what the renderer actually consumes. Spring-animated copy
  // of Style/EffectiveStyle. Starts equal to Style (no entry animation), then
  // JivStyleAnimator drives it toward EffectiveStyle on every tick.
  RenderStyle: JivRenderStyle;

  // Layout — container config (how this node lays out its children)
  Layout: LayoutConfig;

  // Layout — child config (how this node behaves as a child of its parent)
  ChildLayout: ChildLayout;

  // Text content (optional)
  Text: string | null = null;
  TextStyle: TextStyle;
  TextMeasurement: TextMeasurement | null = null;

  // Intrinsic sizing (from text measurement or other content sources)
  IntrinsicWidth: number | null = null;
  IntrinsicHeight: number | null = null;

  // Scroll state — only meaningful when Style.Overflow === 'Scroll'.
  // ScrollX/Y are the *current* scroll offset (CSS px) applied to descendants.
  // ScrollTargetX/Y are what the scroll spring is animating toward.
  // ContentWidth/Height are the bounds of the children, computed during render
  // collection so we can clamp scroll to [0, content - viewport].
  ScrollX: number = 0;
  ScrollY: number = 0;
  ScrollTargetX: number = 0;
  ScrollTargetY: number = 0;
  ContentWidth: number = 0;
  ContentHeight: number = 0;

  // Interaction states — set by Canvas input system based on pointer + focus.
  // Each state has an optional style override; EffectiveStyle() merges them
  // in priority order so the renderer always sees the correct final style.
  Hover: boolean = false;
  Active: boolean = false;
  Focus: boolean = false;
  Disabled: boolean = false;
  HoverStyle: Partial<JivStyle> | null = null;
  ActiveStyle: Partial<JivStyle> | null = null;
  FocusStyle: Partial<JivStyle> | null = null;
  DisabledStyle: Partial<JivStyle> | null = null;

  /** Optional style override for text selection highlights. When null, the
   *  selection manager uses its iOS-like translucent-blue default. Only
   *  meaningful on text-bearing Jivs. */
  TextSelectionStyle: Partial<JivStyle> | null = null;

  /** Sidecar config for Material: 'ProgressiveBlur'. Null otherwise. Lives
   *  off JivStyle because it's meaningful to exactly one material and would
   *  otherwise force the core resolver/animator to carry dead fields. */
  ProgressiveBlur: ProgressiveBlurConfig | null = null;

  /** Resolved Length context, populated top-down during layout. Holds this
   *  Jiv's resolved PointScale + the parent dims/viewport needed to turn
   *  any Length field (%, pt, rpt, vw/vh, arithmetic) into pixels.
   *  Null until the first layout pass has run for this Jiv. */
  ResolveCtx: ResolveContext | null = null;

  /** When true, the layout solver snaps this Jiv's X/Y/Width/Height to the
   *  solver result instead of spring-chasing them. Used for Jivs whose
   *  position is driven imperatively on every frame (e.g. text-selection
   *  highlights following a drag) — spring lag looks like the highlight is
   *  trailing the cursor. Default false: the framework's "everything
   *  animates" posture wins unless a feature opts out. */
  SnapLayout: boolean = false;

  // Dirty tracking
  Dirty: DirtyFlags = DirtyFlag.Layout;

  constructor(options?: {
    X?: number;
    Y?: number;
    Width?: number;
    Height?: number;
    Style?: Partial<JivStyle>;
    HoverStyle?: Partial<JivStyle>;
    ActiveStyle?: Partial<JivStyle>;
    FocusStyle?: Partial<JivStyle>;
    DisabledStyle?: Partial<JivStyle>;
    TextSelectionStyle?: Partial<JivStyle>;
    ProgressiveBlur?: ProgressiveBlurConfig;
    SnapLayout?: boolean;
    Layout?: Partial<LayoutConfig>;
    ChildLayout?: Partial<ChildLayout>;
    Text?: string;
    TextStyle?: Partial<TextStyle>;
  }) {
    this.X = options?.X ?? 0;
    this.Y = options?.Y ?? 0;
    this.Width = options?.Width ?? 0;
    this.Height = options?.Height ?? 0;

    // Every field on Style is a string (or enum/boolean) — no nested objects
    // to deep-copy, shallow merge is enough.
    this.Style = { ...DefaultJivStyle, ...options?.Style };

    // RenderStyle starts as a fully-resolved numeric snapshot of Style under
    // a seed context. The style animator overwrites on first layout with the
    // real ResolveCtx; this initial pass just gives frame-0 reasonable values.
    this.RenderStyle = ResolveStyle(this.Style, SEED_CONTEXT);

    // Layout config — shallow merge, everything is string/enum/null.
    this.Layout = { ...DefaultLayoutConfig, ...options?.Layout };

    // Child layout — shallow merge + deep-copy the one remaining nested
    // objects (AttachTargetAnchor/SelfAnchor are { X, Y } and are shared-by-
    // reference from the default otherwise).
    this.ChildLayout = { ...DefaultChildLayout, ...options?.ChildLayout };
    this.ChildLayout.AttachTargetAnchor = { ...(options?.ChildLayout?.AttachTargetAnchor ?? DefaultChildLayout.AttachTargetAnchor) };
    this.ChildLayout.AttachSelfAnchor = { ...(options?.ChildLayout?.AttachSelfAnchor ?? DefaultChildLayout.AttachSelfAnchor) };

    // Text
    this.TextStyle = { ...DefaultTextStyle, ...options?.TextStyle };
    if (options?.Text !== undefined) {
      this.Text = options.Text;
      this.Dirty |= DirtyFlag.Text;
    }

    // Interaction state overrides (stored as-is; caller's responsibility to
    // deep-copy if they want isolation — these are typically stylesheet objects)
    this.HoverStyle = options?.HoverStyle ?? null;
    this.ActiveStyle = options?.ActiveStyle ?? null;
    this.FocusStyle = options?.FocusStyle ?? null;
    this.DisabledStyle = options?.DisabledStyle ?? null;
    this.TextSelectionStyle = options?.TextSelectionStyle ?? null;
    this.ProgressiveBlur = options?.ProgressiveBlur ?? null;
    this.SnapLayout = options?.SnapLayout ?? false;
  }

  /** Final render-time style: base + state overrides in priority order.
   *  Disabled beats Focus beats Active beats Hover — a disabled focused
   *  active hover all stacked yields the disabled look. Cheap shortcut
   *  when no state is active (returns base reference directly). */
  EffectiveStyle = (): JivStyle => {
    if (!this.Hover && !this.Active && !this.Focus && !this.Disabled) return this.Style;
    const merged: JivStyle = { ...this.Style };
    if (this.Hover && this.HoverStyle) Object.assign(merged, this.HoverStyle);
    if (this.Active && this.ActiveStyle) Object.assign(merged, this.ActiveStyle);
    if (this.Focus && this.FocusStyle) Object.assign(merged, this.FocusStyle);
    if (this.Disabled && this.DisabledStyle) Object.assign(merged, this.DisabledStyle);
    return merged;
  };

  AddChild = (child: Jiv): void => {
    if (child.Parent) child.Parent.RemoveChild(child);
    child.Parent = this;
    this.Children.push(child);
    this.Dirty |= DirtyFlag.Layout | DirtyFlag.Children;
  };

  RemoveChild = (child: Jiv): void => {
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
    this.Text = text;
    if (style) Object.assign(this.TextStyle, style);
    this.Dirty |= DirtyFlag.Text | DirtyFlag.Layout;
    if (this.Parent) this.Parent.Dirty |= DirtyFlag.Layout;
  };
}

