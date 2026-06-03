import { Component } from '@angular/core';
import { Jaui, JAUI_WORKER } from 'jaui-angular';
import { Home } from '../Home/Home';

/**
 * App shell — owns the single `<jaui>` for the entire app. Routed
 * pages render their Jiv content into this canvas via DI hierarchy.
 *
 * The Show Studio home port is the inaugural occupant.
 *
 * `<jaui>` is worker-only: it requires a consumer-built Worker via the
 * JAUI_WORKER token (provided here at the host component, so `<jaui>` reads
 * it at construction before any child <jiv> runs). The worker boots the Jaui
 * render worker (see jaui.worker.ts). This was missing — the cause of the
 * NullInjector error that blanked the page.
 */
@Component({
  selector: 'jaui-app',
  standalone: true,
  imports: [Jaui, Home],
  providers: [
    { provide: JAUI_WORKER, useFactory: () => new Worker(new URL('./jaui.worker', import.meta.url), { type: 'module' }) },
  ],
  template: `
    <jaui>
      <home></home>
    </jaui>
  `,
  styles: [''],
})
export class App {}
