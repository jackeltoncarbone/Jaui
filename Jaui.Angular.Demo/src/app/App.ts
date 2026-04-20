import { Component } from '@angular/core';
import { JauiCanvas } from 'jaui-angular';
import { Home } from '../Home/Home';

/**
 * App shell — owns the single `<jaui-canvas>` for the entire app. Routed
 * pages render their Jiv content into this canvas via DI hierarchy.
 *
 * The Show Studio home port is the inaugural occupant.
 */
@Component({
  selector: 'jaui-app',
  standalone: true,
  imports: [JauiCanvas, Home],
  template: `
    <jaui-canvas>
      <home></home>
    </jaui-canvas>
  `,
  styles: [''],
})
export class App {}
