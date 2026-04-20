import { ChangeDetectionStrategy, Component } from '@angular/core';
import { Jiv } from '../Jiv/Jiv';

/**
 * `<jext>` — text-focused sugar for `<jiv [text]="...">`. Inherits Jiv's
 * full input surface (class / style / layout / childLayout / textStyle /
 * text) and its parent-discovery mechanism via subclass. The only
 * practical difference is the selector and the ergonomic intent:
 *
 *   <jext class="Title" text="Discover" />
 *
 * is equivalent to:
 *
 *   <jiv class="Title" [text]="'Discover'" />
 */
@Component({
  selector: 'jext',
  standalone: true,
  template: '<ng-content></ng-content>',
  styles: [':host { display: contents; }'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Jext extends Jiv {}
