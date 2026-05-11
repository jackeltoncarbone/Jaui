import type { JivStyle, JivRenderStyle } from './Jiv.Types';
import { ResolveStyle, SEED_CONTEXT } from '../Core/Style.Resolver';
import { DefaultJivStyle } from './Jiv.Defaults';
import type { LayoutConfig, ChildLayout, Overflow } from '../Layout/Layout.Types';
import type { TextStyle } from '../Text/Text.Types';
import type { SpringConfig, AnimationApplication, AnimationDefinition } from '../Animation/Animation.Types';
import { Element, type CursorStyle } from '../Element/Element';
import { DirtyFlag } from '../Core/Types';

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

  // Backing fields for state flags — public Hover/Active/Focus/Disabled are
  // accessor properties below so the engine can mark text dirty when a state
  // toggles AND that state has a *TextStyle override (otherwise the
  // renderer would never re-measure / re-paint the text in its hover style).
  private _hover: boolean = false;
  private _active: boolean = false;
  private _focus: boolean = false;
  private _disabled: boolean = false;

  HoverStyle: Partial<JivStyle> | null = null;
  ActiveStyle: Partial<JivStyle> | null = null;
  FocusStyle: Partial<JivStyle> | null = null;
  DisabledStyle: Partial<JivStyle> | null = null;
  /** Text-level state overrides — `Foo:Hover { Color: red }` lands here.
   *  Layered on top of the base TextStyle by `EffectiveTextStyle()` when
   *  the matching state flag is set. */
  HoverTextStyle: Partial<TextStyle> | null = null;
  ActiveTextStyle: Partial<TextStyle> | null = null;
  FocusTextStyle: Partial<TextStyle> | null = null;
  DisabledTextStyle: Partial<TextStyle> | null = null;

  get Hover(): boolean { return this._hover; }
  set Hover(v: boolean) {
    if (this._hover === v) return;
    this._hover = v;
    if (this.HoverTextStyle) this._invalidateText();
  }
  get Active(): boolean { return this._active; }
  set Active(v: boolean) {
    if (this._active === v) return;
    this._active = v;
    if (this.ActiveTextStyle) this._invalidateText();
  }
  get Focus(): boolean { return this._focus; }
  set Focus(v: boolean) {
    if (this._focus === v) return;
    this._focus = v;
    if (this.FocusTextStyle) this._invalidateText();
  }
  get Disabled(): boolean { return this._disabled; }
  set Disabled(v: boolean) {
    if (this._disabled === v) return;
    this._disabled = v;
    if (this.DisabledTextStyle) this._invalidateText();
  }

  // Text-only invalidation — pushes a re-measure / re-paint without forcing
  // a layout pass when the new TextStyle would only change Color or other
  // non-metric props. The dirty-text flag flips on; the next frame's render
  // pipeline calls EffectiveTextStyle() and rebuilds glyphs. We also bubble
  // a Layout dirty mark to the parent because line breaks/heights might
  // change when a font-metric prop is in the override (FontSize/Family/etc.).
  private _invalidateText = (): void => {
    this.Dirty |= DirtyFlag.Text;
    this.MarkLayoutDirty();
  };

  /** Optional style override for text selection highlights. */
  TextSelectionStyle: Partial<JivStyle> | null = null;

  /** Per-property spring overrides. Author via `@Spring Property { ... }`
   *  or `@Transition Property { ... }` in JSS. The style animator looks
   *  up by property name when building per-channel springs; missing
   *  properties use the global default. */
  Springs: Record<string, Partial<SpringConfig>> | null = null;

  /** Animations applied to this Jiv (authored via `@Animation Name` or
   *  `@Animation Property { From, To, ... }` in JSS). The style animator
   *  reads this list to override the per-frame property targets via the
   *  driver. Source-order preserved so the cascade applies last-wins.
   *  Named applications are resolved against `AnimationTable` at attach
   *  time; missing names throw. */
  Animations: AnimationApplication[] | null = null;

  /** Stylesheet-wide animation definitions table, used to resolve named
   *  `@Animation Pulse` applications. Wired in by JssRegistry when the
   *  Jiv is constructed from a JSS class. Inline anonymous animations
   *  carry their definition directly and don't consult this map. */
  AnimationTable: Record<string, AnimationDefinition> | null = null;

  /** Back-ref to the per-Jiv style animator once registered with the
   *  canvas. The worker registry consults this from the class-swap path
   *  (`_applyOpts`) so animation set changes propagate without going
   *  through Canvas. Typed loosely to avoid a circular import between
   *  Jiv.ts and Jiv.StyleAnimator.ts; the animator sets itself here in
   *  its constructor. */
  StyleAnimator: {
    ReapplyAnimations: (apps: AnimationApplication[] | null, table: Record<string, AnimationDefinition> | null) => void;
    RetuneSprings: (overrides: Record<string, Partial<SpringConfig>> | null) => void;
    readonly HasAnimations: boolean;
  } | null = null;

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
    HoverTextStyle?: Partial<TextStyle>;
    ActiveTextStyle?: Partial<TextStyle>;
    FocusTextStyle?: Partial<TextStyle>;
    DisabledTextStyle?: Partial<TextStyle>;
    TextSelectionStyle?: Partial<JivStyle>;
    Springs?: Record<string, Partial<SpringConfig>>;
    Animations?: AnimationApplication[];
    AnimationTable?: Record<string, AnimationDefinition>;
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
    this.HoverTextStyle = options?.HoverTextStyle ?? null;
    this.ActiveTextStyle = options?.ActiveTextStyle ?? null;
    this.FocusTextStyle = options?.FocusTextStyle ?? null;
    this.DisabledTextStyle = options?.DisabledTextStyle ?? null;
    this.TextSelectionStyle = options?.TextSelectionStyle ?? null;
    this.Springs = options?.Springs ?? null;
    this.Animations = options?.Animations ?? null;
    this.AnimationTable = options?.AnimationTable ?? null;
  }

  /** Final render-time style: base + state overrides in priority order.
   *  Disabled beats Focus beats Active beats Hover. */
  EffectiveStyle = (): JivStyle => {
    if (!this._hover && !this._active && !this._focus && !this._disabled) return this.Style;
    const merged: JivStyle = { ...this.Style };
    if (this._hover && this.HoverStyle) Object.assign(merged, this.HoverStyle);
    if (this._active && this.ActiveStyle) Object.assign(merged, this.ActiveStyle);
    if (this._focus && this.FocusStyle) Object.assign(merged, this.FocusStyle);
    if (this._disabled && this.DisabledStyle) Object.assign(merged, this.DisabledStyle);
    return merged;
  };

  /** Text-style counterpart to EffectiveStyle. Layout / render call sites
   *  read this instead of `node.TextStyle` directly so JSS `Foo:Hover {
   *  Color: red }` actually paints — the parser routes Color into
   *  HoverTextStyle and we layer it here when the matching state is set.
   *  Same priority order: Disabled > Focus > Active > Hover. */
  override EffectiveTextStyle = (): TextStyle => {
    if (!this._hover && !this._active && !this._focus && !this._disabled) return this.TextStyle;
    const merged: TextStyle = { ...this.TextStyle };
    if (this._hover && this.HoverTextStyle) Object.assign(merged, this.HoverTextStyle);
    if (this._active && this.ActiveTextStyle) Object.assign(merged, this.ActiveTextStyle);
    if (this._focus && this.FocusTextStyle) Object.assign(merged, this.FocusTextStyle);
    if (this._disabled && this.DisabledTextStyle) Object.assign(merged, this.DisabledTextStyle);
    return merged;
  };
}
