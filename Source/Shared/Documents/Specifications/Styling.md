# Jack's Style Sheets (.jss)

A purpose-built style language for Jaui. Cascading, multi-inheritance, and every property maps directly to a GPU rendering primitive. No browser CSS parser, no vendor prefixes, no compositor hacks.

## Why Not CSS

CSS was designed for documents. It carries decades of backward compatibility:
- Properties like `backdrop-filter` that behave differently per browser engine
- The cascade is powerful but the specificity model is unintuitive
- No native support for springs, materials, or SDF shapes
- Custom properties (`--var`) are strings — no type safety, no tooling
- Media queries are detached from the elements they affect

JSS keeps what's good about CSS (cascading, selectors, inheritance) and replaces what's bad (browser rendering, untyped values, specificity confusion).

## Syntax

Familiar to anyone who knows CSS, but cleaner:

```jss
Panel {
  Material: LiquidGlass
  BorderRadius: 1.5em
  Padding: 0.5em
  LiquidBrightness: 1.7
  BorderColor: rgba(255, 255, 255, 0.4)
  BorderWidth: 0.1em
}
```

No semicolons. No colons at end of selectors. One property per line. Values are typed — `1.5em` is a length, `LiquidGlass` is a material enum, `rgba(...)` is a color.

## Cascading

JSS cascades by default, just like CSS. Child nodes inherit from parents:

```jss
Toolbar {
  Material: LiquidGlass
  LiquidBrightness: 1.7
  BorderColor: rgba(255, 255, 255, 0.4)

  // Children inherit Material and LiquidBrightness
  .BackButton {
    BorderRadius: 50%
    Width: 3em
    Height: 3em
  }

  .Title {
    FontWeight: 600
    FontSize: 1.0625em
  }
}
```

Nesting is structural — `.BackButton` inside `Toolbar` means "a BackButton that is a descendant of a Toolbar." The cascade flows down the render tree.

### Cascade Order

Simpler than CSS specificity. Later declarations win, deeper nesting wins:

1. Base styles (top-level selectors)
2. Nested selectors (parent > child)
3. State selectors (`:Hover`, `:Active`, `:Focus`)
4. Inline styles (set directly on nodes in code)

No `!important`. No specificity math. If two rules conflict, the more specific context wins. If equal, last one wins.

## Multi-Inheritance

Styles can extend multiple bases. This is the key feature CSS doesn't have cleanly:

```jss
@Style GlassPill {
  Material: LiquidGlass
  LiquidBrightness: 1.7
  BorderRadius: 100em
  BorderColor: rgba(255, 255, 255, 0.4)
  BorderWidth: 0.1em
}

@Style Interactive {
  Cursor: Pointer
  Transition: Transform 160ms ease

  :Hover {
    Transform: Scale(1.06)
    Background: rgba(255, 255, 255, 0.08)
  }

  :Active {
    Transform: Scale(0.92)
    Background: rgba(255, 255, 255, 0.15)
  }
}

@Style Pressable {
  :Active {
    Transform: Scale(0.96)
    Transition: Transform 100ms ease
  }
}

// Multi-inherit — reads left to right, later bases override earlier
.BackButton : GlassPill, Interactive {
  Width: 3em
  Height: 3em
  BorderRadius: 50%
}

.MenuButton : GlassPill, Interactive, Pressable {
  Padding: 0 1.5em
  Gap: 0.35em
}
```

`@Style` defines a reusable style mixin. The `: Base1, Base2` syntax inherits from multiple bases. Properties are merged left-to-right — if `Interactive` and `Pressable` both define `:Active`, `Pressable` wins because it's listed last.

## Variables

Declared and referenced with a leading `@` — no keyword prefix, the
colon after the name is the signal:

```jss
@ChromePadding: 1.875em
@AppCornerRadius: 4.5em
@GlassTint: rgba(255, 255, 255, 0.4)

.Drawer {
  BorderRadius: @AppCornerRadius - @ChromePadding
  Padding: @ChromePadding
  BorderColor: @GlassTint
}
```

