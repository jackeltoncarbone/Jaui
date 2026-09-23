#version 300 es
precision highp float;

in vec2 v_PixelPos;
flat in vec4 v_PanelGeom;      // cx, cy, halfW, halfH
flat in vec4 v_Rot;            // cosθ, sinθ, centerX, centerY — panel rotation basis + pivot
in vec2 v_Local;              // 3D: perspective-correct panel-local coord (undeformed)
flat in float v_Is3D;         // 1.0 ⇒ projective panel — take pLocal from v_Local
flat in vec4 v_Radii;
flat in vec4 v_Tint;
flat in vec4 v_BorderColor;
flat in vec4 v_ShadowColor;
flat in vec4 v_ShadowParams;   // shadowOffX, shadowOffY, shadowBlur, borderWidth
flat in vec4 v_StyleParams;    // borderEdgeAa, smoothness, opacity, brightness (fg)
                               // borderEdgeAa: half-width of border/silhouette feather (physical px)
flat in vec4 v_Grading;        // brightness, saturation, contrast, frostLod
flat in vec4 v_Refraction;     // thickness, free, refractionStrength, free
flat in vec4 v_Lighting;       // lightAngle (rad), bodyTint (signed), lightIntensity, fresnelStrength
flat in vec4 v_Specular;       // specIntensity (edge highlight), specGlow, chromaticAberration, borderFade
flat in vec4 v_RimEdge;        // edgeLightTop, edgeLightBottom, free, free
flat in vec4 v_Outline;        // free, free, clipOffset, clipCount

// ── MATERIAL_FLAT: the backdrop's whole apparatus is excluded, not branched over ──
//
// A uniform branch on a GPU skips the WORK and not the TAX. A program's register footprint and
// instruction size are set by its HEAVIEST path, and that footprint bounds occupancy for every
// pixel the program touches — including the flat ones. MATERIAL_NONE already constant-folds
// `materialType`, but it keeps the two backdrop samplers and the runtime `hasBackdropFilter`
// branch, so a plain gradient band was still shaded by a program that can sample a mipmapped
// pyramid. MATERIAL_FLAT removes that path at COMPILE time: no u_Backdrop, no u_Scene, no
// textureLod, no triDither.
//
// Every guard in this file is a `#if` around a whole statement or declaration. Not one line of
// the flat path's arithmetic is moved, duplicated or rewritten — the flat program is a strict
// DELETION from the same source, which is what makes its output bit-identical by construction
// and what `tests/Flat.Program.test.ts` asserts (flat ⊂ none, as a subsequence).
//
// ── NO_SHAPE_GRADIENT: a BORDERLESS flat panel must not compute the SDF normal it throws away ──
//
// Defined only TOGETHER with MATERIAL_FLAT, and only for a batch every one of whose instances has
// `BorderWidth == 0.0` exactly AND sits on the superellipse leg of the corner field (`pillW == 0`).
// `WebGL2Renderer._batchTakesBorderlessProgram` decides both, off the same packed instance floats,
// with the same expressions.
//
// Under MATERIAL_FLAT nothing reads the normal `ShapeEval` returns, and at BorderWidth 0 the plain
// stroke's output is the EXACT float 0, so the two blends it drives are `x * 1.0 + c * 0.0`: a no-op
// in IEEE for finite x and c. The arithmetic is written out in `tests/Borderless.Program.test.ts`
// and in `Perf/Borderless.Finding.md`.
//
// With the stroke gone the only surviving consumer of the corner field is its DISTANCE, and
// `CornerDist` (below, already used by the clip stack and the shadow pass) returns it without
// `ShapeGrad_inner` — "two pow() calls, a length and a normalize" by this file's own comment —
// and without `SS_PillEval`'s closest-point tracking. The routing's `pillW == 0` term is what
// makes the substitution bit-identical BY INSPECTION: on that leg both functions return
// `ShapeSDF_inner(p, halfSize, vec2(rCorner), n)` off the same `CornerParams`. The pill leg is
// NOT admitted — `SS_PillSDF` and `SS_PillEval` are different function bodies, and a CPU port
// proving their distances bit-equal cannot speak for a GPU compiler's freedom to contract
// `a + t*ab` differently in a loop that also tracks a closest point.
//
// ── THE GLASS PROGRAM'S OWN VARIANT (lane glassreg) ──
//
// Defined only TOGETHER with MATERIAL_GLASS, as a pair, routed by `WebGL2Renderer._glassBatchKind`
// off the packed instance floats, every instance of the batch answering yes or the batch taking the
// full program (and being counted as a fallback).
//
//   GLASS_NO_GLOW       every instance has FresnelStrength exactly +0: the wide rim glow's block
//                       is excluded, so `edgeLightAlpha` / `edgeLightRgb` keep their 0.0 initialisers
//                       where the block would have produced +0 and a finite colour. The composite
//                       stays, and is `r*1 + (+0)` on both sides.
//   GLASS_NO_SPEC       every instance has SpecularIntensity AND SpecularGlow exactly +0: the
//                       highlight is excluded. `spec` would have been +-0, adding and scaling by
//                       nothing.
#if !defined(MATERIAL_FLAT)
// Dual-filter blurred backdrop pyramid (base sigma = u_BaseFrostLod equivalent).
// Mipmapped — each integer LOD above the base ≈ doubles the effective sigma.
// Per-Jiv FrostBlur is mapped to a mipmap LOD offset (`frostLod - u_BaseFrostLod`)
// plus rim-boost LODs. Single textureLod sample per fragment = one real Gaussian,
// no disparate-tier mixing and no ghosting at intermediate values.
uniform sampler2D u_Backdrop;
// Where u_Backdrop's texels sit on screen: `regionUv = screenUv * xy + zw`, identity (1,1,0,0)
// for a pyramid that covers the whole canvas. The pyramid is built at the size of the SURFACE
// that needs it — a card is a 562x430 patch of a 2560x1600 screen — because a canvas-sized
// attachment costs a full load+store per render pass on a tile-based GPU no matter how small
// the scissor. Same texels, same device density; only the address changes. See BackdropRegion
// in Core/Renderer.ts for the derivation and a worked round trip.
uniform vec4 u_BackdropXf;
// Raw scene snapshot — sampled when effective LOD is 0 (no-frost,
// no-refraction) so panels with just BackdropBrightness/Saturation/
// Contrast don't inherit the pyramid's baked-in 1px base blur. This one is ALWAYS canvas-sized,
// so screen UV addresses it directly and u_BackdropXf does not apply to it.
uniform sampler2D u_Scene;
uniform float u_BaseFrostLod;
#endif
uniform vec2 u_Resolution;

// Clip-stack texture — RGBA32F row where each clip occupies 3 texels:
// texel[3i]   = (x, y, w, h)              device pixels
// texel[3i+1] = (rTL, rTR, rBR, rBL)      device pixels
// texel[3i+2] = (smoothness, _, _, _)     unitless (0 = pure circle corners)
uniform sampler2D u_ClipTex;
#if !defined(MATERIAL_FLAT)
// Specular tilt — added to lightDir ONLY for the highlight, not for the
// ambient or the edge light. Canvas-wide, set by pointer or gyro each frame. This
// reproduces Apple's gyro-driven catchlight without sliding the virtual
// "sun" for the rest of the material.
uniform vec2 u_SpecularTilt;
#endif

#if !defined(MATERIAL_FLAT)
// ── ?glass-skip: THE GLASS DRAW PRICED STAGE BY STAGE ──────────────────────────────────────────
//
// ONE uniform bitmask, 0 on every draw the flag did not arm, and 0 on every non-glass draw
// whatever the flag says (`WebGL2Renderer.PanelDrawBatch` uploads it). Each set bit removes exactly
// one stage of the glass fragment and substitutes the cheapest constant that keeps the draw's
// extent, blend and everything else where it was, so a stage arm against `?glass-skip=none` prices
// that one stage. A uniform and not a define: both arms run the SAME compiled program, and the
// only thing that differs between them is which side of a coherent branch every thread takes.
//
// Every gate below is a pure INSERTION -- a dangling `else`, an early `return`, or a brace pair
// around statements whose locals die inside it -- so with the mask at 0 not one expression of the
// glass path is moved or rewritten. The one exception is the Blinn-Phong catchlight, whose three
// composite lines move up past the declarations above them (they read none of them), so the
// catchlight and its own composite sit in one block.
//
// `GlassSkips` is a constant `false` in the non-glass program, so every gate folds away there and
// MATERIAL_NONE compiles to the program it was; MATERIAL_FLAT deletes the whole apparatus. The bit
// values are `Core/Glass.Skip.ts`'s GLASS_SKIP_STAGES, and `tests/Glass.Skip.test.ts` holds the two
// tables to each other. The gates are also why the glass program is fast: the uniform branches
// split its live ranges (`Perf/README`, "THE HEAD CELL").
uniform int u_GlassSkip;
const int GLASS_SKIP_BACKDROP = 1;     // every backdrop tap returns GLASS_SKIP_FLAT
const int GLASS_SKIP_CA       = 2;     // chromatic spread off: the 3-tap fill path becomes 1
const int GLASS_SKIP_RIM      = 4;     // the wide rim glow: its tap and its lighting math
const int GLASS_SKIP_SPECULAR = 8;     // the highlight
const int GLASS_SKIP_SDF      = 32;    // every corner-field evaluation becomes a sharp-rect distance
const int GLASS_SKIP_GRADE    = 64;    // the body grade + tint as identity (the border zone grades under border)
const int GLASS_SKIP_SHADOW   = 128;   // the drop shadow as 0
const int GLASS_SKIP_SKIRT    = 256;   // discard outside the face's padded box, before anything
const int GLASS_SKIP_CLIP     = 512;   // the clip stack as "inside everything"
const vec3 GLASS_SKIP_FLAT = vec3(0.5);
#if defined(MATERIAL_GLASS)
bool GlassSkips(int bit) { return (u_GlassSkip & bit) != 0; }
#else
bool GlassSkips(int bit) { return false; }
#endif

