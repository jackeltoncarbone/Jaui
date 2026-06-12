# Semantics — the SEO / Accessibility Mirror

Jaui renders to canvas, so crawlers and screen readers see nothing — and
Chromium doesn't count WebGPU canvas paints as contentful, so Lighthouse
reports NO_FCP and refuses to score any category. The semantic mirror fixes
all of it with one mechanism: a **painted DOM underlay beneath the canvas**,
projected by the Angular layer from the same inputs that drive the canvas.

The mirror's text paints during boot, before the canvas's first WebGPU frame
(a blank canvas is not contentful) — so it IS the first contentful paint,
which unlocks Lighthouse. After boot the opaque canvas covers it; steady-state
cost is ~zero (a static composited layer). The brief boot flash is styleable
as a loading skeleton via `--jaui-seo-bg` / a consumer rule on `.JauiSemantics`.
The mirror is deliberately NOT aria-hidden: one mirror, two consumers —
crawlers and the accessibility tree.

## Architecture: main-thread projection

Everything needed lives on the Angular main thread — text inputs, JSS class
resolution, image URLs (in `Background: Url(...)`), the parent-discovery
chain, visibility. Nothing crosses the worker bridge; the render engine never
sees semantic data (`Semantics` is stripped from style bags before ops ship,
in both Jaui.Angular `Jiv._buildOptions` and Jwift `JivHost._buildOpts`).

The slice lives in `Jaui.Angular/src/Seo/`:
- **`Seo.Types.ts`** — `SemanticRole`, `ResolvedSemantics`, `JAUI_NAVIGATE`.
- **`Seo.Resolve.ts`** — pure precedence resolver (vitest-covered).
- **`Semantic.Mirror.ts`** — per-`<jaui>` service owning the underlay root.
  Jivs register entries parented to their parent Jiv's entry; container roles
  (`a`, `button`, `nav`, `main`, `section`, `ul`, `li`) CONTAIN descendants'
  mirror nodes (hosts are display:contents, so containment cannot come from
  in-place DOM nesting). Placement + document-order sorting happen on a
  microtask flush via `compareDocumentPosition` — late `@if`/`@for` mounts
  land in authored order.

## Opt-in, and who owns what

**Nothing projects until declared.** Roles are never inferred from font size.

- **JSS owns the common case** — the type scale IS the hierarchy:

  ```
  HeroTitle {
    Semantics: Heading 1
    FontSize: 36pt
  }
  CardName {
    Semantics: Heading 3
  }
  TextBody {
    Semantics: Paragraph
  }
  ```

  Bare `Heading` defaults to h2. Roles: `Heading [1-6]`, `Paragraph`, `Label`
  (span), `Link`, `Button`, `Image`, `List`, `ListItem`, `Navigation`, `Main`,
  `Section`, `None`.

- **Template inputs override**: `semantics`, `level`, `href`, `alt`, `label`
  on `jiv`/`jext`/`jimage`. Declarations also imply roles: `href` ⇒ Link,
  `alt` + image background ⇒ Image.

- **The consumer owns the cascade**: `seo` input on any jiv flips projection
  for its subtree (inherited through the parent chain; `<jaui [seo]>` is the
  root default, true). The drill editor sets `[seo]="false"` on its workspace.

- **Jwift (future)**: its typographic presets carry `Semantics:` declarations,
  so Jwift-authored UI is effectively automatic — the opt-in moves into the
  preset layer. Jwift's JivHost already strips the key; mirror registration
  for Jwift hosts is the integration milestone (tab bars etc. project then).

## `href` unifies behavior and crawl graph

`<jiv [href]="'/store/item/3'">` projects a real `<a href>` (the crawlable
link graph) AND navigates on canvas tap through the `JAUI_NAVIGATE` injection
token (consumers provide a Router-backed factory; fallback `location.assign`).
The canvas click first dispatches the synthetic DOM click — a handler calling
`preventDefault()` suppresses the navigation. Mirror anchors carry a
preventDefault+navigate listener and `tabindex="-1"` (focus order is the
positional-sync milestone).

## Dev / test surface

- `window.__jauiSemantics()` — serialized mirror HTML (Playwright/benchmark).
- `npx vitest run Seo` in `Jaui.Angular/` — resolver + mirror suites (jsdom,
  no worker).
- The consuming app's SEO benchmark (`npm run seo` in ShowStudio.App) measures
  the result end to end: h1 count, link graph, Lighthouse categories.

## Later milestones

- Positional sync: mirror nodes track layout rects for screen-reader focus /
  touch exploration; real tab order.
- Jwift host integration (presets project automatically).
- Vanilla (non-Angular) consumers need an engine-side projector — out of
  scope while all consumers are Angular.
