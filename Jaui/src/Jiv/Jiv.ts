import type { JivStyle, JivRenderStyle } from './Jiv.Types';
import { ResolveStyle, SEED_CONTEXT } from '../Core/Style.Resolver';
import { DefaultJivStyle } from './Jiv.Defaults';
import type { LayoutConfig, ChildLayout, Overflow } from '../Layout/Layout.Types';
import type { TextStyle } from '../Text/Text.Types';
import type { SpringConfig, AnimationApplication, AnimationDefinition } from '../Animation/Animation.Types';
import { Element, type CursorStyle } from '../Element/Element';
import { DirtyFlag } from '../Core/Types';
import type { PredicateStyle } from '../Jss/Jss.Parser';
import { EvaluatePredicate } from '../Jss/Jss.Predicate';

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
  private _groupHover: boolean = false;

  HoverStyle: Partial<JivStyle> | null = null;
  ActiveStyle: Partial<JivStyle> | null = null;
  FocusStyle: Partial<JivStyle> | null = null;
  DisabledStyle: Partial<JivStyle> | null = null;
  GroupHoverStyle: Partial<JivStyle> | null = null;

  /** Compound pseudo-predicate rules. Each entry has a JSON-safe Predicate
   *  AST and a Style/TextStyle patch. EffectiveStyle walks the list AFTER
   *  the legacy state slots, evaluating each predicate against the Jiv's
   *  live state set (`_states`) and Object.assigning matching entries' Style
   *  in source order. Last-wins within the tier; predicate rules win over
   *  legacy state rules they share a property with because they merge last.
   *  Populated from JSS `Name:(expr) { ... }` at class-apply time. */
  PredicateStyles: readonly PredicateStyle[] | null = null;

  /** Live state set — the source of truth for predicate evaluation.
   *  Pointer-driven states (Hover, Active, Focus, GroupHover) are kept in
   *  sync by the typed setters below. Disabled mirrors the same pattern.
   *  Custom states (Loading, Recording, anything author-named) are set via
   *  `SetState(name, on)` — Phase 2 framework hook for the Angular
   *  `[disabled]` input and any future state inputs. */
  private readonly _states: Set<string> = new Set();
  /** Text-level state overrides — `Foo:Hover { Color: red }` lands here.
   *  Layered on top of the base TextStyle by `EffectiveTextStyle()` when
   *  the matching state flag is set. */
  HoverTextStyle: Partial<TextStyle> | null = null;
  ActiveTextStyle: Partial<TextStyle> | null = null;
  FocusTextStyle: Partial<TextStyle> | null = null;
  DisabledTextStyle: Partial<TextStyle> | null = null;
  GroupHoverTextStyle: Partial<TextStyle> | null = null;

  /** Class names this Jiv carries, parsed from the `class="A B C"` attribute.
   *  Used by the canvas's group-state registry to fan `_groupHover` out to
   *  peers sharing a group-trigger class. */
  Classes: readonly string[] = [];

  get Hover(): boolean { return this._hover; }
  set Hover(v: boolean) {
    if (this._hover === v) return;
    this._hover = v;
    this._syncState('Hover', v);
    if (this.HoverTextStyle || this._hasTextPredicates) this._invalidateText();
  }
  get Active(): boolean { return this._active; }
  set Active(v: boolean) {
    if (this._active === v) return;
    this._active = v;
    this._syncState('Active', v);
    // 'Pressed' is the canonical PascalCase state name in the predicate
    // grammar; mirror Active onto it so authors can write either
    // `:Active` (legacy) or `:(Pressed && !Disabled)` (new) and get the
    // same pointer-driven trigger without confusion.
    this._syncState('Pressed', v);
    if (this.ActiveTextStyle || this._hasTextPredicates) this._invalidateText();
  }
  get Focus(): boolean { return this._focus; }
  set Focus(v: boolean) {
    if (this._focus === v) return;
    this._focus = v;
    this._syncState('Focus', v);
    if (this.FocusTextStyle || this._hasTextPredicates) this._invalidateText();
  }
  get Disabled(): boolean { return this._disabled; }
  set Disabled(v: boolean) {
    if (this._disabled === v) return;
    this._disabled = v;
    this._syncState('Disabled', v);
    // Reserved-Disabled defaults: when Disabled flips on, the framework
    // suppresses pointer-event dispatch and forces the cursor to Default
    // unless an explicit author rule overrides it. Stash the pre-disabled
    // values so we restore exactly what was authored when Disabled flips
    // off again. Author rules that write Interactive / Cursor inside a
    // `:Disabled { ... }` or `:(Disabled && ...) { ... }` block still win
    // via EffectiveStyle's merge order (compound predicate styles layer
    // ON TOP of these implicit defaults).
    if (v) {
      this._preDisabledInteractive = this.Interactive;
      this._preDisabledCursor = this.Cursor;
      this.Interactive = false;
      this.Cursor = 'Default';
    } else {
      if (this._preDisabledInteractive !== null) {
        this.Interactive = this._preDisabledInteractive;
        this._preDisabledInteractive = null;
      }
      if (this._preDisabledCursor !== null) {
        this.Cursor = this._preDisabledCursor;
        this._preDisabledCursor = null;
      }
    }
    if (this.DisabledTextStyle || this._hasTextPredicates) this._invalidateText();
  }
  get GroupHover(): boolean { return this._groupHover; }
  set GroupHover(v: boolean) {
    if (this._groupHover === v) return;
    this._groupHover = v;
    this._syncState('GroupHover', v);
    if (this.GroupHoverTextStyle || this._hasTextPredicates) this._invalidateText();
  }

  /** Imperative state setter for predicates beyond the five pointer-driven
   *  ones. Authors can declare any state name in JSS (`Foo:(Loading) { … }`,
   *  `Foo:(Recording && !Disabled) { … }`); the framework toggles them
   *  here. Idempotent — flipping a state to its current value is a no-op
   *  and doesn't trigger a re-render.
   *
   *  Pointer-driven states (Hover/Active/Focus/Disabled/GroupHover) round-
   *  trip through this same path via their typed setters above; calling
   *  SetState('Hover', true) directly would skip the typed setter's text-
   *  invalidation, so author code should prefer the typed setters when
   *  one exists. The Angular `[disabled]` input plumbs through the typed
   *  Disabled setter, not SetState, for the same reason. */
  SetState = (name: string, on: boolean): void => {
    const has = this._states.has(name);
    if (has === on) return;
    if (on) this._states.add(name); else this._states.delete(name);
    if (this._hasTextPredicates) this._invalidateText();
  };

  /** Cached check — does any PredicateStyle entry write into TextStyle?
   *  Computed once when PredicateStyles is assigned. Drives whether state
   *  changes need to invalidate text. Visual-only predicates don't need
   *  a text re-measure on every pointer move, so the gate stays cheap. */
  private _hasTextPredicates: boolean = false;

  private _syncState = (name: string, on: boolean): void => {
    if (on) this._states.add(name); else this._states.delete(name);
  };

  /** Captured Interactive/Cursor values from BEFORE Disabled was set, so
   *  flipping Disabled off restores exactly what the author originally
   *  declared (rather than baking in the framework's implicit defaults). */
  private _preDisabledInteractive: boolean | null = null;
  private _preDisabledCursor: CursorStyle | null = null;

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
    GroupHoverStyle?: Partial<JivStyle>;
    HoverTextStyle?: Partial<TextStyle>;
    ActiveTextStyle?: Partial<TextStyle>;
    FocusTextStyle?: Partial<TextStyle>;
    DisabledTextStyle?: Partial<TextStyle>;
    GroupHoverTextStyle?: Partial<TextStyle>;
    Classes?: readonly string[];
    PredicateStyles?: readonly PredicateStyle[];
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
    this.GroupHoverStyle = options?.GroupHoverStyle ?? null;
    this.HoverTextStyle = options?.HoverTextStyle ?? null;
    this.ActiveTextStyle = options?.ActiveTextStyle ?? null;
    this.FocusTextStyle = options?.FocusTextStyle ?? null;
    this.DisabledTextStyle = options?.DisabledTextStyle ?? null;
    this.GroupHoverTextStyle = options?.GroupHoverTextStyle ?? null;
    this.Classes = options?.Classes ?? [];
    this.TextSelectionStyle = options?.TextSelectionStyle ?? null;
    this.Springs = options?.Springs ?? null;
    this.Animations = options?.Animations ?? null;
    this.AnimationTable = options?.AnimationTable ?? null;
    if (options?.PredicateStyles) this._setPredicateStylesInternal(options.PredicateStyles);
  }

  /** Replace the PredicateStyles list. Used by the worker registry on
   *  class-swap so the new class's compound-pseudo rules take effect. The
   *  internal setter also recomputes _hasTextPredicates so the cheap-path
   *  gate in state setters stays in sync. */
  SetPredicateStyles = (list: readonly PredicateStyle[] | null): void => {
    this._setPredicateStylesInternal(list);
  };

  private _setPredicateStylesInternal = (list: readonly PredicateStyle[] | null): void => {
    this.PredicateStyles = list;
    let hasText = false;
    if (list) {
      for (const entry of list) {
        if (entry.TextStyle && Object.keys(entry.TextStyle).length > 0) {
          hasText = true;
          break;
        }
      }
    }
    this._hasTextPredicates = hasText;
  };

  /** Final render-time style. Two tiers, both source-order last-wins:
   *
   *    1. Legacy state slots — Hover/Active/Focus/Disabled/GroupHover —
   *       applied in fixed priority (GroupHover → Hover → Active →
   *       Focus → Disabled). These are still here so existing JSS that
   *       uses `Foo:Hover { ... }` (no parens) keeps painting bit-exact.
   *    2. Compound predicate entries — `Foo:(Hover && !Disabled) { ... }` —
   *       applied in source order. Each predicate evaluates against the
   *       live `_states` set; matches Object.assign onto the merged style.
   *
   *  Predicate entries layer ON TOP of legacy slots by design — the new
   *  authoring path supersedes the old when authors mix both. Practical
   *  example: `Foo:Hover { BackdropBrightness: 1.85 }` (legacy) plus
   *  `Foo:(Hover && !Disabled) { BackdropBrightness: 1.85 }` and
   *  `Foo:Disabled { ... }` work together because when Disabled is set,
   *  the compound predicate matches `false` (NOT Disabled fails) so it
   *  doesn't fire, leaving the legacy disabled style to dominate. */
  EffectiveStyle = (): JivStyle => {
    const hasLegacyState = this._hover || this._active || this._focus || this._disabled || this._groupHover;
    const hasPredicates = this.PredicateStyles && this.PredicateStyles.length > 0;
    if (!hasLegacyState && !hasPredicates) return this.Style;
    const merged: JivStyle = { ...this.Style };
    if (this._groupHover && this.GroupHoverStyle) Object.assign(merged, this.GroupHoverStyle);
    if (this._hover && this.HoverStyle) Object.assign(merged, this.HoverStyle);
    if (this._active && this.ActiveStyle) Object.assign(merged, this.ActiveStyle);
    if (this._focus && this.FocusStyle) Object.assign(merged, this.FocusStyle);
    if (this._disabled && this.DisabledStyle) Object.assign(merged, this.DisabledStyle);
    if (hasPredicates) {
      for (const entry of this.PredicateStyles!) {
        if (entry.Style && EvaluatePredicate(entry.Predicate, this._states)) {
          Object.assign(merged, entry.Style);
        }
      }
    }
    return merged;
  };

  /** Text-style counterpart to EffectiveStyle. Layout / render call sites
   *  read this instead of `node.TextStyle` directly so JSS `Foo:Hover {
   *  Color: red }` actually paints — the parser routes Color into
   *  HoverTextStyle and we layer it here when the matching state is set.
   *  Same two-tier model as EffectiveStyle. */
  override EffectiveTextStyle = (): TextStyle => {
    const hasLegacyState = this._hover || this._active || this._focus || this._disabled || this._groupHover;
    const hasPredicates = this._hasTextPredicates;
    if (!hasLegacyState && !hasPredicates) return this.TextStyle;
    const merged: TextStyle = { ...this.TextStyle };
    if (this._groupHover && this.GroupHoverTextStyle) Object.assign(merged, this.GroupHoverTextStyle);
    if (this._hover && this.HoverTextStyle) Object.assign(merged, this.HoverTextStyle);
    if (this._active && this.ActiveTextStyle) Object.assign(merged, this.ActiveTextStyle);
    if (this._focus && this.FocusTextStyle) Object.assign(merged, this.FocusTextStyle);
    if (this._disabled && this.DisabledTextStyle) Object.assign(merged, this.DisabledTextStyle);
    if (hasPredicates && this.PredicateStyles) {
      for (const entry of this.PredicateStyles) {
        if (entry.TextStyle && EvaluatePredicate(entry.Predicate, this._states)) {
          Object.assign(merged, entry.TextStyle);
        }
      }
    }
    return merged;
  };
}
