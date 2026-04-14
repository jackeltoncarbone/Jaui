# Jiv Shape — The Master SDF Bible

This is the source of truth for how a Jiv is *shaped*. Anything visual about a Jiv (fill, border, shadow, refraction, lighting) samples the SDF defined here. If a shader effect looks wrong at an edge, the answer is almost always in this document, not in the effect.

Companion to `AppleLiquidGlass.md` (the material), and the direct input to `src/Jiv/Shaders/Jiv.Panel.frag::ShapeSDF`.

---

## Constraint: one family, one formula

Every Jiv — rect, pill, circle, squircle, button, card, tab bar, sheet — is the **same shape family**. We do not special-case pills with a capsule SDF and rects with a superellipse SDF. That fragmentation produced the exact bug we just fixed: effects behaved differently on different shapes because the SDF behaved differently, and every new effect had to reason about four modes separately.

One formula, three presets via different parameter values.

## The family: superellipse corners with anisotropic semi-axes

A Jiv is a rectangle whose four corners are each replaced with a **superellipse arc**. The corner's shape is specified by:

- `(rx, ry)` — horizontal and vertical semi-axes of the corner (usually equal; not always)
- `n` — the superellipse exponent

The corner's boundary, in corner-local coordinates `(qx, qy)` where `(0, 0)` is the inner edge of the flat zone and `(rx, ry)` is the corner's outermost point:

```
(|qx| / rx)^n + (|qy| / ry)^n = 1
```

**Shape fills its bbox.** At `(rx, 0)` on the boundary, the global `|px| = halfX`. At `(0, ry)`, `|py| = halfY`. So the corner touches the bounding rectangle's edges at the expected places. No dead space, no shadow slivers.

## Three presets

| Preset | `rx` | `ry` | `n` | Notes |
|---|---|---|---|---|
| **Rect**   | `cornerRadius` | `cornerRadius` | `2 + 6·s` | Standard rounded rect. `s ∈ [0,1]` is the Apple-style smoothing knob. `s=0` → circular corner (`n=2`). `s=0.6` → Apple iOS squircle (`n≈5.6`). |
| **Pill**   | `1.6236 · b` | `b` (= short halfSize) | `2.55` | Show Studio's Bezier pill reproduced as a stretched squircle. `b` is whichever half-extent is smaller (the pill's "radius" axis). |
| **Circle** | `min(halfX, halfY)` | `min(halfX, halfY)` | `2` | Degenerates to a pure ellipse/circle when `halfX = halfY`. |

The mode is auto-detected from aspect ratio + corner radius (see *Classification* below). Apps can also specify a mode explicitly.

## Where `1.6236` comes from (Show Studio pill derivation)

Show Studio's `GeneratePillPath` builds each endcap from **3 cubic Béziers**. In its unscaled reference pill (height = 50, half-height = 25):

```
left endcap control points (local x):
  cp1   = -15.3
  cp2   = -27.2
  curve = -34.85
  tip   = -42.5    ← control-box edge (never reached by the curve itself)
```

The middle Bezier of the endcap runs from `(-34.85, 9)` to `(-34.85, 41)` with control points `(-42.5, 18)` and `(-42.5, 32)`. Evaluating at `t = 0.5`:

```
B(0.5) = 0.125·P₀ + 0.375·CP₁ + 0.375·CP₂ + 0.125·P₁
       = 0.125·(-34.85, 9) + 0.375·(-42.5, 18)
       + 0.375·(-42.5, 32) + 0.125·(-34.85, 41)
       = (-40.59, 25)
```

The curve's maximum leftward extent is **40.59**, not 42.5. The `42.5` is the *control-box width*, which is approximately 1.7× `halfY` (25), but the actual silhouette only reaches `maxExtent / halfY = 40.59 / 25 ≈ 1.6236` × `halfY`.

This is the SS pill's "personality": each endcap extends 62% further horizontally than a semicircle would, while still tapering to zero horizontal extent at the flat edges. That stretch is why the pill doesn't look like a gym-ball capsule — it has the iOS-esque *fullness* at the middle.

## Where `n = 2.55` comes from

Fit the SS Bezier endcap to a superellipse with `a = 40.59, b = 25`:

```
superellipse:  (x/a)^n + (y/b)^n = 1
at y=0:  x = a = 40.59   (matches SS maxExtent) ✓
at y=25: x = 0           (matches SS tangent point) ✓
at y=16: SS x = 34.85  →  (34.85/40.59)^n + (16/25)^n = 1
                           0.859^n + 0.64^n = 1
```

