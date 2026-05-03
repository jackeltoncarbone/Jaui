import {
  AfterContentInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  inject,
  input,
} from '@angular/core';
import { JSS_REGISTRY } from '../Jss/Jss.Registry';

/**
 * `<jyle>` — JSS scoped to a component subtree. Two ways to feed it:
 *
 * 1. **`[source]` input (recommended)** — bind to a string. Angular's
 *    template parser doesn't see the `{` characters because they're inside
 *    a string value, not the template body. Pair this with a `.jss` file
 *    imported via the text loader:
 *
 *      import jssText from './Home.jss';
 *      ...
 *      <jyle [source]="JssSource" />
 *      readonly JssSource = jssText;
 *
 * 2. **Inline projected content** — write JSS directly inside the tag.
 *    Requires `ngNonBindable` to stop Angular from parsing the `{` as
 *    interpolation syntax:
 *
 *      <jyle ngNonBindable>
 *        Card {{ '{' }} Background: rgba(...) }
 *      </jyle>
 *
 *    The `[source]` input form is much nicer; prefer it.
 *
 * **`global` flag** — `<jyle [source]="JwiftGlassJss" global />` registers
 * the sheet in the registry's globals tier instead of the scoped tier.
 * Globals can be extended by any later sheet via `MyThing : Base {...}`,
 * even though the base lives in a different sheet. Use this for design-
 * system base classes (`JwiftGlass`, typography presets, color tokens) at
 * app boot. Default `false` — preserves the current scoped behavior.
 *
 * The element renders nothing visible (`display: none`).
 */
@Component({
  selector: 'jyle',
  standalone: true,
  template: '<ng-content></ng-content>',
  styles: [':host { display: none; }'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Jyle implements AfterContentInit {
  /** JSS source string. When set, this is what gets parsed; the projected
   *  text content (path 2 in the docs above) is ignored. */
  readonly source = input<string | undefined>(undefined);

  /** Register into the registry's globals tier instead of the scoped
   *  tier. Globals are usable as `: Base` extension targets from any
   *  sheet that loads after them. */
  readonly global = input<boolean | string>(false);

  private _el = inject(ElementRef<HTMLElement>);
  private _registry = inject(JSS_REGISTRY);

  constructor() {
    // React to source changes after first init so dynamically-bound JSS
    // updates work too.
    effect(() => {
      const src = this.source();
      if (!src) return;
      if (_truthy(this.global())) this._registry.RegisterGlobal(src);
      else                         this._registry.MergeSource(src);
    });
  }

  ngAfterContentInit(): void {
    // Fall back to projected content if no [source] was bound.
    if (!this.source()) {
      const projected = this._el.nativeElement.textContent ?? '';
      if (_truthy(this.global())) this._registry.RegisterGlobal(projected);
      else                         this._registry.MergeSource(projected);
    }
  }
}

// `<jyle global />` (no value) flows in as the empty string, which is
// falsy in JS but author-intent is clearly truthy. Coerce attribute-style
// presence to boolean here so both `[global]="true"` and bare `global`
// work the same way.
const _truthy = (v: boolean | string): boolean =>
  v === true || v === '' || (typeof v === 'string' && v.toLowerCase() !== 'false');
