import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  effect,
  forwardRef,
  inject,
  input,
} from '@angular/core';
import {
  Jiv as JivCore,
  type JivStyle,
  type LayoutConfig,
  type ChildLayout,
  type TextStyle,
} from 'jwift';
import { JwiftCanvas } from '../Canvas/JwiftCanvas';
import { JSS_REGISTRY } from '../Jss/Jss.Registry';

/**
 * `<jiv>` — generic Jwift node. Creates a Jiv on construction, attaches
 * to the nearest ancestor `<jiv>` or `<jwift-canvas>` on init, removes
 * itself on destroy.
 *
 * Parent resolution is pure Angular DI — `inject(ParentClass, { skipSelf,
 * optional })`. The closer ancestor wins; if nested under another `<jiv>`
 * that Jiv is the parent; otherwise we fall through to the enclosing
 * `<jwift-canvas>`'s Root. No custom InjectionToken ceremony.
 *
 * Inputs (signal-based, all optional):
 *   class       — space-separated class names; resolved against the local
 *                 JssRegistry (Style/Layout/ChildLayout/TextStyle)
 *   style       — Partial<JivStyle> applied AFTER class resolution (wins)
 *   layout      — Partial<LayoutConfig>
 *   childLayout — Partial<ChildLayout>
 *   text        — string; sets jiv.Text
 *   textStyle   — Partial<TextStyle>
 *
 * Native DOM events (`click`, `pointerdown`, …) bubble through the host
 * `<jiv>` element — Angular's standard event binding works without any
 * special wiring on our side.
 */
@Component({
  selector: 'jiv',
  standalone: true,
  template: '<ng-content></ng-content>',
  styles: [':host { display: contents; }'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Jiv implements OnInit, OnDestroy {
  readonly className = input<string | undefined>(undefined, { alias: 'class' });
  readonly style = input<Partial<JivStyle> | undefined>(undefined);
  readonly layout = input<Partial<LayoutConfig> | undefined>(undefined);
  readonly childLayout = input<Partial<ChildLayout> | undefined>(undefined);
  readonly text = input<string | null | undefined>(undefined);
  readonly textStyle = input<Partial<TextStyle> | undefined>(undefined);

  /** The underlying Jiv instance, created in the constructor. */
  readonly Node: JivCore;

  // forwardRef because Jiv (this class) references itself via DI. The
  // parent Jiv — if any — is the nearest ancestor. If there's no parent
  // Jiv, we're a top-level child of <jwift-canvas> and attach to its Root.
  private _parentJiv = inject<Jiv | null>(forwardRef(() => Jiv), {
    skipSelf: true,
    optional: true,
  });
  private _canvas = inject(JwiftCanvas, { optional: true });
  private _registry = inject(JSS_REGISTRY, { optional: true });

  constructor() {
    this.Node = new JivCore(this._buildOptions());
    // Reactively re-apply on input changes — spring animator handles the
    // smooth transition; we don't recreate the Jiv. Tracking the registry
    // version signal here is what makes live `.jss` hot-edits propagate:
    // when a `<jyle>` re-parses, the registry version bumps, every Jiv
    // that reads it via this effect re-resolves its class rules.
    effect(() => {
      // Subscribe to registry changes — even for class-less jivs, this is
      // cheap and keeps behavior uniform.
      this._registry?.Version();
      this._apply();
    });
  }

  ngOnInit(): void {
    this._parent().AddChild(this.Node);
  }

  ngOnDestroy(): void {
    this._parent().RemoveChild(this.Node);
  }

  /** Nearest ancestor Jiv or the canvas root. Always defined if this
   *  `<jiv>` is used inside a `<jwift-canvas>` (which it must be — a
   *  floating `<jiv>` with no canvas ancestor throws a clear error). */
  private _parent(): JivCore {
    if (this._parentJiv) return this._parentJiv.Node;
    if (this._canvas) return this._canvas.Root;
    throw new Error('[Jwift.Angular] <jiv> must be inside a <jwift-canvas>');
  }

  private _buildOptions(): {
    Style?: Partial<JivStyle>;
    Layout?: Partial<LayoutConfig>;
    ChildLayout?: Partial<ChildLayout>;
    TextStyle?: Partial<TextStyle>;
    Text?: string;
  } {
    const fromClass = this._registry?.Resolve(this.className()) ?? null;
    const text = this.text();
    return {
      Style:       { ...fromClass?.Style,       ...this.style() },
      Layout:      { ...fromClass?.Layout,      ...this.layout() },
      ChildLayout: { ...fromClass?.ChildLayout, ...this.childLayout() },
      TextStyle:   { ...fromClass?.TextStyle,   ...this.textStyle() },
      ...(text != null ? { Text: text } : {}),
    };
  }

  /** Re-apply merged options to the live Node on input change. Spring
   *  animator picks up field deltas automatically — no manual transitions. */
  private _apply(): void {
    const opts = this._buildOptions();
    if (opts.Style) Object.assign(this.Node.Style, opts.Style);
    if (opts.Layout) Object.assign(this.Node.Layout, opts.Layout);
    if (opts.ChildLayout) Object.assign(this.Node.ChildLayout, opts.ChildLayout);
    if (opts.TextStyle) Object.assign(this.Node.TextStyle, opts.TextStyle);
    if ('Text' in opts) this.Node.Text = opts.Text ?? null;
    this.Node.MarkLayoutDirty();
  }
}