// The `sdf` arm's substitute: the exact distance to the SHARP rectangle of the same half-size, and
// its outward normal. One length and one normalize where the corner field pays up to seven pow()s.
void GlassRectEval(vec2 p, vec2 halfSize, out float distOut, out vec2 gradOut) {
    vec2 q = abs(p) - halfSize;
    vec2 qo = max(q, vec2(0.0));
    float lo = length(qo);
    distOut = lo + min(max(q.x, q.y), 0.0);
    vec2 g = lo > 0.0 ? qo / lo : (q.x > q.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
    gradOut = vec2(p.x < 0.0 ? -g.x : g.x, p.y < 0.0 ? -g.y : g.y);
}

float GlassRectDist(vec2 p, vec2 halfSize) {
    vec2 q = abs(p) - halfSize;
    return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0);
}

// The `skirt` arm's test: is this fragment outside the face's box grown by 2 px plus the border
// feather? A BOX, not the SDF, because the arm exists to price what the outside fragments cost and
// an SDF evaluated to decide that would be the cost it is pricing. The corner pockets between the
// superellipse and the box are therefore NOT cut; `Core/Glass.Skip.ts` counts them apart. The 2 px
// keeps every 2x2 quad that holds a face fragment whole, so `fwidth` on the face never reads a
// discarded neighbour. `pLocal - panelCenter`, computed exactly as main computes it.
bool GlassSkirtCut() {
    vec2 pl;
    if (v_Is3D > 0.5) {
        pl = v_Local;
    } else {
        vec2 r = v_PixelPos - v_Rot.zw;
        pl = vec2(r.x * v_Rot.x + r.y * v_Rot.y, -r.x * v_Rot.y + r.y * v_Rot.x);
    }
    return any(greaterThan(abs(pl), v_PanelGeom.zw + vec2(2.0 + abs(v_StyleParams.x))));
}
#endif

// ── Background fill mode ────────────────────────────────────────────────
// Per-draw uniforms that select what kind of fill paints inside this
// panel's silhouette. The CPU groups panels into batches by mode + bound
// texture / gradient; this uniform tells the fragment which branch to
// take and where to source pixels from.
//
//   0 = Color    — v_Tint solid fill (the default, no texture or stops)
//   1 = Image    — sample u_BgTexture using u_BgUv (Cover/Contain CPU-
//                  baked transform: panelLocal·xy + zw → uv)
//   2 = LinearGradient — angle in u_BgGradParams.x; t = dot(panelLocal, dir)
//   3 = RadialGradient — center in u_BgGradParams.xy, radius in .z; t = dist
//
// A gradient is Gradient.Curve's cubic Hermite spline: knots in u_BgGradPos[i]
// (0..1), premultiplied OKLab + alpha in u_BgGradValue[i], slopes in
// u_BgGradTangent[i]. MAX_BG_GRAD_STOPS matches Jiv.Types.MAX_GRADIENT_STOPS.
#define MAX_BG_GRAD_STOPS 16
// The BOUND of `sampleBgGradient`'s knot loop, and the ONLY thing TWO_STOP_GRADIENT changes.
//
// The uniform ARRAYS above keep all MAX_BG_GRAD_STOPS slots in every variant: `GradientCurveOf`
// always packs a 16-wide Float32Array and `_bindBgPaint` uploads the whole thing, so a narrower
// declaration would be a GL error, not an optimisation. What costs a flat band fragment is the
// LOOP - a trip count the compiler cannot prove, a data-dependent `break`, and three uniform
// arrays indexed by a variable. With the bound at 2 the body runs exactly once, at `i == 1`,
// with constant indices: the compiler unrolls it and the fetches become direct loads.
//
// This is a bound substitution and nothing else. Every expression inside the loop is the same
// text in the same order under both defines, which is what makes the two programs' arithmetic
// identical for the gradients the routing admits (`u_BgGradStopCount <= 2`): at two stops the
// 16-bound loop takes `i == 1` and then leaves through `i > last`, and the 2-bound loop takes
// `i == 1` and then leaves through the bound. Same iteration, same `v`, same everything after.
#if defined(TWO_STOP_GRADIENT)
#define BG_GRAD_LOOP_STOPS 2
#else
#define BG_GRAD_LOOP_STOPS MAX_BG_GRAD_STOPS
#endif
uniform int       u_BgMode;
uniform sampler2D u_BgTexture;
uniform vec4      u_BgUv;            // scale.xy, offset.zw
uniform float     u_BgImageAlpha;    // [0..1] cross-fade between v_Tint
                                     // (placeholder) and the sampled image
uniform vec4      u_BgGradParams;    // LinearGradient: cos(angle), sin(angle), _, _
                                     // RadialGradient: centerX, centerY, radius, _
uniform int       u_BgGradStopCount;
uniform vec4      u_BgGradValue[MAX_BG_GRAD_STOPS];
uniform vec4      u_BgGradTangent[MAX_BG_GRAD_STOPS];
uniform float     u_BgGradPos[MAX_BG_GRAD_STOPS];

out vec4 fragColor;
// `u_PremulOut` was here. It premultiplied this fragment's rgb by its alpha for a `BlendMode: Screen`
// draw, the one blend state whose destination factor (`1 - src*a`) is a product no blend factor forms.
// `BlendMode` and `Screen` are both gone (Core/Lift.ts): every surviving composite state reads a
// STRAIGHT source and takes `SRC_ALPHA`, so this program has one fewer uniform branch and writes the
// same bits it always did on every draw that is not a Screen -- which is now every draw.

#if !defined(MATERIAL_FLAT)
// Triangular-PDF dither — breaks 8-bit banding on smooth blurred backdrops.
// Two hashed uniforms summed give a triangular distribution; amplitude is
// ±1 LSB at 8-bit (invisible as noise, dissolves frost/glass banding).
// THE GLASS DITHER, and the only one MATERIAL_FLAT drops. The GRADIENT dither
// (`gradientNoise`, just below) is a different function on a different path and
// stays byte for byte — a flat gradient band still dithers exactly as it does today.
float triDither(vec2 p) {
    float a = fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
    float b = fract(sin(dot(p + 17.0, vec2(39.3468, 11.135))) * 24634.6345);
    return (a + b - 1.0) / 255.0;
}
#endif

// Interleaved gradient noise at a screen pixel, in [0, 1): a fixed blue-ish pattern tied to the
// framebuffer pixel, so a gradient's dither never crawls while the page scrolls or springs.
float gradientNoise(vec2 pixel) {
    return fract(52.9829189 * fract(dot(pixel, vec2(0.06711056, 0.00583715))));
}

float linearToSrgb(float c) {
    return c <= 0.0031308 ? c * 12.92 : 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}

vec3 oklabToSrgb(vec3 lab) {
    vec3 lms = vec3(
        lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z,
        lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z,
        lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z);
    lms = lms * lms * lms;
    vec3 lin = clamp(vec3(
         4.0767416621 * lms.x - 3.3077115913 * lms.y + 0.2309699292 * lms.z,
        -1.2684380046 * lms.x + 2.6097574011 * lms.y - 0.3413193965 * lms.z,
        -0.0041960863 * lms.x - 0.7034186147 * lms.y + 1.7076147010 * lms.z), 0.0, 1.0);
    return vec3(linearToSrgb(lin.r), linearToSrgb(lin.g), linearToSrgb(lin.b));
}

vec4 sampleBgGradient(float t) {
    // Cubic Hermite through the knots in premultiplied OKLab (slope continuous at every knot),
    // then back to straight sRGB. Edges hold the endpoint knots.
    if (u_BgGradStopCount <= 0) return vec4(0.0);
    int last = u_BgGradStopCount - 1;
    vec4 v = u_BgGradValue[last];
    if (u_BgGradStopCount == 1 || t <= u_BgGradPos[0]) {
        v = u_BgGradValue[0];
    } else {
        for (int i = 1; i < BG_GRAD_LOOP_STOPS; i++) {
            if (i > last) break;
            float p1 = u_BgGradPos[i];
            if (t <= p1) {
                float p0 = u_BgGradPos[i - 1];
                float h = p1 - p0;
                if (h <= 0.0) { v = u_BgGradValue[i]; break; }
                float u = clamp((t - p0) / h, 0.0, 1.0);
                float u2 = u * u;
                float u3 = u2 * u;
                v = (2.0 * u3 - 3.0 * u2 + 1.0) * u_BgGradValue[i - 1]
                  + (u3 - 2.0 * u2 + u) * h * u_BgGradTangent[i - 1]
                  + (-2.0 * u3 + 3.0 * u2) * u_BgGradValue[i]
                  + (u3 - u2) * h * u_BgGradTangent[i];
                break;
            }
        }
    }
    float a = clamp(v.a, 0.0, 1.0);
    if (a < 1e-4) return vec4(0.0);
    return vec4(oklabToSrgb(v.rgb / a), a);
}

