import { Component } from '@angular/core';
import { JauiCanvas } from '../Canvas/JauiCanvas';

/**
 * `<jaui>` — top-level Jaui app component. Thin wrapper around the
 * internal `<jaui-canvas>` so consumers think in terms of "the app"
 * rather than "the canvas". Children (`<jiv>`, `<jext>`, etc.) find
 * the underlying Canvas via DI through the embedded `<jaui-canvas>`.
 *
 * The core `Jaui` class lives in `jaui` itself and is what non-Angular
 * consumers instantiate (`new Jaui(canvasEl)`); this Angular component
 * uses `<jaui-canvas>` internally so the existing DI tree (Jiv injecting
 * JauiCanvas, etc.) keeps working unchanged.
 */
@Component({
  selector: 'jaui',
  standalone: true,
  imports: [JauiCanvas],
  template: `
    <jaui-canvas>
      <ng-content></ng-content>
    </jaui-canvas>
  `,
  styles: [`
    :host { display: block; width: 100%; height: 100%; position: relative; }
  `],
})
export class Jaui {}
