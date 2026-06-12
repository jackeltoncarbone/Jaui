import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import type { FitMode } from 'jaui';
import { Jiv } from '../Jiv/Jiv';
import type { SemanticRole } from '../Seo/Seo.Types';

/**
 * `<jimage>` — convenience element for the common "this Jiv is a textured
 * fill" case. Internally a `<jiv>` whose Background is set to
 * `Url(src, fit, placeholder)`. Equivalent to writing the same Background
 * on a plain `<jiv>` — sugar for readability and intent.
 *
 *   <jimage src="/covers/spring.jpg" />
 *   <jimage class="HeroLogo" src="ss-logo" />
 *   <jimage src="/portrait.jpg" fit="Contain" />
 *
 * Inherits everything `<jiv>` exposes — `[class]`, `[style]`, `[layout]`,
 * `[childLayout]`, `[disabled]`. Explicit Background in `[style]` takes
 * precedence over the `src` / `fit` / `placeholder` inputs.
 */
@Component({
  selector: 'jimage',
  standalone: true,
  imports: [Jiv],
  template: `<jiv
    [class]="className()"
    [style]="MergedStyle()"
    [layout]="layout()"
    [childLayout]="childLayout()"
    [disabled]="disabled()"
    [semantics]="semantics()"
    [href]="href()"
    [alt]="alt()"
    [label]="label()"
    [seo]="seo()" />`,
  styles: [':host { display: contents; }'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Jimage {
  readonly src = input<string | null | undefined>(undefined);
  readonly fit = input<FitMode>('Cover');
  /** Solid color painted while the bitmap is loading (and as a fallback if
   *  the load fails). Default transparent. */
  readonly placeholder = input<string>('transparent');
  readonly className = input<string | undefined>(undefined, { alias: 'class' });
  readonly style = input<Record<string, unknown> | undefined>(undefined);
  readonly layout = input<Record<string, unknown> | undefined>(undefined);
  readonly childLayout = input<Record<string, unknown> | undefined>(undefined);
  readonly disabled = input<boolean | undefined>(undefined);
  /** Alt text for the semantic mirror — with `src`, projects `<img alt>`. */
  readonly alt = input<string | null | undefined>(undefined);
  readonly semantics = input<SemanticRole | undefined>(undefined);
  readonly href = input<string | null | undefined>(undefined);
  readonly label = input<string | null | undefined>(undefined);
  readonly seo = input<boolean | undefined>(undefined);

  readonly MergedStyle = computed<Record<string, unknown>>(() => {
    const base = (this.style() ?? {}) as Record<string, unknown>;
    if (base['Background'] !== undefined) return base;
    const s = this.src();
    if (s === undefined || s === null || s === '') {
      return { ...base, Background: this.placeholder() };
    }
    return { ...base, Background: `Url("${s}", ${this.fit()}, ${this.placeholder()})` };
  });
}