Variables are `@Name` (PascalCase) — distinct from properties (no
prefix) and selectors (`.Name` or `TagName`). Arithmetic uses the
Length parser's `+ - * /` and parens directly (no `calc()` wrapper).

See **`Var.md`** for the full spec: declaration rules, the
`concentric` keyword, built-in identifiers (`Presence`), error
behavior, and implementation milestones.

## Concentric Radii

First-class support — no manual math:

```jss
.AppChrome {
  BorderRadius: 4.5em
  Padding: 1.875em

  .Drawer {
    // Automatically: parent radius - distance from parent edge
    BorderRadius: concentric
  }

  .Drawer .InnerPanel {
    BorderRadius: concentric
    // Computes: Drawer radius - Drawer padding
  }
}
```

`concentric` is a keyword that tells the layout engine to compute the radius from the parent's radius minus the gap. The entire nesting chain resolves automatically.

## Springs

`@Spring` always lives inside a selector — it's a per-class declaration
of how one property animates when its target changes. There's no top-
level `@Spring` form; if you want stylesheet-wide defaults, use a
universal selector (`*`).

Animation is declarative, not imperative:

```jss
.Panel {
  Width: 10em

  @Spring Width {
    Stiffness: 170
    Damping: 26
    Mass: 1
  }

  // When Width changes, it spring-animates with these params
}

.Card {
  // Shorthand — default spring on all animatable properties
  @Spring * {
    Stiffness: 200
    Damping: 28
  }
}

.ListItem {
  // Per-property springs
  @Spring Opacity { Stiffness: 300, Damping: 30 }
  @Spring Transform { Stiffness: 170, Damping: 22 }
}
```

Entry / exit animations, when a Jiv is added to or removed from the
tree, are driven by a built-in `Presence` identifier on every node.
See
**`Presence.md`** for the full spec: implicit opacity fade by default,
customization via `Presence` arithmetic, `@Spring Presence` overrides.

## Transitions

`@Transition` is the CSS-style shorthand for `@Spring`. It accepts a
familiar `Duration` and translates internally to critically-damped
spring coefficients. Use it when you don't care about the underlying
spring physics and just want "smooth over N milliseconds":

```jss
.Drawer {
  @Transition Width { Duration: 240ms }
  @Transition Opacity { Duration: 180ms, Easing: EaseOut }
}
```

`@Transition` is purely *reactive*. It tunes how a property interpolates
when something else writes a new value (a class swap, an Angular
binding, a hover-state flip, a viewport breakpoint). It never drives
the value itself.

`@Transition` and `@Spring` configure the same underlying spring; the
two forms are interchangeable, pick whichever expresses intent better.
If both are declared on the same property, `@Spring` wins (the more
specific physical declaration overrides the duration shorthand).

## Animations

`@Animation` is the *proactive* counterpart to `@Transition`. Where
`@Transition` smooths a value somebody else writes, `@Animation`
writes the value itself, on a schedule, in a loop.

### Three forms

**Root-level named definition.** A reusable animation profile:

```jss
@Animation Pulse {
  Duration: 1.8s
  Loop: Mirror
  From: PulseDim
  To: PulseBright
}

.PulseDim    { Opacity: 0, Background: rgb(0, 0, 0) }
.PulseBright { Opacity: 1, Background: rgb(34, 34, 34) }
```

`From` and `To` are class references. Stops are resolved at compile
time, the keyframe table is baked into the animation's static config.
Changing the referenced class after the fact does not re-trigger
active animations until the next class apply.

**Application inside a class.** Attaches a named animation to every
instance of the class:

```jss
.LoaderOverlay {
  @Animation Pulse
  @Animation Pulse, FadeIn       // multiple, comma-separated
}
```

**Inline anonymous animation.** Targets one property, declared
directly on the class:

```jss
.LoaderOverlay {
  @Animation Opacity {
    From: 0
    To: 1
    Duration: 1.8s
    Loop: Mirror
  }
}
```

Parser disambiguation: at root level, `@Animation Identifier { ... }`
defines a named animation. Inside a class, `@Animation Identifier`
without a block applies a named animation; `@Animation PropertyName { ... }`
with a block declares an inline anonymous animation on that property.