// Resolve the fill source color for a fragment based on u_BgMode. Returns
// premul-unaware RGBA — the composite below scales by alpha as needed.
//
// `panelLocal` is [0..1] across the panel's bounding box (origin at the
// top-left corner of the panel rect, not the center). Computed once per
// fragment and passed in so radial/linear gradients and image UV share
// the same coordinate space.
vec4 resolveBgFill(vec2 panelLocal) {
    if (u_BgMode == 1) {
        // Image — UV pre-baked on CPU for Cover/Contain. Default identity
        // when not bound (u_BgUv = (1, 1, 0, 0)).
        vec2 uv = panelLocal * u_BgUv.xy + u_BgUv.zw;
        // Contain bars: out-of-range UV falls back to the placeholder
        // (v_Tint) — the same color we'd be painting if no image were
        // bound, so transparent bars get the right material treatment.
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return v_Tint;
        vec4 img = texture(u_BgTexture, uv);
        // Cross-fade between placeholder and texture over u_BgImageAlpha.
        // First frame an image is bound: alpha=0 → pure v_Tint; one
        // Duration later alpha=1 → pure texture. v_Tint is the placeholder
        // color baked into the `Url(...)` expression, so swapping `[src]`
        // on a card cross-fades through that placeholder instead of
        // popping pixel-for-pixel from old image to new.
        return mix(v_Tint, img, clamp(u_BgImageAlpha, 0.0, 1.0));
    } else if (u_BgMode == 2) {
        // Linear gradient — t = dot(panelLocal − 0.5, direction) + 0.5,
        // clamped to [0, 1]. Direction unit vector is in u_BgGradParams.xy.
        vec2 dir = u_BgGradParams.xy;
        float t = dot(panelLocal - 0.5, dir) + 0.5;
        return sampleBgGradient(clamp(t, 0.0, 1.0));
    } else if (u_BgMode == 3) {
        // Radial gradient — t = dist(panelLocal, center) / radius,
        // clamped to [0, 1]. Center is normalized [0..1], radius too.
        vec2 center = u_BgGradParams.xy;
        float radius = max(u_BgGradParams.z, 0.0001);
        float d = length(panelLocal - center) / radius;
        return sampleBgGradient(clamp(d, 0.0, 1.0));
    }
    // Mode 0 (Color): fall through to v_Tint at the call site.
    return v_Tint;
}

// ────────────────────────────────────────────────────────────────────────────
//  MASTER JIV SDF
//  One family, one formula. The shape is a rectangle with each corner replaced
//  by a superellipse arc. The corner "box" has two semi-axes (rx, ry) and a
//  power n. Boundary: (|qx|/rx)^n + (|qy|/ry)^n = 1.
//
//  Three preset regimes, all via the same formula with different (rx, ry, n):
//    • RECT   — rx = ry = perCornerRadius,  n derived from `smoothness`
//               (s=0 → n=2 circle corner; s=0.6 → n≈5 Apple squircle)
//    • PILL   — rx = 1.6236·halfY, ry = halfY, n = 2.55
//               Semi-axes derived from Show Studio's 3-Bezier endcap fit:
//               maxExtent ≈ 40.59 at halfY=25 → rx/ry = 40.59/25 = 1.6236.
//               Exponent n=2.55 matches the Bezier's full-middle profile
//               (point (0.859, 0.64) on the fitted superellipse).
//    • CIRCLE — rx = ry = min(halfX, halfY), n = 2
//
//  Shape fills its bbox: at (rx, 0) boundary → |px| = halfX, at (0, ry) → |py| = halfY.
//
//  Approximate SDF:   dist = (L − 1) / |∇L_physical|
//                     L    = ((qx/rx)^n + (qy/ry)^n)^(1/n)
//  Analytic gradient is well-defined and finite everywhere — no derivative
//  divergence at endcap tips (the bug in the previous Apple-squircle-pill).
// ────────────────────────────────────────────────────────────────────────────

// Smoothness s ∈ [0,1] → superellipse exponent.
// s = 0:   n = 2        → classical circular corner
// s = 0.5: n ≈ 3.5      → mild squircle
// s = 0.6: n ≈ 4.8      → Apple iOS (Figma "iOS" preset, closest to quintic)
// s = 1:   n = 8        → very square-like
float SmoothnessToExponent(float s) {
    s = clamp(s, 0.0, 1.0);
    return 2.0 + 6.0 * s;
}

// Classify the shape into Rect / Pill / Circle and emit its corner-box (rx, ry)
// and exponent n.
//   radii: per-corner scalar corner radius, used only in Rect mode.
//   Returns 1 if pill, 2 if circle, 0 if rect.
int ClassifyShape(vec2 halfSize, vec4 radii, float smoothness, out vec2 rAxis, out float n) {
    float minHalf = min(halfSize.x, halfSize.y);
    float maxHalf = max(halfSize.x, halfSize.y);
    float aspect = maxHalf / max(minHalf, 0.0001);
    float minRadius = min(min(radii.x, radii.y), min(radii.z, radii.w));

    // Circle: near-square and corner radius fills the short axis
    if (aspect < 1.43 && minRadius >= minHalf * 0.9) {
        rAxis = vec2(minHalf, minHalf);
        n = 2.7;
        return 2;
    }

    // Pill: elongated AND corner radius saturated at short-axis half
    if (aspect >= 1.3 && minRadius >= minHalf - 1.0) {
        // Show Studio pill: rx = 1.6236 · halfY (or halfX if vertical pill), ry = halfY
        // The cornerBox extends halfY × 1.6236·halfY outward from the flat zone.
        // Requires halfX > 1.6236·halfY for a flat zone to exist, which is
        // guaranteed by aspect ≥ 1.3 (near-boundary case just makes flat→0).
        bool horiz = halfSize.x >= halfSize.y;
        float b = horiz ? halfSize.y : halfSize.x;
        float a = 1.6236 * b;
        rAxis = horiz ? vec2(a, b) : vec2(b, a);
        n = 2.7;
        return 1;
    }

    // Rect: per-corner scalar radius, superellipse exponent from smoothness
    rAxis = vec2(minRadius);   // (rx, ry) for the current corner; caller uses ShapeSDF
    n = SmoothnessToExponent(smoothness);
    return 0;
}

// ─── Per-corner resolution of rect mode ───
// In rect mode each of the 4 corners can have its own radius. We pick the
// relevant one based on which quadrant the query point is in.
float PickRectRadius(vec2 p, vec4 radii) {
    // radii = (tl, tr, br, bl)
    return p.x >= 0.0
        ? (p.y <= 0.0 ? radii.y : radii.z)
        : (p.y <= 0.0 ? radii.x : radii.w);
}

// ─── SS PILL POLYLINE ───
// 33 (u, v) sample points along the upper-right endcap quarter of Show Studio's
// 3-cubic-Bezier pill. u = horizontal distance from flat-zone-end / maxExtent
// (0..1), v = vertical distance from horizontal middle / halfY (0..1).
// The points live in Jiv/Pill.Curve.ts and arrive as a UNIFORM, uploaded once per panel program at
// link (WebGL2.Renderer `_preparePanelProgram`). They were a `const vec2[33]` here, which ANGLE
// translates for D3D11 into an HLSL `static` array that FXC compiles as an indexable temporary --
// that array and the fixed 32-trip loop over it were the largest single term of the panel shader's
// compile on Windows (Pill.Curve.ts has the measurement). The loops below read their trip count from
// `u_PillSegments` for the same reason: a constant bound lets FXC write the body out 32 times, and
// the pill is evaluated in three places (shape, shadow, clip stack). Same points, same iterations,
// same order: the arithmetic is unchanged.
const int SS_PILL_POINT_COUNT = 33;
uniform vec2 u_PillCurve[SS_PILL_POINT_COUNT];
uniform int u_PillSegments;

const float SS_PILL_MAXEXTENT = 1.5400; // SS pill max horizontal extent / halfY

// Polyline-based SDF + gradient for the SS pill. Pixel-accurate match to SS's
// GeneratePillPath (within ~0.05 px on a 60-tall pill at 33 sample points).
//
// Folds query to first quadrant via abs(). Distinguishes:
//   - flat zone     (|q.x| ≤ halfX − maxExtent): straight-edge SDF in y
//   - endcap zone   (|q.x| > halfX − maxExtent): min distance to polyline
//
// Single-pass loop: tracks min-distance, closest point, AND bracketing segment
// for inside test in one scan. Bit-exact equivalent to the old two-pass form
// (proven in tests/Pill.SDF.MergedLoop.test.ts across ~715k samples).
#if !defined(NO_SHAPE_GRADIENT)
void SS_PillEval(vec2 p, vec2 halfSize, out float distOut, out vec2 gradOut) {
    bool horiz = halfSize.x >= halfSize.y;
    vec2 q = horiz ? abs(p) : abs(p.yx);
    vec2 hs = horiz ? halfSize : halfSize.yx;
    float halfY = hs.y;
    float halfX = hs.x;
    float maxExtent = SS_PILL_MAXEXTENT * halfY;
    float flatStart = halfX - maxExtent;

    if (q.x <= flatStart) {
        // Flat zone — top/bottom edge is the only boundary in this column
        distOut = q.y - halfY;
        vec2 g = vec2(0.0, sign(p.y));
        gradOut = horiz ? g : g.yx;
        return;
    }

    // Endcap zone — convert to local coords (0,0) at the flat-zone-end + middle
    vec2 qL = vec2(q.x - flatStart, q.y);

    // Single scan: min distance + closest point + bracket-for-inside-test.
    // Bracket short-circuits via `bracketFound` (equivalent to the old loop's
    // `break`); the distance scan still runs to completion to find the true
    // minimum. Polyline is sorted by decreasing v (starts at v=1, ends at v=0),
    // so the first bracketing segment encountered is the correct one.
    float minDSq = 1e9;
    vec2 bestClosest = qL;
    float u_b = -1.0;
    bool bracketFound = false;

    for (int i = 0; i < u_PillSegments; i++) {
        vec2 a = vec2(u_PillCurve[i].x * maxExtent, u_PillCurve[i].y * halfY);
        vec2 b = vec2(u_PillCurve[i+1].x * maxExtent, u_PillCurve[i+1].y * halfY);
        vec2 ab = b - a;
        vec2 ap = qL - a;
        float t = clamp(dot(ap, ab) / dot(ab, ab), 0.0, 1.0);
        vec2 closest = a + t * ab;
        vec2 d = qL - closest;
        float dSq = dot(d, d);
        if (dSq < minDSq) {
            minDSq = dSq;
            bestClosest = closest;
        }
        if (!bracketFound && qL.y <= a.y && qL.y >= b.y) {
            float dv = a.y - b.y;
            float tb = dv > 0.0001 ? (a.y - qL.y) / dv : 0.0;
            u_b = mix(a.x, b.x, tb);
            bracketFound = true;
        }
    }

    float udist = sqrt(minDSq);
    bool inside = qL.y <= halfY && u_b > 0.0 && qL.x <= u_b;
    distOut = inside ? -udist : udist;

    // Outward normal: from closest point on polyline to query, sign-flipped
    // if inside. Restored to original quadrant via sign(p).
    vec2 dg = qL - bestClosest;
    float L = length(dg);
    vec2 g = L > 0.0001 ? dg / L : vec2(1.0, 0.0);
    if (inside) g = -g;
    g.x *= sign(p.x);
    g.y *= sign(p.y);
    gradOut = horiz ? g : g.yx;
}
#endif