Solving numerically:
- `n = 2.0`: 0.738 + 0.410 = 1.148 (too round)
- `n = 2.5`: 0.684 + 0.327 = 1.011 (very close)
- `n = 2.55`: 0.679 + 0.319 = 0.998 (~perfect)
- `n = 3.0`: 0.634 + 0.262 = 0.896 (too square)

`n = 2.55` reproduces the SS Bezier endcap to pixel accuracy (maximum deviation ~0.5 px on a 60-tall pill).

## Why the anisotropic parameterization

A standard "capsule" SDF treats the pill as a rounded rectangle where the corner radius equals `halfY`:

```
(qx/halfY)^2 + (qy/halfY)^2 = 1   (circle corner, isotropic semi-axes)
```

Problem: with `rx = ry = halfY`, the endcap's horizontal extent equals `halfY` (it's a semicircle). The flat zone runs from `|px| = halfY` inward. The shape's total width is `2·flatZoneLength + 2·halfY`. For SS's pill we want the endcap to extend `1.6236·halfY`, not `halfY`. So we have to decouple `rx` from `ry`.

With `rx = 1.6236·halfY, ry = halfY, n = 2.55`:
```
(qx/(1.6236·halfY))^n + (qy/halfY)^n = 1
```

- At `qy = 0`: `qx = 1.6236·halfY`. Endcap extends correctly.
- At `qy = halfY`: `qx = 0`. Shape tangentially joins the flat top/bottom.
- Curvature matches SS's fit (`n = 2.55`).
- Flat zone: `halfX > 1.6236·halfY` for a flat zone to exist. A pill of width less than `3.25·halfY` degenerates into a pure superellipse (which is fine — it continuously becomes the circle case).

## Apple rects — why `s = 0.6` → `n ≈ 5.6`

Apple's continuous rectangle corners are **arc + G2 cubic Béziers**, not a superellipse. But the visible silhouette of Apple's corners is very close to `n ≈ 5` (a quintic superellipse).

Figma reverse-engineered the Apple iOS preset as smoothing = 60%. Our mapping:
```
n = 2 + 6·s
```
- `s = 0`   → `n = 2`    (classical circular corner)
- `s = 0.5` → `n = 5`    (Apple-like squircle)
- `s = 0.6` → `n = 5.6`  (Figma iOS preset)
- `s = 1.0` → `n = 8`    (very square)

For a Jiv styled as a "standard rect", `Smoothness: 0.6` (our default) places the visible silhouette in Apple's neighborhood.

## The approximate SDF

A true perpendicular-distance SDF to a superellipse curve has no closed form for general `n`. We use the **normalized implicit function** approximation:

```
F     = L − 1,   where  L = ((qx/rx)^n + (qy/ry)^n)^(1/n)
dist  ≈ F / |∇L_physical|
```

`L` is the `L^n`-norm of the normalized corner vector. On the boundary, `L = 1`.

### Gradient derivation

```
L = ((qx/rx)^n + (qy/ry)^n)^(1/n)

∂L/∂qx = (1/n) · ((qx/rx)^n + (qy/ry)^n)^(1/n − 1) · n · (qx/rx)^(n−1) · (1/rx)
       = L^(1−n) · (qx/rx)^(n−1) / rx
       = L^(1−n) · u^(n−1) / rx      where u = qx/rx

∂L/∂qy = L^(1−n) · v^(n−1) / ry      where v = qy/ry

|∇L|² = L^(2(1−n)) · ( u^(2(n−1))/rx² + v^(2(n−1))/ry² )
```

On the boundary `L = 1`, so the `L^(1−n)` factor vanishes and:
```
|∇L| = sqrt( u^(2(n−1))/rx² + v^(2(n−1))/ry² )
```

This is **finite, smooth, and well-defined everywhere on and around the boundary**. No divergent derivatives. This is the key property the previous `ApplePillSDF` lacked.

### Accuracy

The approximation is exact on the boundary (dist = 0) and first-order correct nearby (error is `O(δ²)` for a point `δ` from the boundary). Far-field accuracy degrades but we only use the SDF for:
- Antialiased alpha masking (within `±0.5 px` of the boundary — exact)
- Bezel refraction band (within `bezelWidth` of the boundary — near-exact)
- Edge lighting rim (within `rimBand` of the boundary — near-exact)
- Border stroke (within `borderWidth` — exact)
- Drop shadow (offset SDF — uses same function, same accuracy profile)

