import { Component } from '@angular/core';
import { Jiv, Jext, Jyle } from 'jwift-angular';
import HomeJss from './Home.jss';

/**
 * Home page — port of the Show Studio home (../../../show-studio/...) into
 * the Jwift Angular demo. Whoever's filling this in: keep the template
 * minimal — that's the whole pitch of Jwift. JSS class-based styling +
 * `<jiv>`/`<jext>` primitives, no per-element style attribute soup.
 *
 * Style authoring: edit `./Home.jss`. The Vite/esbuild text loader inlines
 * its content as a string at build time; `<jyle [source]="...">` parses it
 * once on mount.
 */
@Component({
  selector: 'home',
  standalone: true,
  imports: [Jiv, Jext, Jyle],
  template: `
    <jyle [source]="JssSource" />
    <jiv class="Placeholder">
      <jext class="Title" text="Jwift.Angular.Demo — agent: replace with Show Studio home port" />
    </jiv>
  `,
})
export class Home {
  readonly JssSource = HomeJss;
}