// SDF-only entry point — used by shadow pass (no gradient needed).
// Single-pass merged loop like SS_PillEval, minus the closest-point tracking.
float SS_PillSDF(vec2 p, vec2 halfSize) {
    bool horiz = halfSize.x >= halfSize.y;
    vec2 q = horiz ? abs(p) : abs(p.yx);
    vec2 hs = horiz ? halfSize : halfSize.yx;
    float halfY = hs.y;
    float halfX = hs.x;
    float maxExtent = SS_PILL_MAXEXTENT * halfY;
    float flatStart = halfX - maxExtent;

    if (q.x <= flatStart) return q.y - halfY;

    vec2 qL = vec2(q.x - flatStart, q.y);

    float minDSq = 1e9;
    float u_b = -1.0;
    bool bracketFound = false;

    for (int i = 0; i < u_PillSegments; i++) {
        vec2 a = vec2(u_PillCurve[i].x * maxExtent, u_PillCurve[i].y * halfY);
        vec2 b = vec2(u_PillCurve[i+1].x * maxExtent, u_PillCurve[i+1].y * halfY);
        vec2 ab = b - a;
        vec2 ap = qL - a;
        float t = clamp(dot(ap, ab) / dot(ab, ab), 0.0, 1.0);
        vec2 closest = a + t * ab;
        vec2 d = qL - closest;
        minDSq = min(minDSq, dot(d, d));
        if (!bracketFound && qL.y <= a.y && qL.y >= b.y) {
            float dv = a.y - b.y;
            float tb = dv > 0.0001 ? (a.y - qL.y) / dv : 0.0;
            u_b = mix(a.x, b.x, tb);
            bracketFound = true;
        }
    }
    float udist = sqrt(minDSq);
    bool inside = qL.y <= halfY && u_b > 0.0 && qL.x <= u_b;
    return inside ? -udist : udist;
}

// Gradient-only wrapper over SS_PillEval. Kept for API compatibility with
// ShapeGrad dispatch; callers that need both dist and grad should use
// ShapeEval to avoid recomputing the polyline scan.
#if !defined(NO_SHAPE_GRADIENT)
vec2 SS_PillGrad(vec2 p, vec2 halfSize) {
    float d;
    vec2 g;
    SS_PillEval(p, halfSize, d, g);
    return g;
}
#endif

// Master SDF — operates on a shape defined by halfSize + cornerBox (rx, ry) + exponent n.
// qc is the corner-offset vector (positive in the corner region, zero in the flat zone).
float ShapeSDF_inner(vec2 p, vec2 halfSize, vec2 rAxis, float n) {
    // Floor the corner semi-axes: a zero-radius corner (sharp rect, common for
    // overflow clips) would divide by rAxis below. 1e-3 px is a sub-pixel arc —
    // visually a square corner — and keeps the gradient finite.
    rAxis = max(rAxis, vec2(1e-3));
    vec2 q = abs(p) - halfSize + rAxis;

    if (q.x <= 0.0 && q.y <= 0.0) {
        // Inside the flat interior (rectangular box between the 4 corner regions)
        return -min(halfSize.x - abs(p.x), halfSize.y - abs(p.y));
    }

    // At least one component is past the flat boundary — we're in a corner region
    vec2 qc = max(q, vec2(0.0));
    vec2 uv = qc / rAxis;
    // Epsilon-clamped uv for pow(0, x) safety in GLSL ES
    vec2 uvE = max(uv, vec2(1e-5));

    float un = pow(uvE.x, n);
    float vn = pow(uvE.y, n);
    float L = pow(un + vn, 1.0 / n);

    // Gradient magnitude in PHYSICAL (qx, qy) space — not normalized space.
    // L = ((qx/rx)^n + (qy/ry)^n)^(1/n)
    // ∂L/∂qx = L^(1−n) · (qx/rx)^(n−1) / rx  = L^(1−n) · uv.x^(n−1) / rx
    // |∇L|² = L^(2(1−n)) · (uv.x^(2(n−1))/rx² + uv.y^(2(n−1))/ry²)
    float nm1 = n - 1.0;
    float gx = pow(uvE.x, nm1) / rAxis.x;
    float gy = pow(uvE.y, nm1) / rAxis.y;
    float lfactor = pow(L, 1.0 - n);
    float gradLen = lfactor * sqrt(gx * gx + gy * gy);

    return (L - 1.0) / max(gradLen, 1e-5);
}

// Analytic gradient (outward unit normal) of the corner superellipse.
// Direction of ∇F = (uv.x^(n−1)/rx, uv.y^(n−1)/ry), sign from p.
// Magnitude falls out when normalized.
#if !defined(NO_SHAPE_GRADIENT)
vec2 ShapeGrad_inner(vec2 p, vec2 halfSize, vec2 rAxis, float n) {
    rAxis = max(rAxis, vec2(1e-3));
    vec2 q = abs(p) - halfSize + rAxis;
    vec2 qc = max(q, vec2(0.0));
    vec2 uv = qc / rAxis;
    vec2 uvE = max(uv, vec2(1e-5));

    float nm1 = n - 1.0;
    vec2 g = vec2(
        sign(p.x) * pow(uvE.x, nm1) / rAxis.x,
        sign(p.y) * pow(uvE.y, nm1) / rAxis.y
    );

    // Near (qx ≈ 0, qy ≈ 0) — on an edge midpoint where both q components are ~0 —
    // the gradient above is ~0. Fall back to the straight-edge normal: whichever
    // axis has the smaller |halfSize − |p|| is the closest edge, and the normal
    // points outward along that axis.
    float gLen = length(g);
    if (gLen < 1e-4) {
        float dx = halfSize.x - abs(p.x);
        float dy = halfSize.y - abs(p.y);
        return dx < dy
            ? vec2(sign(p.x), 0.0)
            : vec2(0.0, sign(p.y));
    }
    return g / gLen;
}
#endif

// ─── Unified dispatch: classify, then evaluate ───
//   mode 0: Rect    — per-corner scalar radius, superellipse exponent from smoothness
//   mode 1: Pill    — Show Studio stretched squircle endcap (1.6236·halfY × halfY, n=2.55)
//   mode 2: Circle  — full-axis superellipse at n=2
int ShapeMode(vec2 halfSize, vec4 radii) {
    float minHalf = min(halfSize.x, halfSize.y);
    float maxHalf = max(halfSize.x, halfSize.y);
    float aspect = maxHalf / max(minHalf, 0.0001);
    float minRadius = min(min(radii.x, radii.y), min(radii.z, radii.w));
    if (aspect < 1.43 && minRadius >= minHalf * 0.9) return 2;
    if (aspect >= 1.3 && minRadius >= minHalf - 1.0) return 1;
    return 0;
}

// ─── Continuous corner field ───
// The three regimes (Rect / Circle / Pill) used to be a hard 3-way branch, so a
// corner SNAPPED between them at the classification thresholds. This blends them
// over bands instead:
//   • Rect↔Circle is a pure parameter ease — both are the superellipse, so the
//     exponent slides from the Apple squircle (n≈4.8) toward a true circle (n=2)
//     as a square-ish corner's radius fills the short axis.
//   • Rect/Circle↔Pill mixes the superellipse SDF with the fitted Bezier endcap
//     (SS_Pill*) over the band, since the pill is a different evaluation path.
// Endpoints are identical to the old discrete modes (sat∈{0,1}, elong∈{0,1});
// only corners inside a transition band — the ones that used to pop — change.
const float CORNER_SAT_FRAC    = 0.12;  // fraction of the short half-axis the radius morph spans
                                        // (scale-invariant: a tiny card and a huge card snap alike)
// A saturated corner is a circle only when the box is square; anything longer is a capsule with
// semicircle ends and a straight middle, as the iPhone's 78 by 58 tab pill is. The old 1.40 threshold
// drew every short pill as an ellipse.
const float CORNER_ASPECT_LO   = 1.02;  // aspect ≤ LO → circle leg
const float CORNER_ASPECT_HI   = 1.10;  // aspect ≥ HI → pill leg