For hit testing, we don't use the SDF directly — we do an exact inside/outside test by evaluating the implicit function F and checking sign. Accurate for any query point.

## Classification logic

```
minHalf = min(halfX, halfY)
maxHalf = max(halfX, halfY)
aspect  = maxHalf / minHalf
minRadius = min(tl, tr, br, bl)

if aspect < 1.43 && minRadius ≥ minHalf · 0.9:     CIRCLE   (rx = ry = minHalf, n = 2)
if aspect ≥ 1.3  && minRadius ≥ minHalf − 1:       PILL     (rx = 1.6236·b, ry = b, n = 2.55)
else:                                               RECT     (rx = ry = minRadius, n = 2+6s)
```

The two modes overlap slightly (aspect 1.3–1.43 with saturated radius). Priority: circle wins if both conditions are met, so near-square shapes with max-radius become circles.

## What this unlocks

Every shader effect now gets a single, consistent interface:
- **Fill mask**: `smoothstep(-0.5, 0.5, dist)` — one-liner antialiasing for any shape.
- **Border**: `smoothstep(-0.5, 0.5, dist + borderWidth) − smoothstep(-0.5, 0.5, dist)` — concentric ring; the inner radius adjusts per-corner automatically because it's the same SDF with a shifted iso-contour.
- **Refraction bezel**: `edgeDist = max(-dist, 0)` — works for any shape. The bezel hump formula doesn't care whether it's a pill or a rect.
- **Edge lighting**: samples along the gradient direction (`-ShapeGrad(p, ...)`), which is the correct outward normal everywhere.
- **Shadow**: evaluate `ShapeSDF(p - shadowOffset, ...)` — shifted SDF, same function, correct shape-matching shadow.
- **Concentric inner elements**: Apple's `ConcentricRectangle` rule (`r_inner = max(r_outer − gap, 0)`) falls out naturally because the SDF's iso-contours are visually "inward-offset" versions of the shape.

## Non-goals (for now)

- **Per-corner `(rx, ry)` asymmetry** — e.g., top-left could be an ellipse while bottom-right is a circle. The SDF formulation supports it trivially (pick `rAxis` per quadrant), but no current use case needs it. Add if iOS sheet corners or similar requires it.
- **True perpendicular-distance SDF**. The approximation is good enough for our band-limited effects. If we ever want a true PSDF (for a generic marching-cubes-like algorithm), use ray marching with Newton iteration to converge to the actual nearest point.
- **Explicit Bezier rendering**. Apple technically uses arc + G2 Beziers; we match the *silhouette* via superellipse fit. If pixel-for-pixel Apple-icon reproduction ever matters, we can add a Bezier evaluator as a fourth mode — but the superellipse fit is within 1 px of Apple's actual masks and is GPU-cheap.

## Testing checklist

A shape audit passes when, for each of Rect / Pill / Circle:
1. The fill mask is antialiased with no corner artifacts.
2. The border is a constant visual width all around.
3. The drop shadow matches the shape (same silhouette offset).
4. The bezel refraction band wraps continuously around the perimeter (no dark halos at endcaps or corners).
5. The edge light sweeps smoothly around the perimeter without kinks.
6. At extreme aspect ratios (10:1 pills, etc.), no effects break.
7. At tiny sizes (10 px), the shape degrades gracefully without NaN or `pow(0, n)` artifacts.

Visual parity tests live in `tests/PillShape.test.ts` and the Playwright snapshots under `tests/*.snapshot.ts` (once those exist).

## Source of truth files

- `src/Jiv/Shaders/Jiv.Panel.frag` — `ShapeSDF`, `ShapeGrad`, `ShapeMode` (must stay in sync with this doc)
- `tests/PillShape.test.ts` — CPU-side verifier of the same math, used for test-driven SDF changes
- `Research/AppleLiquidGlass.md` — the material (what's *painted* on top of the shape)
- `show-studio/ShowStudio.Web/src/Libraries/Jwift/Jiv/Jiv.ts::GeneratePillPath, GenerateSuperellipsePath` — the original Bezier implementation we derived `1.6236` and `n = 2.55` from

If you change the shape math, update this doc first, then the shader, then the tests. The doc is the lead.
