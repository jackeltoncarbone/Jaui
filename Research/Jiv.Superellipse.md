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
| **Pill**   | (polyline)   | (polyline) | (polyline) | Show Studio's actual 3-Bezier pill reproduced via 33-point polyline SDF. Pixel-accurate (99.99% match). See `SS_PillSDF` in the shader. |
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

## Pill: polyline SDF instead of closed-form

After exhaustive sweeps (see `tests/Pill.SDF.Match.test.ts`) we found the closed-form
superellipse fit floors out at ~99.66% pixel match with SS's actual Bezier path
regardless of `(rx, n)`. The tightest single-parameter fit is `n = 2.7` at 0.34%
mismatch — but the user requirement is exact match. So the pill mode now uses a
**polyline SDF**:

1. Sample SS's upper-right endcap quarter at 33 normalized `(u, v)` points
   (one-time generation in `tests/Pill.PolylineGen.test.ts`).
2. In the shader, fold query to first quadrant via `abs()`. Flat-zone case is a
   trivial straight-edge SDF in y. Endcap case computes min distance to the
   32 polyline segments, in physical px.
3. Inside test: linear scan of the polyline (sorted by decreasing v) finds the
   bracketing segment, lerps to find boundary `u_b`, compares `qL.x ≤ u_b * maxExtent`.
4. Gradient: vector from closest polyline point to query, normalized, sign-
   flipped if inside.

Result: **99.99%** pixel match across all tested sizes (440×60, 600×80, 120×30, 800×100).

The closed-form analysis below is retained for reference (it still applies to
Rect mode).

## Where `n = 3.0` comes from

Fit the SS Bezier endcap to a superellipse with `a = 40.59, b = 25`. Sampling the Bezier at 7 points and finding the single `n` that minimizes mean squared error across ALL points (not just the single `(0.859, 0.64)` endpoint of Bezier 1):

```
SS Bezier sampled at t = 0.2, 0.4, 0.6, 0.8, 1.0 on Bezier 1, then 0.2, 0.5 on Bezier 2:
  (u, v) = (0.216, 0.997)  (0.411, 0.977)  (0.583, 0.922)
           (0.733, 0.816)  (0.859, 0.640)  (0.949, 0.403)  (1.000, 0.000)

Max deviation from superellipse u^n + v^n = 1 at each n:
  n = 2.0:  0.14 (pure ellipse) — shape visibly undersized in the middle
  n = 2.55: 0.04 — best fit at the single (0.859, 0.64) point, but lacks
                  fullness elsewhere; the visible silhouette has a subtle
                  "hex" feel because the middle of the curve is too tight
  n = 3.0:  0.02 — best overall closed-form fit (within ~0.6 px on a
                  60-tall pill), smooth curvature profile throughout

At `n = 3.0` the superellipse reproduces SS's Bezier to sub-pixel accuracy across
the entire curve. The "hex" artifact of `n = 2.55` is a sign that the middle
of the curve was being under-filled — too high `n` would flatten the sides
further, too low `n` loses the SS pill's characteristic fullness.
```

An even closer fit would use a true numerical distance-to-Bezier evaluator
(polyline tessellation or iq's Newton iteration), but at 0.6 px error on
a display-pixel-accurate fit, the closed form is functionally equivalent
and an order of magnitude cheaper per fragment.

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