### Stops beyond two

For animations with more than two stops, drop `From` / `To` and use
percent stops. Each stop is either a class reference (shorthand for
"all properties from this class") or an inline property block:

```jss
@Animation Wave {
  Duration: 2s
  Loop: Repeat

  0%: WaveLow              // class-ref shorthand
  50% { Opacity: 0.7 }     // inline ad-hoc
  100%: WaveHigh
}
```

### Loop modes

| Mode | Behavior |
| --- | --- |
| `Once` | Play 0% to 100% and settle. Default if `Loop` is omitted. |
| `Repeat` | At 100%, jump back to 0% and replay forward. Discontinuous. |
| `Mirror` | At 100%, reverse direction back to 0%. Smooth ping-pong. |

`Duration` is one-direction travel time, not the full cycle. A `Mirror`
animation with `Duration: 1.8s` has a 3.6s full cycle.

### Ease and spring tuning

By default, `@Animation` uses the spring engine, the same physics that
drives `@Transition` and `@Spring`. If the class declares an `@Spring`
or `@Transition` for the animated property, the animation inherits those
coefficients. Explicit override on the animation:

```jss
@Animation Pulse {
  Duration: 1.8s
  Loop: Mirror
  Ease: Spring(Stiffness: 60, Damping: 22)   // custom spring
  // or
  Ease: Linear                                // no spring, exact metronome
  From: PulseDim
  To: PulseBright
}
```

`Ease: Linear` exists as the escape hatch for cases where physics is
wrong (a strict beat, a UI loading bar). The default and the right
answer for almost everything is `Spring`.

### Precedence

When two animations target the same property on the same Jiv, highest
specificity wins:

1. **Inline anonymous animation** declared on the class.
2. **Named animation applied** to the class. Last-declared wins among
   multiple.
3. **`@Transition` or `@Spring`** declared on the same property.
   Contributes spring tuning only; doesn't drive a loop.
4. **Static class value.** The property's resolved value when no
   animation is active.

Source-order last-wins within a tier. This mirrors the cascade Jaui
already uses for multi-inheritance.

### Driver model

Each Jiv instance gets its own per-property spring state. Animations
are not coalesced across instances, so 100 marchers with `@Animation
Pulse` run 100 independent springs. This keeps animations independent
under stagger, hover overrides, and per-instance Presence transitions.
If app-wide synchronized motion across many instances becomes a real
need, a `Sync: true` flag can be added later, opt-in.

### Relationship to `@Transition`

| Concept | Drives values? | Loops? | Form |
| --- | --- | --- | --- |
| `@Spring` | No, tunes spring | No | Per-property block |
| `@Transition` | No, tunes spring | No | Per-property block, Duration sugar |
| `@Animation` | Yes | Yes | Named or inline, From / To / stops, Loop |

`@Transition` answers "*how* should this property interpolate when
written?". `@Animation` answers "*what values* should this property
cycle through, and how often?". They compose: an `@Animation`'s
interpolation tuning falls back to the `@Transition` declared on the
same property if no explicit `Ease` is set.

## Materials

Materials are first-class values, not a bag of filter hacks:

```jss
.Toolbar {
  Material: LiquidGlass
  LiquidBrightness: 1.7
  LiquidBlur: 3em
  LiquidSaturation: 1.25
}

.PageBackground {
  Material: SolidGlass
  SolidTint: rgba(28, 28, 30, 0.82)
}

.Hero {
  Material: LiquidGlass
  Refraction: 4.5em        // dome/bevel thickness
  SurfaceBulge: 2.25       // dome intensity
}
```

The renderer reads the material type and dispatches to the appropriate shader. No CSS `backdrop-filter` chains, no SVG filters.

## Progressive Blur

One property:

```jss
.TopBlur {
  BlurGradient: to bottom
  BlurStrength: 60px
  BlurFeather: 250px
}
```

Renders as a single shader pass. Not 7 stacked layers.

## States

Built-in states, cleaner than CSS pseudo-classes:

