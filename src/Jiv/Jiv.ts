import type { JivStyle } from './Jiv.Types';
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

  // Style — deep copy so mutations are local
  Style: JivStyle;

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
    Layout?: Partial<LayoutConfig>;
    ChildLayout?: Partial<ChildLayout>;
    Text?: string;
    TextStyle?: Partial<TextStyle>;
  }) {
    this.X = options?.X ?? 0;
    this.Y = options?.Y ?? 0;
    this.Width = options?.Width ?? 0;
    this.Height = options?.Height ?? 0;
    this.Style = { ...DefaultJivStyle, ...options?.Style };

    // Deep copy nested objects
    if (!options?.Style?.Transform) {
      this.Style.Transform = { ...DefaultJivStyle.Transform };
    }
    this.Style.BorderRadius = options?.Style?.BorderRadius
      ? [...options.Style.BorderRadius]
      : [...DefaultJivStyle.BorderRadius];
    this.Style.CornerShape = options?.Style?.CornerShape
      ? [...options.Style.CornerShape]
      : [...DefaultJivStyle.CornerShape];

    // Layout config — deep copy Padding tuple
    this.Layout = { ...DefaultLayoutConfig, ...options?.Layout };
    this.Layout.Padding = options?.Layout?.Padding
      ? [...options.Layout.Padding]
      : [...DefaultLayoutConfig.Padding];

    // Child layout — deep copy Margin tuple
    this.ChildLayout = { ...DefaultChildLayout, ...options?.ChildLayout };
    this.ChildLayout.Margin = options?.ChildLayout?.Margin
      ? [...options.ChildLayout.Margin]
      : [...DefaultChildLayout.Margin];
    // Deep-copy Attach objects/arrays so mutations don't bleed through the
    // shared default.
    this.ChildLayout.AttachTargetAnchor = { ...(options?.ChildLayout?.AttachTargetAnchor ?? DefaultChildLayout.AttachTargetAnchor) };
    this.ChildLayout.AttachSelfAnchor = { ...(options?.ChildLayout?.AttachSelfAnchor ?? DefaultChildLayout.AttachSelfAnchor) };
    this.ChildLayout.AttachInset = options?.ChildLayout?.AttachInset
      ? [...options.ChildLayout.AttachInset]
      : [...DefaultChildLayout.AttachInset];

    // Text
    this.TextStyle = { ...DefaultTextStyle, ...options?.TextStyle };
    this.TextStyle.Color = options?.TextStyle?.Color
      ? { ...options.TextStyle.Color }
      : { ...DefaultTextStyle.Color };
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
    if (style) {
      Object.assign(this.TextStyle, style);
      if (style.Color) this.TextStyle.Color = { ...style.Color };
    }
    this.Dirty |= DirtyFlag.Text | DirtyFlag.Layout;
    if (this.Parent) this.Parent.Dirty |= DirtyFlag.Layout;
  };
}
