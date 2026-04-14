import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  effect,
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
import { PARENT_JIV } from './Parent.Jiv.Token';
import { JssRegistry, JSS_REGISTRY } from '../Jss/Jss.Registry';

/**
 * `<jiv>` — generic Jwift node. Bridges Angular template authoring to a
 * Jiv instance: creates the Jiv on construction, attaches it to the parent
 * (resolved via PARENT_JIV), provides itself as PARENT_JIV for descendants,
 * and removes itself on destroy.
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
  providers: [
    { provide: PARENT_JIV, useFactory: (cmp: Jiv) => cmp.Node, deps: [Jiv] },
  ],
})
export class Jiv implements AfterViewInit, OnDestroy {
  // class is a reserved keyword in TS — alias it.
  readonly className = input<string | undefined>(undefined, { alias: 'class' });
  readonly style = input<Partial<JivStyle> | undefined>(undefined);
  readonly layout = input<Partial<LayoutConfig> | undefined>(undefined);
  readonly childLayout = input<Partial<ChildLayout> | undefined>(undefined);
  readonly text = input<string | null | undefined>(undefined);
  readonly textStyle = input<Partial<TextStyle> | undefined>(undefined);

  /** The underlying Jiv instance. Created in the constructor so the
   *  PARENT_JIV provider has a value to hand to descendants. */
  readonly Node: JivCore;

  private _parent = inject(PARENT_JIV);
  private _registry = inject(JSS_REGISTRY, { optional: true });

  constructor() {
    this.Node = new JivCore(this._buildOptions());
    // Reactively re-apply on input changes — let the spring animator handle
    // the smooth transition rather than recreating the Jiv.
    effect(() => this._apply());
  }

  ngAfterViewInit(): void {
    this._parent.AddChild(this.Node);
  }

  ngOnDestroy(): void {
    this._parent.RemoveChild(this.Node);
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

  /** Re-apply the merged options to the live Node. Spring animator picks up
   *  field deltas automatically — no manual transition logic. */
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
