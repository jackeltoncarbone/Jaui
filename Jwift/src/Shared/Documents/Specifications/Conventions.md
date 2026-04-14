# Conventions

Jwift follows C#-style TypeScript conventions, matching the patterns established in Show Studio.

## Naming

| What | Style | Example |
|---|---|---|
| Public properties | `PascalCase` | `Tier`, `IsMobile`, `MaxPixelRatio` |
| Public methods | `PascalCase` | `Register()`, `Render()`, `HitTest()` |
| Private fields | `_camelCase` | `_children`, `_observer`, `_initialized` |
| Private methods | `_camelCase` | `_scheduleLayout()`, `_onMutation()` |
| Readonly private fields | `_camelCase` | `_renderConfig`, `_springManager` |
| Local variables | `camelCase` | `renderConfig`, `blurPx`, `totalWidth` |
| Constructor params (stored) | `_camelCase` | `private _el: HTMLElement` |
| Interfaces / Types | `PascalCase` | `RenderConfig`, `DeviceTier`, `NodeStyle` |
| Enums | `PascalCase` members | `MaterialType.LiquidGlass` |
| Static readonly | `PascalCase` or `UPPER_SNAKE` | `static readonly MaxTextureSize = 256` |
| File names | `PascalCase.Purpose.ts` | `Jiv.Layout.Engine.ts`, `Spring.Animation.Manager.ts` |
| CSS classes | `PascalCase` | `.ContentContainer`, `.FrostClip`, `.BackgroundLayer` |

## Methods

Prefer arrow function class members for methods that may be passed as callbacks:

```typescript
// Preferred — stable `this` binding, can be passed directly as callback
Render = (): void => { ... };
_scheduleLayout = (): void => { ... };

// Use regular methods only for overridable/inherited behavior
protected OnResize(): void { ... }
```

## Architecture: Vertical Slice

Each feature is a self-contained vertical slice, not a horizontal layer. A feature owns everything it needs from shader to public API.

```
// Wrong — horizontal layers
src/
  shaders/     ← all shaders for all features
  renderers/   ← all renderers for all features
  models/      ← all models for all features

// Right — vertical slices
src/
  Glass/
    Glass.Material.ts      ← renderer
    Glass.Shader.frag      ← shader
    Glass.Style.ts         ← style model
  Blur/
    Blur.Material.ts
    Blur.Shader.frag
    Blur.Style.ts
  Layout/
    Layout.Solver.ts
    Layout.Flex.ts
    Layout.Types.ts
```

Shared infrastructure (WebGL context, math utilities) lives in `Core/`. Everything else lives in its feature slice.

## Dependencies

Dependencies flow inward only:

```
Feature slice → Core (ok)
Core → Feature slice (never)
Feature A → Feature B (avoid — use Core abstractions)
```

If two features need to talk, extract the shared concept into `Core/`.

## Services and DI

Injectable services over static classes. Every service is `providedIn: 'root'` unless it has a narrower scope.

Exception: pure math utilities (like `Jath` in Show Studio, analogous to `System.Math`) can be static — they have no state and no dependencies.

```typescript
// Service — has state, has dependencies
@Injectable({ providedIn: 'root' })
export class DeviceService {
  readonly Tier: DeviceTier = this._detectTier();
}

// Pure math — no state, no DI needed
export class Jath {
  static Lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
  static Clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));
}
```

## Config as Constraints

Configuration objects express limits and hints, not concrete values. Consumers derive actual values from constraints.

```typescript
// Wrong — hardcoded values
interface RenderConfig {
  TextureWidth: 1024;
  PixelRatio: 1.0;
}

// Right — constraints that consumers interpret
interface RenderConfig {
  MaxPixelRatio: number;       // actual = min(devicePixelRatio, this)
  GrassTextureScale: number;   // actual = baseSize * this
  Shadows: boolean;            // permission, not a size
}
```

## Design System

### Concentric Radii

Every nested element's border radius = parent radius - gap between them. This is non-negotiable.

```
App corner:     4.5em    (from InsetCorners)
Chrome padding: 1.875em
Drawer radius:  4.5 - 1.875 = 2.625em
Nested panel:   2.625 - gap = ...
```

In Jwift, this is computed automatically — a child node reads its parent's border radius and subtracts its distance from the parent edge.

### Apple Minimalism

- Monochrome UI — no colored category indicators, no rainbow
- Liquid Glass for overlays and interactive elements
- Solid Glass for page content surfaces
- Restrained animation — spring physics, not bounce/overshoot
- Typography does the hierarchy work, not color

### No Selector Prefixes

Components use bare selectors: `panel`, `toolbar`, `dropdown` — not `jwift-panel`, `app-toolbar`.

## Testing

- **Layout math** — unit tests. Pure functions, no DOM, fast.
- **Shader output** — snapshot tests. Render a known scene, compare pixel output.
- **Visual regression** — Playwright screenshots across Chromium + WebKit. The point of Jwift is pixel-identical rendering, so these should match exactly.
- **Interaction** — Playwright tests simulating pointer/keyboard events on the canvas.

## Build

TypeScript compiled with `tsc`. No bundler for the library — consumers bundle it. The library ships as ESM with `.d.ts` type declarations.

Dev tooling: Vite for the dev server / playground. Tests: Vitest for unit, Playwright for visual.