```jss
.Button {
  Background: rgba(255, 255, 255, 0.06)

  :Hover {
    Background: rgba(255, 255, 255, 0.12)
    Transform: Scale(1.04)
  }

  :Active {
    Background: rgba(255, 255, 255, 0.16)
    Transform: Scale(0.96)
  }

  :Focus {
    BorderColor: rgba(100, 149, 237, 0.6)
    BorderWidth: 0.15em
  }

  :Disabled {
    Opacity: 0.3
    Cursor: Default
  }
}
```

## Responsive

Breakpoints are part of the style, not detached media queries:

```jss
.Drawer {
  // Default (mobile-first)
  Position: Fixed
  Bottom: @ChromePadding
  Left: @ChromePadding
  Right: @ChromePadding
  Height: min(60vh, 30em)
  BorderRadius: concentric

  @If Width > 900 {
    // Wide layout
    Top: calc(@ChromePadding + 3em + @ChromePadding)
    Left: auto
    Width: clamp(16em, 28vw, 24em)
    Height: auto
  }
}
```

`@If` replaces media queries. Conditions reference the viewport or the element itself (`@If Self.Width > 300`).

## Usage in Angular

```html
<jaui-canvas stylesheet="app.jss">
  <panel class="Toolbar">
    <panel class="BackButton" (Tap)="GoBack()">
      <text>Back</text>
    </panel>
    <text class="Title">Library</text>
  </panel>
</jaui-canvas>
```

```jss
/* app.jss */

@ChromePadding: 1.875em

.Toolbar : GlassPill {
  Direction: Row
  Align: Center
  Gap: 0.75em
  Padding: @ChromePadding
}

.BackButton : GlassPill, Interactive {
  Width: 3em
  Height: 3em
  BorderRadius: 50%
}

.Title {
  FontWeight: 600
  FontSize: 1.0625em
  Color: white
}
```

The Angular component references a `.jss` file. Jaui parses it at build time (Vite plugin) or runtime, builds a style tree, and applies it to the render graph. No CSS-in-JS, no style encapsulation hacks — just a file that describes how things look.

## Angular Integration: JSS + CSS Bridge

JSS is the first-class styling language. CSS exists as a compatibility bridge for migrating from DOM-based UI (Jiv) to canvas-based UI (Jaui).

### Primary path: JSS via Vite plugin

A Vite plugin transforms `.jss` files at build time into parsed style tree modules. Angular components import them directly:

```typescript
@Component({
  selector: 'toolbar',
  template: `
    <jaui-canvas [Stylesheet]="Styles">
      <panel class="Toolbar">
        <panel class="BackButton" (Tap)="GoBack()">
          <text class="Glyph">chevron.left</text>
        </panel>
        <text class="Title">{{ PageTitle() }}</text>
      </panel>
    </jaui-canvas>
  `,
})
export class ToolbarComponent {
  readonly Styles = ToolbarStyles; // imported from compiled .jss
}
```

The plugin outputs a typed object — not a CSS string. The Jaui canvas consumes it directly. Angular's style pipeline is not involved.

### Compatibility bridge: CSS custom properties

During migration, some pages will be hybrid — DOM content alongside Jaui canvas. For these, Jaui.Angular can read CSS custom properties as a fallback so existing Angular CSS/SCSS continues to work:

```scss
// Existing Angular SCSS — still works during migration
.Toolbar {
  --jaui-material: LiquidGlass;
  --jaui-border-radius: 1.5em;
  --jaui-liquid-brightness: 1.7;
  --jaui-direction: row;
  --jaui-gap: 0.75em;
}
```

Jaui.Angular reads `--jaui-*` properties from the DOM element and maps them to the render tree. This is the same pattern Jiv uses today with `--border-radius`, `--backdrop`, etc. — just with a `jaui-` namespace.

This bridge exists for migration only. Once a component is fully on Jaui, it should use `.jss` files directly.

### The pipeline

```
New work:     .jss → Vite plugin → style tree → Jaui canvas
Migration:    .css → DOM → --jaui-* properties → Jaui.Angular bridge → Jaui canvas
End state:    .jss everywhere, CSS bridge removed
```

## File Extension

`.jss` — Jack's Style Sheet. Parsed by Jaui's style engine, not the browser's CSS parser.
