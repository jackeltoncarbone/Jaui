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

  private _el = inject(ElementRef<HTMLElement>);
  private _registry = inject(JSS_REGISTRY);

  constructor() {
    // React to source changes after first init so dynamically-bound JSS
    // updates work too.
    effect(() => {
      const src = this.source();
      if (src) this._registry.MergeSource(src);
    });
  }

  ngAfterContentInit(): void {
    // Fall back to projected content if no [source] was bound.
    if (!this.source()) {
      const projected = this._el.nativeElement.textContent ?? '';
      this._registry.MergeSource(projected);
    }
  }
}
