import { ChangeDetectionStrategy, Component } from '@angular/core';
import { Jiv } from '../Jiv/Jiv';

/**
 * `<light>` — a Jiv that emits light into the one shared scene. Lights are not a
 * separate primitive: a light IS a Jiv whose `LightType` (+ LightColor /
 * LightIntensity_ / LightDirection / LightRange / LightConeAngle / LightPenumbra)
 * is set. Because it lives in the tree it lives in the scene, so it lights every
 * surface and mesh. It paints no body (the orchestrator gathers it into the
 * scene light set and skips drawing it). Position/aim come from the normal
 * layout + `Space` like any Jiv.
 *
 *   <light class="KeyLight" />
 *
 * where the `KeyLight` JSS rule sets `LightType: Directional` etc. Inherits Jiv's
 * full input surface (class / style / layout / childLayout) and parent discovery.
 */
@Component({
  selector: 'light',
  standalone: true,
  template: '<ng-content></ng-content>',
  styles: [':host { display: contents; }'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Light extends Jiv {}
