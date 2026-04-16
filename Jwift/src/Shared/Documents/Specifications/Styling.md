# Jack's Style Sheets (.jss)

A purpose-built style language for Jwift. Cascading, multi-inheritance, and every property maps directly to a GPU rendering primitive. No browser CSS parser, no vendor prefixes, no compositor hacks.

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
@style GlassPill {
  Material: LiquidGlass
  LiquidBrightness: 1.7
  BorderRadius: 100em
  BorderColor: rgba(255, 255, 255, 0.4)
  BorderWidth: 0.1em
}

@style Interactive {
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

@style Pressable {
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

`@style` defines a reusable style mixin. The `: Base1, Base2` syntax inherits from multiple bases. Properties are merged left-to-right — if `Interactive` and `Pressable` both define `:Active`, `Pressable` wins because it's listed last.

## Variables

Typed variables with defaults:

```jss
@var ChromePadding: 1.875em
@var AppCornerRadius: 4.5em
@var GlassTint: rgba(255, 255, 255, 0.4)

.Drawer {
  BorderRadius: calc(@AppCornerRadius - @ChromePadding)
  Padding: @ChromePadding
  BorderColor: @GlassTint
}
```

Variables are `@name` — distinct from properties (no prefix) and selectors (`.name` or `TagName`).

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

Animation is declarative, not imperative:

```jss
.Panel {
  Width: 10em

  @spring Width {
    Stiffness: 170
    Damping: 26
    Mass: 1
  }

  // When Width changes, it spring-animates with these params
}

.Card {
  // Shorthand — default spring on all animatable properties
  @spring * {
    Stiffness: 200
    Damping: 28
  }
}

.ListItem {
  // Per-property springs
  @spring Opacity { Stiffness: 300, Damping: 30 }
  @spring Transform { Stiffness: 170, Damping: 22 }
}
```

Entry / exit animations — when a Jiv is added to or removed from the
tree — are driven by a built-in `@Presence` variable on every node. See
**`Presence.md`** for the full spec: implicit opacity fade by default,
customization via `@Presence` arithmetic, `@spring Presence` overrides.

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

  @when Width > 900 {
    // Wide layout
    Top: calc(@ChromePadding + 3em + @ChromePadding)
    Left: auto
    Width: clamp(16em, 28vw, 24em)
    Height: auto
  }
}
```

`@when` replaces media queries. Conditions reference the viewport or the element itself (`@when Self.Width > 300`).

## Usage in Angular

```html
<jwift-canvas stylesheet="app.jss">
  <panel class="Toolbar">
    <panel class="BackButton" (Tap)="GoBack()">
      <text>Back</text>
    </panel>
    <text class="Title">Library</text>
  </panel>
</jwift-canvas>
```

```jss
/* app.jss */

@var ChromePadding: 1.875em

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

The Angular component references a `.jss` file. Jwift parses it at build time (Vite plugin) or runtime, builds a style tree, and applies it to the render graph. No CSS-in-JS, no style encapsulation hacks — just a file that describes how things look.

## Angular Integration: JSS + CSS Bridge

JSS is the first-class styling language. CSS exists as a compatibility bridge for migrating from DOM-based UI (Jiv) to canvas-based UI (Jwift).

### Primary path: JSS via Vite plugin

A Vite plugin transforms `.jss` files at build time into parsed style tree modules. Angular components import them directly:

```typescript
@Component({
  selector: 'toolbar',
  template: `
    <jwift-canvas [Stylesheet]="Styles">
      <panel class="Toolbar">
        <panel class="BackButton" (Tap)="GoBack()">
          <text class="Glyph">chevron.left</text>
        </panel>
        <text class="Title">{{ PageTitle() }}</text>
      </panel>
    </jwift-canvas>
  `,
})
export class ToolbarComponent {
  readonly Styles = ToolbarStyles; // imported from compiled .jss
}
```

The plugin outputs a typed object — not a CSS string. The Jwift canvas consumes it directly. Angular's style pipeline is not involved.

### Compatibility bridge: CSS custom properties

During migration, some pages will be hybrid — DOM content alongside Jwift canvas. For these, Jwift.Angular can read CSS custom properties as a fallback so existing Angular CSS/SCSS continues to work:

```scss
// Existing Angular SCSS — still works during migration
.Toolbar {
  --jwift-material: LiquidGlass;
  --jwift-border-radius: 1.5em;
  --jwift-liquid-brightness: 1.7;
  --jwift-direction: row;
  --jwift-gap: 0.75em;
}
```

Jwift.Angular reads `--jwift-*` properties from the DOM element and maps them to the render tree. This is the same pattern Jiv uses today with `--border-radius`, `--backdrop`, etc. — just with a `jwift-` namespace.

This bridge exists for migration only. Once a component is fully on Jwift, it should use `.jss` files directly.

### The pipeline

```
New work:     .jss → Vite plugin → style tree → Jwift canvas
Migration:    .css → DOM → --jwift-* properties → Jwift.Angular bridge → Jwift canvas
End state:    .jss everywhere, CSS bridge removed
```

## File Extension

`.jss` — Jack's Style Sheet. Parsed by Jwift's style engine, not the browser's CSS parser.