// The corner field's parameters. Factored out so the distance-only and distance+gradient
// evaluations below read the SAME expressions in the same order and cannot drift into
// disagreeing about which regime a corner is in.
void CornerParams(vec2 p, vec2 halfSize, vec4 radii, float smoothness,
                  out float pillW, out float n, out float rCorner) {
    float minHalf = min(halfSize.x, halfSize.y);
    float maxHalf = max(halfSize.x, halfSize.y);
    float aspect  = maxHalf / max(minHalf, 0.0001);

    // `smoothness` arrives PACKED from the instance buffer: the 0..1 fraction is the smoothness and the
    // whole part is the AUTHORED corner radius in sixteenths of a device pixel. Split them back apart.
    float authoredR  = floor(smoothness * 0.5) / 16.0;
    float smoothAmt  = smoothness - 2.0 * floor(smoothness * 0.5);

    // Saturation of the corner radius against the short axis: 0 → small radius (rect), 1 → radius fills
    // the short axis (circle/pill). Keyed to the AUTHORED radius, never the drawn one: the drawn radius
    // carries the superellipse compensation, which on a shallow box reaches into this band and used to
    // morph a plain rounded rectangle into a capsule. Band is a fraction of minHalf so the morph spans
    // the same proportion at every size; floored at 1px so sub-tiny shapes don't hard-snap.
    float satBand = max(minHalf * CORNER_SAT_FRAC, 1.0);
    float sat   = smoothstep(minHalf - satBand, minHalf - 1.0, authoredR);
    // Which saturated regime the corner eases toward: 0 = circle, 1 = pill.
    float elong = smoothstep(CORNER_ASPECT_LO, CORNER_ASPECT_HI, aspect);

    // Superellipse anchor (Rect↔Circle, continuous). Per-corner radius is
    // preserved via PickRectRadius; the exponent eases to 2 (circle) only for
    // square-ish saturated corners (circleness), never for the pill leg.
    rCorner          = min(PickRectRadius(p, radii), minHalf);
    float circleness = sat * (1.0 - elong);
    n                = mix(SmoothnessToExponent(smoothAmt), 2.0, circleness);
    // Pill leg: only elongated saturated corners pull toward the Bezier endcap.
    pillW = sat * elong;
}

// DISTANCE ONLY. Two of this shader's three corner-field callers — the clip stack (once per
// clip per fragment) and the shadow pass — ask for a distance and throw the gradient away,
// and the gradient is not cheap: ShapeGrad_inner is two pow() calls, a length and a
// normalize, and in pill mode the closest-point tracking turns a 32-segment scan into a
// wider one. This returns the same float with none of that. Same expressions, same order,
// so the number is the one CornerEval would have handed back.
float CornerDist(vec2 p, vec2 halfSize, vec4 radii, float smoothness) {
#if !defined(MATERIAL_FLAT)
    if (GlassSkips(GLASS_SKIP_SDF)) return GlassRectDist(p, halfSize);
#endif
    float pillW, n, rCorner;
    CornerParams(p, halfSize, radii, smoothness, pillW, n, rCorner);
    if (pillW >= 1.0) return SS_PillSDF(p, halfSize);
    float dSuper = ShapeSDF_inner(p, halfSize, vec2(rCorner), n);
    if (pillW <= 0.0) return dSuper;
    return mix(dSuper, SS_PillSDF(p, halfSize), pillW);
}

#if !defined(NO_SHAPE_GRADIENT)
void CornerEval(vec2 p, vec2 halfSize, vec4 radii, float smoothness,
                out float distOut, out vec2 gradOut) {
#if !defined(MATERIAL_FLAT)
    if (GlassSkips(GLASS_SKIP_SDF)) { GlassRectEval(p, halfSize, distOut, gradOut); return; }
#endif
    float pillW, n, rCorner;
    CornerParams(p, halfSize, radii, smoothness, pillW, n, rCorner);
    float dSuper = ShapeSDF_inner(p, halfSize, vec2(rCorner), n);

    // Outside the band (pillW 0 or 1) exactly one path runs; only the band pays
    // for both the superellipse and the polyline pill, then mixes them.
    if (pillW <= 0.0) {
        distOut = dSuper;
        gradOut = ShapeGrad_inner(p, halfSize, vec2(rCorner), n);
        return;
    }
    float dPill; vec2 gPill;
    SS_PillEval(p, halfSize, dPill, gPill);
    if (pillW >= 1.0) {
        distOut = dPill;
        gradOut = gPill;
        return;
    }
    vec2 gSuper = ShapeGrad_inner(p, halfSize, vec2(rCorner), n);
    distOut = mix(dSuper, dPill, pillW);
    gradOut = normalize(mix(gSuper, gPill, pillW));
}
#endif

// Thin wrappers — the discrete `mode` arg is retained for call-site
// compatibility but is no longer used; CornerEval derives the blend from
// geometry so Rect / Circle / Pill morph continuously instead of switching.
float ShapeSDF(vec2 p, vec2 halfSize, vec4 radii, float smoothness, int mode) {
    return CornerDist(p, halfSize, radii, smoothness);
}

#if !defined(NO_SHAPE_GRADIENT)
vec2 ShapeGrad(vec2 p, vec2 halfSize, vec4 radii, float smoothness, int mode) {
    float d; vec2 g;
    CornerEval(p, halfSize, radii, smoothness, d, g);
    return g;
}

// Combined dist + gradient evaluation. Main shape fragments need both; CornerEval
// returns them in one pass (and only double-evaluates inside the pill blend band).
void ShapeEval(vec2 p, vec2 halfSize, vec4 radii, float smoothness, int mode,
               out float distOut, out vec2 gradOut) {
    CornerEval(p, halfSize, radii, smoothness, distOut, gradOut);
}
#endif

// Rec. 709 luma
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// Grade order is contrast, saturation, brightness, whatever order the author wrote them in.
// Contrast compresses the backdrop's range first (the readability guarantee), saturation puts back
// the colour the compression took, and brightness scales LAST, so darkening lands toward black.
// Contrast last pulled a darkened backdrop back up toward its 0.5 pivot: the grey wash.
vec3 applyGrading(vec3 color, float brightness, float saturation, float contrast) {
    color = (color - 0.5) * contrast + 0.5;
    float luma = dot(color, LUMA);
    color = mix(vec3(luma), color, saturation);
    return color * brightness;
}

#if !defined(MATERIAL_FLAT)
// The glass body's neutral pigment, after the grade: negative pulls toward black, positive toward
// white, by |tint|. A mix toward black keeps the hue exactly; there is no grey anywhere on the path.
vec3 applyTint(vec3 color, float tint) {
    return mix(color, vec3(step(0.0, tint)), abs(tint));
}

// Sample the backdrop at this Jiv's frost. A Jiv that authored no frost samples the raw scene
// snapshot (u_Scene), NOT the pyramid: the pyramid's LOD 0 has a ~1px Gaussian baked in, so a flat
// panel with just BackdropBrightness would read subtly blurred. `frostLod` is this Jiv's
// log2(BackdropFrostBlur * DPR). One textureLod call = one Gaussian; one texture call = no filter.
vec3 sampleBackdrop(vec2 uv, float frostLod) {
    if (GlassSkips(GLASS_SKIP_BACKDROP)) return GLASS_SKIP_FLAT;
    float lod = max(0.0, frostLod - u_BaseFrostLod);
    // Every displaced and chromatic tap comes through here, so the region map is applied ONCE:
    // two mads. `uv` stays the screen UV every caller computed, which the u_Scene branch needs.
    vec2 backdropUv = uv * u_BackdropXf.xy + u_BackdropXf.zw;
    // Gate on frostLod, NOT the derived lod: the pyramid is built at the panel's own frost sigma
    // with u_BaseFrostLod == frostLod, so a frosted panel's blur lives at LOD 0 and it must still
    // sample the pyramid.
    if (frostLod < 0.01) return texture(u_Scene, uv).rgb;
    return textureLod(u_Backdrop, backdropUv, lod).rgb;
}
#endif

// ────────────────────────────────────────────────────────────────────────────
//  Clip stack — CSS-style overflow clipping, rounded-rect per ancestor.
// ────────────────────────────────────────────────────────────────────────────

// Signed distance to the rounded-rect clip boundary. Negative inside,
// positive outside, in device pixels. Callers smoothstep this for a 1-pixel
// feather at the clip edge instead of a hard discard (which hard-cut AA'd
// borders and glyphs).
//
// Routes through the SAME continuous corner field (CornerEval, via ShapeSDF)
// as the panel silhouette and border — so a clip mask and the shape it masks
// agree corner-for-corner across the Rect↔Circle↔Pill morph. No parallel
// superellipse here: one implementation, two callers. The `mode` arg is
// vestigial (CornerEval derives the regime from geometry) so pass 0.
// (This was `clipShapeDistance`; its three lines are inline in cornerQueries below.)

// Loop bounded by a constant so drivers with stricter GLSL ES 3.00 loop
// heuristics still unroll / accept it. Practical clip-stack depth never
// exceeds a handful.
const int MAX_CLIP_DEPTH = 16;

