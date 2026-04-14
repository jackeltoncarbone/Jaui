import { Component } from '@angular/core';
import { JwiftCanvas } from 'jwift-angular';
import { Home } from '../Home/Home';

/**
 * App shell — owns the single `<jwift-canvas>` for the entire app. Routed
 * pages render their Jiv content into this canvas via DI hierarchy.
 *
 * The Show Studio home port is the inaugural occupant.
 */
@Component({
  selector: 'jwift-app',
  standalone: true,
  imports: [JwiftCanvas, Home],
  template: `
    <jwift-canvas>
      <home></home>
    </jwift-canvas>
  `,
  styles: [':host { display: block; width: 100vw; height: 100vh; overflow: hidden; }'],
})
export class App {}
