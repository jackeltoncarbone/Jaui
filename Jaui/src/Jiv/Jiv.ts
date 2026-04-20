import type { JivStyle, JivRenderStyle } from './Jiv.Types';
import { ResolveStyle, SEED_CONTEXT } from '../Core/Style.Resolver';
import { DefaultJivStyle } from './Jiv.Defaults';
import type { LayoutConfig, ChildLayout, Overflow } from '../Layout/Layout.Types';
import type { TextStyle } from '../Text/Text.Types';
import type { SpringConfig } from '../Animation/Animation.Types';
import { Element, type CursorStyle } from '../Element/Element';

/**
 * Jiv — a visual panel element. Extends Element with material, style,
 * interaction states, and a spring-animated RenderStyle.
 *
 * Jiv is to Element as HTMLDivElement is to HTMLElement. The tree structure,
 * layout config, scroll state, and text content live on Element. Jiv adds
 * the visual layer: glass materials, borders, shadows, specular, refraction.
 */
export class Jiv extends Element {

  // ── Visual Style ──

  /** Authorable style — the renderer does NOT read this directly; it reads
   *  `RenderStyle`, which the style animator springs toward EffectiveStyle
   *  (base + active state overrides) every frame. */
  Style: JivStyle;

  /** Spring-animated copy of Style/EffectiveStyle. What the renderer
   *  actually consumes. Starts resolved from Style under a seed context. */
  RenderStyle: JivRenderStyle;

  // ── Interaction states ──

  Hover: boolean = false;
  Active: boolean = false;
  Focus: boolean = false;
  Disabled: boolean = false;
  HoverStyle: Partial<JivStyle> | null = null;
  ActiveStyle: Partial<JivStyle> | null = null;
  FocusStyle: Partial<JivStyle> | null = null;
  DisabledStyle: Partial<JivStyle> | null = null;

  /** Optional style override for text selection highlights. */
  TextSelectionStyle: Partial<JivStyle> | null = null;

  /** Per-property spring overrides. Author via `@Spring Property { ... }`
   *  or `@Transition Property { ... }` in JSS. The style animator looks
   *  up by property name when building per-channel springs; missing
   *  properties use the global default. */
  Springs: Record<string, Partial<SpringConfig>> | null = null;

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
    Springs?: Record<string, Partial<SpringConfig>>;
    SnapLayout?: boolean;
    Layout?: Partial<LayoutConfig>;
    ChildLayout?: Partial<ChildLayout>;
    Text?: string;
    TextStyle?: Partial<TextStyle>;
    Visible?: boolean;
    Overflow?: Overflow;
    Interactive?: boolean;
    PointerEvents?: 'Auto' | 'None';
    Cursor?: CursorStyle;
    UserSelect?: 'Auto' | 'None';
  }) {
    const mergedStyle: JivStyle = { ...DefaultJivStyle, ...options?.Style };

    super({
      X: options?.X,
      Y: options?.Y,
      Width: options?.Width,
      Height: options?.Height,
      SnapLayout: options?.SnapLayout,
      Layout: options?.Layout,
      ChildLayout: options?.ChildLayout,
      Text: options?.Text,
      TextStyle: options?.TextStyle,
      PointScale: mergedStyle.PointScale,
      Visible: options?.Visible,
      Overflow: options?.Overflow,
      Interactive: options?.Interactive,
      PointerEvents: options?.PointerEvents,
      Cursor: options?.Cursor,
      UserSelect: options?.UserSelect,
    });

    this.Style = mergedStyle;
    this.RenderStyle = ResolveStyle(this.Style, SEED_CONTEXT);

    this.HoverStyle = options?.HoverStyle ?? null;
    this.ActiveStyle = options?.ActiveStyle ?? null;
    this.FocusStyle = options?.FocusStyle ?? null;
    this.DisabledStyle = options?.DisabledStyle ?? null;
    this.TextSelectionStyle = options?.TextSelectionStyle ?? null;
    this.Springs = options?.Springs ?? null;
  }

  /** Final render-time style: base + state overrides in priority order.
   *  Disabled beats Focus beats Active beats Hover. */
  EffectiveStyle = (): JivStyle => {
    if (!this.Hover && !this.Active && !this.Focus && !this.Disabled) return this.Style;
    const merged: JivStyle = { ...this.Style };
    if (this.Hover && this.HoverStyle) Object.assign(merged, this.HoverStyle);
    if (this.Active && this.ActiveStyle) Object.assign(merged, this.ActiveStyle);
    if (this.Focus && this.FocusStyle) Object.assign(merged, this.FocusStyle);
    if (this.Disabled && this.DisabledStyle) Object.assign(merged, this.DisabledStyle);
    return merged;
  };
}