// Intersection of a clip stack — a pixel is inside the combined clip iff
// it's inside every individual clip. Signed distance = max of per-clip SDFs.
//
// ONE CALL SITE FOR THE CORNER FIELD, SHARED WITH THE DROP SHADOW (2026-09-22). The shadow asks the
// same question of the same function -- `ShapeSDF` of a rounded shape -- so it rides this loop as one
// more query after the clips (`wantShadow`, answered in `shadowDist`). On Windows FXC inlines every
// call site of a function, and the corner field (superellipse + pill polyline) is the heaviest code in
// this shader: a second call site for the shadow was ~22% of the seven panel programs' compile
// (Perf/BootCompile.Windows.Finding.md). Each query is the call it always was, with the inputs it
// always had, so every distance is bit-identical; only the number of copies FXC compiles changes.
float cornerQueries(vec2 pixel, int offset, int count, bool wantShadow, vec2 shadowP, vec2 shadowHalf,
                    vec4 shadowRadii, float shadowSmooth, out float shadowDist) {
    shadowDist = 1e20;
    int nClips = min(count, MAX_CLIP_DEPTH);
#if !defined(MATERIAL_FLAT)
    if (GlassSkips(GLASS_SKIP_CLIP)) nClips = 0;
#endif
    int queries = nClips + (wantShadow ? 1 : 0);
    float d = -1e20;
    for (int i = 0; i < MAX_CLIP_DEPTH + 1; i++) {
        if (i >= queries) break;
        vec2 q;
        vec2 halfSize;
        vec4 radii;
        float smoothness;
        if (i < nClips) {
            int base = (offset + i) * 3;
            vec4 rect = texelFetch(u_ClipTex, ivec2(base, 0), 0);
            radii = texelFetch(u_ClipTex, ivec2(base + 1, 0), 0);
            vec4 meta = texelFetch(u_ClipTex, ivec2(base + 2, 0), 0);
            // meta = (Smoothness, cosθ, sinθ, _). Un-rotate the sample about the
            // clip's center by R(-θ) so a ROTATED clip parent clips its children
            // along the rotated edges (the axis-aligned rounded-rect SDF then runs
            // in the clip's local frame). cos=1/sin=0 ⇒ identity (unrotated clips
            // unchanged). Center = rect.xy + rect.zw*0.5 (rect.xy is center−half).
            vec2 cc = rect.xy + rect.zw * 0.5;
            vec2 rel = pixel - cc;
            vec2 local = vec2(rel.x * meta.y + rel.y * meta.z,
                              -rel.x * meta.z + rel.y * meta.y) + cc;
            // clipShapeDistance's own arithmetic, inline: the offset from the clip's center.
            q = local - (rect.xy + rect.zw * 0.5);
            halfSize = rect.zw * 0.5;
            smoothness = meta.x;
        } else {
            q = shadowP;
            halfSize = shadowHalf;
            radii = shadowRadii;
            smoothness = shadowSmooth;
        }
        float di = ShapeSDF(q, halfSize, radii, smoothness, 0);
        if (i < nClips) d = max(d, di);
        else shadowDist = di;
    }
    return d;
}


// ── THE REFRACTION BAND ─────────────────────────────────────────────────────────────────────────────
// Apple's glass bends light only in a band along its edge, about 9% of the short side, and the face
// inside it is flat. The surface is kube.io's convex squircle, and its displacement is analytic:
// inward along the normal by REFRACT_DEPTH * band * (1 - x)^3, x from 0 at the outline to 1 at the
// band's inner edge. The sample then moves at 1 - 3 * REFRACT_DEPTH * (1 - x)^2 of the screen's pace,
// which never goes negative at 1/3: the edge stretches what lies just inside it and never folds.
const float REFRACT_BAND = 0.09;
const float REFRACT_DEPTH = 1.0 / 3.0;
// The edge also reads milky: toward the outline the body loses its saturation and lifts a little.
const float MILK_DEPTH = 0.25;
const float MILK_LIFT = 0.12;

// The band's own soft edge, for the highlight: about 1 across the band, 0.5 at its inner edge, about
// 0 on the face. aave's erf(z) ~ tanh(sqrt(pi) z) over the outline inset by `depth`.
float BandFalloff(float dist, float depth) {
    float d = max(depth, 0.5);
    return 0.5 * (1.0 + tanh(1.7724538509 * (dist + d) / (d * 1.41421356)));
}

