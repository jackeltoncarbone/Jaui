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

  /** Pseudo-selector rules — both tight `:Foo` and compound `:(expr)` from
   *  JSS land here. Each entry has a JSON-safe Predicate AST + a routed
   *  Style/TextStyle patch. EffectiveStyle evaluates each predicate against
   *  the Jiv's live state set (`_states`) and Object.assigns matches in
   *  source order. Populated by SetPredicateStyles at class-apply time. */
  PredicateStyles: readonly PredicateStyle[] | null = null;

  /** Live state set — the source of truth for predicate evaluation.
   *  Pointer-driven states (Hover, Active, Focus, GroupHover) are kept in
   *  sync by the typed setters below. Disabled mirrors the same pattern.
   *  Custom states (Loading, Recording, anything author-named) are set via
   *  `SetState(name, on)` — Phase 2 framework hook for the Angular
   *  `[disabled]` input and any future state inputs. */
  private readonly _states: Set<string> = new Set();
  /** Class names this Jiv carries, parsed from the `class="A B C"` attribute.
   *  Used by the canvas's group-state registry to fan `_groupHover` out to
   *  peers sharing a group-trigger class. */
  Classes: readonly string[] = [];

  get Hover(): boolean { return this._hover; }
  set Hover(v: boolean) {
    if (this._hover === v) return;
    this._hover = v;
    this._syncState('Hover', v);
    if (this._hasTextPredicates) this._invalidateText();
  }
  get Active(): boolean { return this._active; }
  set Active(v: boolean) {
    if (this._active === v) return;
    this._active = v;
    this._syncState('Active', v);
    // 'Pressed' is the canonical PascalCase state name in the predicate
    // grammar; mirror Active onto it so authors can write either
    // `:Active` or `:(Pressed && !Disabled)` and get the same pointer-
    // driven trigger without confusion.
    this._syncState('Pressed', v);
    if (this._hasTextPredicates) this._invalidateText();
  }
  get Focus(): boolean { return this._focus; }
  set Focus(v: boolean) {
    if (this._focus === v) return;
    this._focus = v;
    this._syncState('Focus', v);
    if (this._hasTextPredicates) this._invalidateText();
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
    // via EffectiveStyle's merge order (predicate styles layer ON TOP of
    // these implicit defaults).
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
    if (this._hasTextPredicates) this._invalidateText();
  }
  get GroupHover(): boolean { return this._groupHover; }
  set GroupHover(v: boolean) {
    if (this._groupHover === v) return;
    this._groupHover = v;
    this._syncState('GroupHover', v);
    if (this._hasTextPredicates) this._invalidateText();
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

  /** Final render-time style. Walks PredicateStyles in source order,
   *  evaluating each entry's Predicate against the Jiv's live state set
   *  and Object.assigning matching styles onto the base. Last-wins on
   *  conflicting properties within the tier (declaration order).
   *
   *  Fast path: if there are no predicate rules attached, returns the
   *  base Style by reference (zero alloc).
   *
   *  `Foo:Hover { ... }`, `Foo:Disabled { ... }`, and `Foo:(Hover &&
   *  !Disabled) { ... }` all flow through the same path — the parser
   *  compiled them all into PredicateStyle entries. Authors writing
   *  `:(Hover && !Disabled)` get hover suppression when disabled for
   *  free; authors writing both `:Hover` and `:Disabled` separately
   *  get the legacy fixed-priority behavior simply because Disabled is
   *  declared later in source.  */
  EffectiveStyle = (): JivStyle => {
    if (!this.PredicateStyles || this.PredicateStyles.length === 0) return this.Style;
    let merged: JivStyle | null = null;
    for (const entry of this.PredicateStyles) {
      if (entry.Style && EvaluatePredicate(entry.Predicate, this._states)) {
        if (!merged) merged = { ...this.Style };
        Object.assign(merged, entry.Style);
      }
    }
    return merged ?? this.Style;
  };

  /** Text-style counterpart to EffectiveStyle. Same single-tier walk over
   *  PredicateStyles entries that carry a TextStyle bag. The
   *  `_hasTextPredicates` flag (computed when PredicateStyles is assigned)
   *  short-circuits this method when no entry writes text properties, so
   *  visual-only hover effects don't re-measure glyphs. */
  override EffectiveTextStyle = (): TextStyle => {
    if (!this._hasTextPredicates || !this.PredicateStyles) return this.TextStyle;
    let merged: TextStyle | null = null;
    for (const entry of this.PredicateStyles) {
      if (entry.TextStyle && EvaluatePredicate(entry.Predicate, this._states)) {
        if (!merged) merged = { ...this.TextStyle };
        Object.assign(merged, entry.TextStyle);
      }
    }
    return merged ?? this.TextStyle;
  };
}
