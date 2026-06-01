import { Component } from '@angular/core';
import { Jaui } from 'jaui-angular';
import { Home } from '../Home/Home';

/**
 * App shell — owns the single `<jaui>` for the entire app. Routed
 * pages render their Jiv content into this canvas via DI hierarchy.
 *
 * The Show Studio home port is the inaugural occupant.
 */
@Component({
  selector: 'jaui-app',
  standalone: true,
  imports: [Jaui, Home],
  template: `
    <jaui>
      <home></home>
    </jaui>
  `,
  styles: [''],
})
export class App {}
