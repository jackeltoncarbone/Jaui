import { ChangeDetectionStrategy, Component } from '@angular/core';
import { Jiv } from '../Jiv/Jiv';
import { PARENT_JIV } from '../Jiv/Parent.Jiv.Token';

/**
 * `<jext>` — text-focused sugar for `<jiv [text]="...">`. Inherits all of
 * `<jiv>`'s inputs (class / style / layout / childLayout / textStyle / text)
 * via subclass; the only practical difference is the selector and the
 * ergonomic intent ("this node is text").
 *
 * Example:
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
  providers: [
    { provide: PARENT_JIV, useFactory: (cmp: Jext) => cmp.Node, deps: [Jext] },
  ],
})
export class Jext extends Jiv {}