void main() {
#if !defined(MATERIAL_FLAT)
    if (GlassSkips(GLASS_SKIP_SKIRT) && GlassSkirtCut()) discard;
#endif
    // CSS-style overflow clipping — inherited rounded-rect clip stack. The
    // meta is packed into v_Outline.zw to stay within WebGL2's 16-attribute
    // cap (a 17th slot would overflow MAX_VERTEX_ATTRIBS on many drivers).
    // SDF-based so AA'd panel silhouettes, borders, and glyphs fade smoothly
    // at the clip edge instead of being hard-cut (the old boolean discard
    // nullified the 1-pixel feather on everything it touched).
    // The clip stack is asked a few lines down, TOGETHER with the drop shadow's distance, once the
    // shadow's inputs exist (cornerQueries).

    vec2 panelCenter = v_PanelGeom.xy;
    vec2 panelHalfSize = v_PanelGeom.zw;

    // Un-rotate the screen pixel into the panel's local (unrotated) frame so the
    // whole rounded-rect SDF + border + shadow + fill geometry below evaluates as
    // if axis-aligned. Screen-space samples (clip distance, backdrop/refraction
    // UVs, dither) keep the original v_PixelPos. Identity when (cos,sin)=(1,0).
    vec2 pLocal;
    if (v_Is3D > 0.5) {
        // Projective panel: the undeformed panel-local coord comes interpolated
        // (perspective-correct) from the vertex. panelCenter is 0 for 3D, so the
        // SDF's `pLocal - panelCenter` below is exactly v_Local.
        pLocal = panelCenter + v_Local;
    } else {
        vec2 _rel = v_PixelPos - v_Rot.zw;
        // Inverse rotation R(-θ): [ cos  sin; -sin  cos ].
        pLocal = vec2(
            _rel.x * v_Rot.x + _rel.y * v_Rot.y,
            -_rel.x * v_Rot.y + _rel.y * v_Rot.x
        ) + v_Rot.zw;
    }
    vec2 shadowOffset = v_ShadowParams.xy;
    float shadowBlur = v_ShadowParams.z;
#if !defined(NO_SHAPE_GRADIENT)
    // The borderless program is routed only where this is exactly 0.0 for every instance, and
    // the stroke that reads it is excluded below, so the read has no consumer there.
    float borderWidth = v_ShadowParams.w;
#endif
    float borderEdgeAa = v_StyleParams.x;
    float smoothness = v_StyleParams.y;
    float opacity = v_StyleParams.z;
    // materialType is a compile-time constant when built as a shader variant
    // (see Shader.Compiler's defines mechanism). The `if (materialType == 1.0)`
    // branches throughout this shader then become constant-folded by GLSL's
    // dead-code elimination — the glass variant keeps the glass branches,
    // the non-glass variant keeps the else branches. Instance data at
    // v_StyleParams.w is still packed (avoids restructuring the instance
    // buffer layout) but intentionally unread. Falls back to reading the
    // instance attribute when neither variant is defined (e.g. test builds).
    #if defined(MATERIAL_GLASS)
    const float materialType = 1.0;
    #elif defined(MATERIAL_NONE) || defined(MATERIAL_FLAT)
    const float materialType = 0.0;
    #else
    // v_StyleParams.w now carries the foreground Brightness multiplier (applied
    // at the end of main), not materialType — so undefined-variant test builds
    // fall back to non-glass rather than reading brightness as a material flag.
    const float materialType = 0.0;
    #endif

    float brightness = v_Grading.x;
    float saturation = v_Grading.y;
    float contrast = v_Grading.z;
    float frostLod = v_Grading.w;

    float thickness = v_Refraction.x;
    float refractionStrength = v_Refraction.z;
    // The refraction band, which also sets the reach of every other edge effect on the glass.
    float band = max(REFRACT_BAND * 2.0 * min(panelHalfSize.x, panelHalfSize.y), 0.5);

    vec2 lightDir = vec2(cos(v_Lighting.x), -sin(v_Lighting.x));
    float bodyTint = v_Lighting.y;
    float lightIntensity = v_Lighting.z;
    float fresnelStrength = v_Lighting.w;

    float specIntensity = v_Specular.x;
    float specGlow = v_Specular.y;
    float chromaticAberration = v_Specular.z;
    float borderFade = v_Specular.w;

    float edgeLightTop = v_RimEdge.x;
    float edgeLightBottom = v_RimEdge.y;

    vec2 p = pLocal - panelCenter;

    // Shape mode — Rect uses the user's Smoothness as the superellipse exponent;
    // Pill/Circle bake their own exponent in ShapeSDF/ShapeGrad and ignore this.
    int mode = ShapeMode(panelHalfSize, v_Radii);
    float effectiveSmooth = smoothness;
    // The clip stack and the drop shadow through ONE call site of the corner field (cornerQueries).
    // Moved below the local frame from the top of main because the shadow's point lives here; a
    // discarded fragment still writes nothing, so only the order of the work changes.
    // Written as a line MATERIAL_FLAT deletes, not one it rewrites, so the flat program stays a
    // deletion from the non-glass one (Flat.Program.test.ts).
    bool wantShadow = v_ShadowColor.a > 1e-4;
#if !defined(MATERIAL_FLAT)
    if (GlassSkips(GLASS_SKIP_SHADOW)) wantShadow = false;
#endif
    float shadowDist;
    float clipD = cornerQueries(v_PixelPos, int(v_Outline.z), int(v_Outline.w), wantShadow,
                                p - shadowOffset, panelHalfSize, v_Radii, effectiveSmooth, shadowDist);
    if (clipD > 1.0) discard;
    float clipAlpha = 1.0 - smoothstep(-0.5, 0.5, clipD);
    // The shadow is finished HERE, so what the rest of the body carries is one float, not the distance
    // and its gate.
    float shadowAlpha = 0.0;
    if (wantShadow) {
        shadowAlpha = smoothstep(shadowBlur, -shadowBlur, shadowDist) * v_ShadowColor.a;
    }

    // ── SDF + normal ──
    // Single dispatch for pill mode → one polyline scan instead of two
    // separate scans (SDF + Grad). Rect/circle still uses the cheap
    // closed-form pair.
    float dist;
    // The ONE substitution in the NO_SHAPE_GRADIENT variant, and the only place this lane writes a
    // line rather than deleting one. `CornerDist` is the same function the clip stack and the
    // shadow pass already call; the routing guarantees `pillW == 0` for every instance in the
    // batch, and on that leg CornerDist and CornerEval both return
    // `ShapeSDF_inner(p, halfSize, vec2(rCorner), n)` off the same `CornerParams` — the same
    // expression, in the same order, in the same function. `normal` is not declared, because
    // nothing that survives the exclusions below reads it.
#if defined(NO_SHAPE_GRADIENT)
    dist = CornerDist(p, panelHalfSize, v_Radii, effectiveSmooth);
#else
    vec2 normal;
    ShapeEval(p, panelHalfSize, v_Radii, effectiveSmooth, mode, dist, normal);
#endif
    float edgeDist = max(-dist, 0.0);                 // positive inside

    // ── Fill alpha (shape mask) ──
    // Silhouette AA is hardcoded ~0.5px — BorderBlur must NOT fade the
    // panel outline, or a soft border would just dissolve the whole edge.
    // `aa` below is the border-stroke feather, applied only to the border
    // smoothsteps. Floor at a tiny epsilon so BorderBlur=0 still yields a
    // valid (hard-step) smoothstep.
    float fillAlpha = 1.0 - smoothstep(-0.5, 0.5, dist);
    float aa = max(borderEdgeAa, 1e-4);

    // ── Backdrop sample with refraction ──
    vec3 backdrop = vec3(0.0);
    vec2 baseUv = v_PixelPos / u_Resolution;
    baseUv.y = 1.0 - baseUv.y;

    // Backdrop filter is universal — any jiv with non-default brightness/saturation/
    // contrast/frostLod samples the backdrop, regardless of material. Glass layers
    // refraction on top; flat panels get a clean filtered sample.
    // MATERIAL_FLAT is routed ONLY at batches whose every instance makes this predicate false
    // (`WebGL2Renderer._batchTakesFlatProgram` evaluates the SAME five numbers off the same packed
    // instance floats, with the same epsilons, against the same u_BaseFrostLod). Pinning it to a
    // compile-time `false` therefore changes no fragment's answer; it changes only whether the
    // program has to be able to ask.
    #if defined(MATERIAL_FLAT)
    const bool hasBackdropFilter = false;
    #else
    bool hasBackdropFilter = abs(brightness - 1.0) > 0.001
        || abs(saturation - 1.0) > 0.001
        || abs(contrast - 1.0) > 0.001
        || frostLod > u_BaseFrostLod + 0.001
        || abs(bodyTint) > 0.001;
    #endif

    // Continuous glass intensity. Drives every edge effect that would otherwise
    // pop on/off when Thickness flips between 0 and >0 (the shader-variant
    // choice flips with it), so MATERIAL_GLASS at Thickness 0 draws what
    // MATERIAL_NONE would.
    float glassiness = smoothstep(0.0, 1.0, thickness);

#if !defined(MATERIAL_FLAT)
    if (materialType == 1.0) {
        // Where across the band this fragment sits, and the bend it takes there: inward along the
        // normal, rotated into screen space with the panel.
        float edge = 1.0 - clamp(edgeDist / band, 0.0, 1.0);
        float edge3 = edge * edge * edge;
        vec2 screenNormal = v_Is3D > 0.5 ? normal
            : vec2(v_Rot.x * normal.x - v_Rot.y * normal.y, v_Rot.y * normal.x + v_Rot.x * normal.y);
        vec2 refractOffset = -screenNormal * (REFRACT_DEPTH * band * edge3 * refractionStrength * glassiness);

        // FBO has top-of-scene at UV.y=1 (panel/text shaders flip Y in clip space).
        baseUv = (v_PixelPos + refractOffset) / u_Resolution;
        baseUv.y = 1.0 - baseUv.y;

        // Chromatic aberration is DISPERSION, proportional to the bend: red at (1 + 0.2 ca) of the
        // offset, green at (1 + 0.1 ca), blue at the offset itself. Only a class that asks for it (the
        // moving selection lens) spreads; at rest ChromaticAberration is 0 and this is one tap. Where
        // the three would land within half a pixel of each other it is one tap too.
        float caSpreadPx = 0.2 * chromaticAberration * length(refractOffset);
        if (GlassSkips(GLASS_SKIP_CA)) caSpreadPx = 0.0;
        if (caSpreadPx < 0.5) {
            backdrop = sampleBackdrop(baseUv, frostLod);
        } else {
            vec2 uvR = (v_PixelPos + refractOffset * (1.0 + 0.2 * chromaticAberration)) / u_Resolution;
            vec2 uvG = (v_PixelPos + refractOffset * (1.0 + 0.1 * chromaticAberration)) / u_Resolution;
            uvR.y = 1.0 - uvR.y;
            uvG.y = 1.0 - uvG.y;
            vec3 sR = sampleBackdrop(uvR, frostLod);
            vec3 sG = sampleBackdrop(uvG, frostLod);
            vec3 sB = sampleBackdrop(baseUv, frostLod);
            backdrop = vec3(sR.r, sG.g, sB.b);
        }
        if (GlassSkips(GLASS_SKIP_GRADE)) {} else
        if (GlassSkips(GLASS_SKIP_GRADE)) {} else
        backdrop = applyTint(applyGrading(backdrop, brightness, saturation, contrast), bodyTint);
        // The milk: toward the outline the body desaturates and lifts, over the same cube the bend
        // takes, so it lives in the band and is gone on the face.
        float milk = MILK_DEPTH * edge3 * glassiness;
        backdrop = mix(backdrop, vec3(dot(backdrop, LUMA)), milk);
        backdrop += (1.0 - backdrop) * (milk * MILK_LIFT);
    } else if (hasBackdropFilter) {
        // Flat panel backdrop sampling — no refraction, no CA.
        vec3 s = sampleBackdrop(baseUv, frostLod);
        backdrop = applyTint(applyGrading(s, brightness, saturation, contrast), bodyTint);
    }
#endif

    // ── Beer-Lambert tint (multiplicative absorption) ──
    // Tint.a scales absorption strength; path length grows toward center.
    // Scaled by `glassiness` so a Thickness=0 panel (no physical thickness
    // for light to pass through) gets no absorption — the surface tint
    // composite below takes over instead. Together with that composite,
    // the glass material treatment is visually continuous as Thickness
    // springs to/from zero (no seam at the variant boundary).
    if (materialType == 1.0 && v_Tint.a > 0.001 && glassiness > 0.001) {
        float pathLength = mix(0.3, 1.0, smoothstep(0.0, band * 2.0, edgeDist)) * glassiness;
        vec3 absorb = pow(max(v_Tint.rgb, vec3(0.0001)), vec3(pathLength * v_Tint.a));
        backdrop *= absorb;
    }

#if !defined(NO_SHAPE_GRADIENT)
    // ── Hairline floor ──
    // The stroke is point-sampled ONCE per fragment, so an annulus narrower than a device pixel can
    // fall entirely between pixel centres and paint nothing at all. So never draw a stroke thinner
    // than a device pixel: draw it AT the floor and carry the width it lost as coverage. A 0.7px
    // stroke becomes a 1.0px stroke at 0.7 alpha, the same ink over a footprint the sample grid cannot
    // miss. A zero BorderWidth stays zero: coverage is 0, so "no border" is untouched.
    const float BORDER_MIN_DEVICE_PX = 1.0;
    float drawnBorderWidth = max(borderWidth, BORDER_MIN_DEVICE_PX);
    float borderCoverage = borderWidth / drawnBorderWidth;
#endif

    // ── The wide rim glow (FresnelStrength) ──
    // A vibrant band of what lies behind the glass, fading from the outline inward over the band,
    // lit toward LightAngle. The thin light at the outline itself is the RIM, its own draw
    // (Jiv/Jiv.Rim.ts). Only within `rimBand` of the outline, so the deep interior skips the whole
    // block and its extra backdrop tap.
    //
    // GLASS_NO_GLOW excludes the block for a batch whose every instance has FresnelStrength +0, and
    // then the two initialisers are what the composite reads.
    float edgeLightAlpha = 0.0;
    vec3 edgeLightRgb = vec3(0.0);
#if !defined(MATERIAL_FLAT) && !defined(GLASS_NO_GLOW)
    if (GlassSkips(GLASS_SKIP_RIM)) {} else
    if (materialType == 1.0 && fillAlpha > 0.0 && dist > -max(band * 0.75, 6.0)) {
        // Wide rim band — at LEAST 6 px so the glow is actually visible, scaled with the band.
        float rimBand = max(band * 0.75, 6.0);

        // Proximity: 1 at the outline (dist ≈ 0), 0 a full band inward, 0 outside.
        // Must be zero where dist > 0 (the expanded-rect shadow region) or the
        // edge light leaks into the shadow and looks like a dark blob.
        float edgeProximity = dist > 0.0 ? 0.0 : clamp(1.0 + dist / rimBand, 0.0, 1.0);

        // Single soft falloff — exp 1.6 keeps a strong peak near the rim and a
        // gentle fade inward.
        float falloff = pow(edgeProximity, 1.6);

        // Directional: lit side full, unlit side dimmed (not dark). The key light and its bounce from
        // the opposite side, nearly as bright.
        float keyAlign = dot(normal, lightDir);
        float lightFacing = max(max(keyAlign, -keyAlign * 0.95), 0.0);
        float directional = 0.6 + 0.4 * pow(lightFacing, 1.5);

        // Rim backdrop sample — offset INWARD from the outline so the rim picks up
        // the color from behind the glass, not the pixel directly beneath it.
        vec2 rimUv = (v_PixelPos - normal * rimBand * 1.2) / u_Resolution;
        rimUv.y = 1.0 - rimUv.y;
        vec3 rimSample = sampleBackdrop(rimUv, frostLod);

        // Saturation + brightness boost — Apple's rim picks up surrounding hue
        // and intensifies it (the "light gathering" feel).
        float rimLuma = dot(rimSample, LUMA);
        vec3 rimVibrant = clamp(mix(vec3(rimLuma), rimSample, 1.6) * 1.25, 0.0, 1.0);

        // Brighter near the rim (specular cap), pure backdrop color deeper in
        float specularCap = pow(edgeProximity, 3.5);
        edgeLightRgb = mix(rimVibrant, mix(rimVibrant, vec3(1.0), 0.6), specularCap);

        edgeLightAlpha = falloff * directional * fresnelStrength * fillAlpha;
    }
#endif

    // ── Fill: source composited over the (refracted, filtered, absorbed) backdrop.
    //
    // The fill source is selected by u_BgMode:
    //   • Color   → v_Tint (the solid fill; no texture / no stops)
    //   • Image   → sampled u_BgTexture with CPU-baked Cover/Contain UV
    //   • Linear/RadialGradient → evaluated against u_BgGradColor[]/Pos[]
    //
    // Once we have the source, the same glass / non-glass composite below
    // applies. Image-Background panels reuse the entire material treatment
    // (border, shadow, refraction, frost) for free — there is no separate
    // "image draw" pipeline, image is just one of many fill modes.
    // `shadowAlpha` was finished with the clip stack (cornerQueries, above).
    vec2 panelLocal = (pLocal - (panelCenter - panelHalfSize))
                    / max(panelHalfSize * 2.0, vec2(1.0));
    vec4 fillSrc = resolveBgFill(panelLocal);
    vec3 fillRgb;
    float fillA;
    if (materialType == 1.0 || hasBackdropFilter) {
        float tA = fillSrc.a;
        fillRgb = fillSrc.rgb * tA + backdrop * (1.0 - tA);
        fillA = fillAlpha;
    } else {
        fillRgb = fillSrc.rgb;
        fillA = fillAlpha * fillSrc.a;
    }

    // ── Composite: fill OVER shadow (straight-alpha "over" operator) ──
    // out.a = A.a + B.a * (1−A.a); out.rgb = (A.rgb * A.a + B.rgb * B.a * (1−A.a)) / out.a.
    float outA = fillA + shadowAlpha * (1.0 - fillA);
    vec3 outRGB = outA > 1e-5
        ? (fillRgb * fillA + v_ShadowColor.rgb * shadowAlpha * (1.0 - fillA)) / outA
        : vec3(0.0);
    vec4 result = vec4(outRGB, outA);

#if !defined(MATERIAL_FLAT)
    if (materialType == 1.0) {
        // ── Hemispherical edge light (rim ambient — top vs bottom bias) ──
        // Apple uses a virtual "sky above, ground below" environment so the
        // top of the rim picks up brighter ambient than the bottom. In screen
        // coords (y-down), the TOP edge has normal.y < 0; the BOTTOM has
        // normal.y > 0. Mix between EdgeLightTop and EdgeLightBottom by the
        // vertical normal component. Modulated by edge proximity so it only
        // shows in the rim band, not the flat interior.
        float hemiTop = max(-normal.y, 0.0);
        float hemiBottom = max(normal.y, 0.0);
        float hemiAmbient = (edgeLightTop * hemiTop + edgeLightBottom * hemiBottom);
        float rimMask = (dist > 0.0)
            ? 0.0
            : pow(clamp(1.0 + dist / band, 0.0, 1.0), 2.0);
        vec3 rimAmbientRgb = vec3(hemiAmbient) * rimMask;
        result.rgb += rimAmbientRgb * fillAlpha;

        result.rgb = result.rgb * (1.0 - edgeLightAlpha) + edgeLightRgb * edgeLightAlpha;
        result.a = result.a * (1.0 - edgeLightAlpha) + edgeLightAlpha;

        // GLASS_NO_SPEC: SpecularIntensity AND SpecularGlow are +0 on every instance, so `spec` is +-0
        // (every other factor is finite) and the composite adds and scales by nothing. Excluded whole.
#if !defined(GLASS_NO_SPEC)
        if (!GlassSkips(GLASS_SKIP_SPECULAR)) {
            // ── THE HIGHLIGHT (aave's) ──
            // Two terms, both on the NORMALIZED POSITION across the panel, not the surface normal, and
            // both TWO-SIDED: `abs` puts the light on opposite corners (top left and bottom right at the
            // default 135), as the iPhone's key light and bounce do.
            //   * glow: rises toward the two lit corners, confined to the refraction band.
            //   * edge: 0.3 of the band wide (aave's 3px on a 10px depth), full at the outline.
            // The tilt slides it.
            vec2 specLightDir = normalize(lightDir + u_SpecularTilt);
            vec2 np = clamp(p / max(panelHalfSize, vec2(1.0)), -1.0, 1.0);
            float axis = abs(dot(np, specLightDir));
            float glowTerm = specGlow * pow(clamp(axis * 0.70710678, 0.0, 1.0), 1.5) * BandFalloff(dist, band);
            float edgeW = max(band * 0.3, 1.0);
            float edgeTerm = specIntensity * (dist < 0.0 ? max(0.0, 1.0 + dist / edgeW) : 0.0) * pow(axis, 1.5);
            float spec = 0.5 * min(glowTerm + edgeTerm, 1.0) * lightIntensity * glassiness * fillAlpha;
            // ADAPTIVE: it brightens what is dark and darkens what is bright (aave's luma 0.3 to 0.7), so
            // it reads on any backdrop. An added white washes out over a bright photograph exactly where
            // a highlight is needed; this is the same reason text inks with Lift.
            float specLuma = dot(result.rgb, LUMA);
            float darken = smoothstep(0.3, 0.7, specLuma);
            result.rgb = max(mix(result.rgb + spec, result.rgb * (1.0 - spec), darken), vec3(0.0));
        }
#endif
    }
#endif

    // ── The stroke ──
    // BorderColor over the panel, on every material, at the hairline floor above. Under
    // NO_SHAPE_GRADIENT the whole compound statement goes: every assignment in it is
    // `result.<c> * (1 - 0) + <c> * 0`, because `borderCoverage` is exactly 0 at BorderWidth 0.
#if !defined(NO_SHAPE_GRADIENT)
    {
        float borderOuter = smoothstep(-aa, aa, dist);
        // The inner edge eases over BorderFade past the stroke; with no fade it feathers by the same
        // aa as the outer edge.
        float fadeIn = max(borderFade, aa);
        float borderInner = smoothstep(-drawnBorderWidth - fadeIn, -drawnBorderWidth + aa, dist);
        // Drawn at the hairline floor, inked by the width it actually has.
        float borderBase = (1.0 - borderOuter) * borderInner * borderCoverage;
        float borderAlpha = borderBase * v_BorderColor.a;
        result.rgb = result.rgb * (1.0 - borderAlpha) + v_BorderColor.rgb * borderAlpha;
        result.a = result.a * (1.0 - borderAlpha) + borderAlpha;
    }
#endif

    result.a *= opacity * clipAlpha;

    // Foreground filter grade — brightness + saturation + contrast applied to
    // the whole element's final rgb (fill, image, text, border), so it reads
    // the same on every material. Bit-packed into v_StyleParams.w (see
    // Jiv.InstanceBuffer._packFgGrade): brightness 10 bits ·256, saturation /
    // contrast 7 bits ·32, layout b·16384 + s·128 + c. Identity (1,1,1) = no-op.
    {
        float fgPacked = v_StyleParams.w;
        float fgB = floor(fgPacked / 16384.0);
        float fgRem = fgPacked - fgB * 16384.0;
        float fgS = floor(fgRem / 128.0);
        float fgC = fgRem - fgS * 128.0;
        result.rgb = applyGrading(result.rgb, fgB / 256.0, fgS / 32.0, fgC / 32.0);
    }

    // Dither backdrop-sampling panels to break RGBA8 banding in frosted /
    // glass regions. Sub-LSB amplitude; skipped where no backdrop is read
    // so sharp solid/text panels stay bit-exact.
    // Dangling `else` again: MATERIAL_FLAT drops the glass dither and the gradient dither below
    // becomes a plain `if (u_BgMode >= 2)`. Byte for byte the same expression on the same path —
    // a flat gradient band dithers exactly as it does today.
#if !defined(MATERIAL_FLAT)
    if (materialType == 1.0 || hasBackdropFilter) {
        result.rgb += triDither(v_PixelPos);
    } else
#endif
    if (u_BgMode >= 2) {
        // Gradient fills: ±half an 8-bit step on screen. Blending scales rgb by alpha, so divide it back
        // out (down to a floor) and a thin wash dithers as much as an opaque one.
        float gradDither = (gradientNoise(floor(gl_FragCoord.xy)) - 0.5) / 255.0;
        result.rgb += gradDither / max(result.a, 0.25);
    }

    fragColor = result;
}
