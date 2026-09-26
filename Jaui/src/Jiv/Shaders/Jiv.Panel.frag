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
flat in vec4 v_Refraction;     // thickness, glass span (pt), glass shadow mode, refraction
flat in vec4 v_Lighting;       // device px per pt, bodyTint (signed), dark scheme, clear glass
flat in vec4 v_Specular;       // rim amount, rim height (pt), chromaticAberration, borderFade
flat in vec4 v_RimEdge;        // glass appearance (1 light), backdrop mean luma, lens magnification, lens ink
flat in vec4 v_TouchGlow;      // the flex's little glow: centre (fraction of the box), diameter (CSS px), alpha
flat in vec4 v_Outline;        // dispersion amount + angle, height + inset (packed), clipOffset, clipCount

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
// `BorderWidth == 0.0` exactly. `WebGL2Renderer._batchTakesBorderlessProgram` decides it, off the same
// packed instance floats.
//
// Under MATERIAL_FLAT nothing reads the normal `CornerEval` returns, and at BorderWidth 0 the plain
// stroke's output is the EXACT float 0, so the two blends it drives are `x * 1.0 + c * 0.0`: a no-op
// in IEEE for finite x and c. The arithmetic is written out in `tests/Borderless.Program.test.ts`
// and in `Perf/Borderless.Finding.md`.
//
// With the stroke gone the only surviving consumer of the corner field is its DISTANCE, and
// `CornerDist` returns it from the same `ContinuousCorner` call `CornerEval` makes, with the normal
// discarded: the substitution is bit-identical by construction, for every shape.
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
// What u_Backdrop's level 0 holds: its texel and the Gaussian sigma it delivers, device px (glassSample).
uniform vec2 u_BackdropLevel;
// Raw scene snapshot — sampled when effective LOD is 0 (no-frost,
// no-refraction) so panels with just BackdropBrightness/Saturation/
// Contrast don't inherit the pyramid's baked-in 1px base blur. This one is ALWAYS canvas-sized,
// so screen UV addresses it directly and u_BackdropXf does not apply to it.
uniform sampler2D u_Scene;
uniform float u_BaseFrostLod;
// An active lens's lifted content (Core/Jaui.ts, liftLensItems): the bar's items drawn again, premultiplied over
// transparent, canvas-sized and screen-addressed like u_Scene.
uniform sampler2D u_LensItems;
#endif
uniform vec2 u_Resolution;

// Clip-stack texture — RGBA32F row where each clip occupies 3 texels:
// texel[3i]   = (x, y, w, h)              device pixels
// texel[3i+1] = (rTL, rTR, rBR, rBL)      device pixels
// texel[3i+2] = (smoothness, _, _, _)     unitless (0 = pure circle corners)
uniform sampler2D u_ClipTex;
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
// glass path is moved or rewritten.
//
// `GlassSkips` is a constant `false` in the non-glass program, so every gate folds away there and
// MATERIAL_NONE compiles to the program it was; MATERIAL_FLAT deletes the whole apparatus. The bit
// values are `Core/Glass.Skip.ts`'s GLASS_SKIP_STAGES, and `tests/Glass.Skip.test.ts` holds the two
// tables to each other.
uniform int u_GlassSkip;
const int GLASS_SKIP_BACKDROP = 1;     // every backdrop tap returns GLASS_SKIP_FLAT
const int GLASS_SKIP_CA       = 2;     // chromatic spread off: the 3-tap fill path becomes 1
const int GLASS_SKIP_RIM      = 4;     // the highlight band
const int GLASS_SKIP_BLEED    = 8;     // the edge bleed and its tap
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
// rounded corner and the box are therefore NOT cut; `Core/Glass.Skip.ts` counts them apart. The 2 px
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

// VIBRANCY (Core/Vibrancy.ts): -1 on every ordinary draw; otherwise the output is premultiplied, its
// light at its coverage over `u_VibrancyCover` of it, for the blend `SetVibrancyBlend` sets.
uniform float u_VibrancyCover;

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

#include "Corner.Continuous.glsl"
#include "Glass.Pipeline.glsl"

// The shape's distance, and its distance with the outward normal: the continuous corner, the one model
// for every rounded shape (Corner.Continuous.glsl). Both come out of the same function, so a caller
// that only needs the distance gets the same float the one that needs the normal does.
float CornerDist(vec2 p, vec2 halfSize, vec4 radii, float smoothness) {
#if !defined(MATERIAL_FLAT)
    if (GlassSkips(GLASS_SKIP_SDF)) return GlassRectDist(p, halfSize);
#endif
    vec2 unused;
    return ContinuousCorner(p, halfSize, radii, smoothness, unused);
}

#if !defined(NO_SHAPE_GRADIENT)
void CornerEval(vec2 p, vec2 halfSize, vec4 radii, float smoothness, out float distOut, out vec2 gradOut) {
#if !defined(MATERIAL_FLAT)
    if (GlassSkips(GLASS_SKIP_SDF)) { GlassRectEval(p, halfSize, distOut, gradOut); return; }
#endif
    distOut = ContinuousCorner(p, halfSize, radii, smoothness, gradOut);
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

// The glass's own read: a Gaussian of 2^lod device px (Glass.Pipeline.glsl's GlassNativeLod), `pixel` in device px,
// at the level of this pyramid that delivers it.
vec3 glassSample(vec2 pixel, float lod) {
    if (GlassSkips(GLASS_SKIP_BACKDROP)) return GLASS_SKIP_FLAT;
    vec2 uv = pixel / u_Resolution;
    uv.y = 1.0 - uv.y;
    return textureLod(u_Backdrop, uv * u_BackdropXf.xy + u_BackdropXf.zw,
                      GlassPyramidLevel(exp2(lod), u_BackdropLevel.x, u_BackdropLevel.y)).rgb;
}

// The BackdropView's read: the scene under the lifted items (u_Scene) as a CABackdropLayer captures it, at
// GLASS_LENS_BACKDROP_CAPTURE of the device pixel with no blur (its gaussianBlur is 0 lifted [C]), read bilinearly.
// Each capture texel is the mean of its device pixels, four bilinear fetches over a 4 x 4 block; the texel grid
// is anchored at the screen's origin [I: Apple's is the backdrop layer's].
vec3 lensCaptureTexel(vec2 texel) {
    float span = 1.0 / GLASS_LENS_BACKDROP_CAPTURE;
    vec2 origin = texel * span;
    vec3 c = vec3(0.0);
    for (int i = 0; i < 2; i++) {
        for (int j = 0; j < 2; j++) {
            vec2 uv = (origin + span * (0.25 + 0.5 * vec2(float(i), float(j)))) / u_Resolution;
            uv.y = 1.0 - uv.y;
            c += texture(u_Scene, uv).rgb;
        }
    }
    return c * 0.25;
}
vec3 lensCapture(vec2 pixel) {
    vec2 q = pixel * GLASS_LENS_BACKDROP_CAPTURE - 0.5;
    vec2 i = floor(q), f = q - i;
    return mix(mix(lensCaptureTexel(i), lensCaptureTexel(i + vec2(1.0, 0.0)), f.x),
               mix(lensCaptureTexel(i + vec2(0.0, 1.0)), lensCaptureTexel(i + vec2(1.0, 1.0)), f.x), f.y);
}
// The lens's own SDF at a screen pixel, as QuartzCore's compute_sdf_with_mode gives it: the depth in pt (negative
// inside) and the outward normal on screen, the shape's gradient mixed by `ovalization` toward the direction from
// the centre with y scaled by the half width over the half height [C].
void lensField(vec2 pixel, float dpr, float ovalization, out float d, out vec2 n) {
    vec2 p;
    if (v_Is3D > 0.5) {
        p = v_Local + pixel - v_PixelPos;
    } else {
        vec2 rel = pixel - v_Rot.zw;
        p = vec2(rel.x * v_Rot.x + rel.y * v_Rot.y, -rel.x * v_Rot.y + rel.y * v_Rot.x) + v_Rot.zw - v_PanelGeom.xy;
    }
    vec2 halfSize = v_PanelGeom.zw;
    vec2 g;
    CornerEval(p, halfSize, v_Radii, v_StyleParams.y, d, g);
    vec2 oval = vec2(p.x, halfSize.x * p.y / max(halfSize.y, 1e-4));
    oval *= inversesqrt(max(dot(oval, oval), 1e-8));
    g = normalize(mix(g, oval, ovalization));
    n = v_Is3D > 0.5 ? g : vec2(v_Rot.x * g.x - v_Rot.y * g.y, v_Rot.y * g.x + v_Rot.x * g.y);
    d /= dpr;
}
// What the lens's glass holds at a screen pixel, before its content lensing: the BackdropView (the scene under the
// lifted items, at the backdrop layer's scale) through its displacementMap, and over it the contentWrapper, the lifted
// items (u_LensItems, premultiplied) through its own, in the selection's ink when it has one [C: they are the
// selected twins]. Each warp is taken at that pixel's own depth and normal, as each layer's filter draws it. Opaque,
// as the glass's background is; `cover` is the items' alpha.
vec4 lensContent(vec2 pixel, float dpr, float ease, float inkPacked, out float cover) {
    float d;
    vec2 n;
    lensField(pixel, dpr, GLASS_LENS_OVALIZATION, d, n);
    vec3 backdrop = lensCapture(pixel + n * GlassShift(d, GLASS_LENS_BACKDROP_WARP.x * dpr * GLASS_LENS_BACKDROP_CAPTURE,
                                                      GLASS_LENS_BACKDROP_WARP.y) * dpr * ease);
    vec2 read = pixel + n * GlassShift(d, GLASS_LENS_ITEM_WARP.x, GLASS_LENS_ITEM_WARP.y) * dpr * ease;
    vec2 uv = read / u_Resolution;
    uv.y = 1.0 - uv.y;
    // The portal of the items clips to the capsule [C: liftedContentPortalView], before the warp reads it.
    float readDepth;
    vec2 readNormal;
    lensField(read, dpr, 0.0, readDepth, readNormal);
    vec4 items = texture(u_LensItems, uv) * clamp(0.5 - readDepth * dpr, 0.0, 1.0);
    if (inkPacked > 0.5) {
        float packed = inkPacked - 1.0;
        vec3 inkColor = vec3(floor(packed / 65536.0), mod(floor(packed / 256.0), 256.0), mod(packed, 256.0)) / 255.0;
        items.rgb = inkColor * items.a;
    }
    cover = items.a;
    return vec4(backdrop * (1.0 - items.a) + items.rgb, 1.0);
}
// THE ACTIVE LENS, as UIKit's _UILiquidLensView builds it (Glass.Pipeline.glsl, Jwift/Apple/LiquidGlass.md 7).
// Its glass, the ClearGlassView, holds the warped backdrop (its glass background reads the BackdropView under it) and
// the warped items (lensContent), and lenses them together through its content lensing, QuartzCore's
// glass_foreground_sdf: a layer's filter takes its whole subtree [C], and Apple's frames show the fringe on both.
// glass_foreground_sdf moves the read along the normal by its refraction, spreads six taps (red over the outer three,
// blue over the inner four, green over all, normalised 0.5, 1/3, 0.5, each unpremultiplied, the sum premultiplied by
// their mean alpha) along its dispersion's direction, and fades by its edge ramp. That direction is the normal turned
// by the dispersion angle with its components swapped [C: glass_foreground_base %70 to %72]. `n` is the outward
// normal on screen, `d` the depth in pt (negative inside), `inkPacked` the selection's ink (0 for none), `amount` how
// far the glass has come in. `itemCover` is how much of the pixel the lensed items cover.
vec3 GlassActiveLens(float d, vec2 n, float lens, float light, float amount, float inkPacked, out float itemCover) {
    float ease = amount * lens;
    float dpr = max(v_Lighting.x, 1e-3);
    vec2 base = v_PixelPos + n * GlassShift(d + GLASS_LENS_LENSING_REFRACTION.z, GLASS_LENS_LENSING_REFRACTION.y,
                                            GLASS_LENS_LENSING_REFRACTION.x) * dpr * ease;
    // GlassDispersion (v_Outline.xy, packed): amount and angle, height and inset.
    float amountAngle = v_Outline.x, heightInset = v_Outline.y;
    float disAmount = mod(amountAngle, 8192.0) / 64.0 - 64.0;
    float disAngle = radians(floor(amountAngle / 8192.0));
    float disHeight = mod(heightInset, 4096.0) / 32.0;
    float disInset = floor(heightInset / 4096.0) / 32.0 - 32.0;
    vec2 turned = vec2(n.x * cos(disAngle) - n.y * sin(disAngle), n.x * sin(disAngle) + n.y * cos(disAngle));
    vec2 dir = GlassSkips(GLASS_SKIP_CA) ? vec2(0.0)
        : turned.yx * GlassShift(d + disInset, disAmount, disHeight) * dpr * ease;
    vec3 sum = vec3(0.0);
    float alpha = 0.0;
    float cover;
    for (int i = 0; i < 3; i++) {
        float w = 1.0 - float(i) / 3.0;
        vec4 a = lensContent(base + w * dir, dpr, ease, inkPacked, cover);
        sum.r += a.r / max(a.a, 1e-6) * w;
        sum.g += a.g / max(a.a, 1e-6) * (1.0 - w);
        alpha += a.a;
    }
    for (int i = 0; i < 4; i++) {
        float t = float(i) / 3.0;
        vec4 b = lensContent(base - t * dir, dpr, ease, inkPacked, cover);
        sum.g += b.g / max(b.a, 1e-6) * (1.0 - t);
        sum.b += b.b / max(b.a, 1e-6) * t;
        alpha += b.a;
    }
    float ramp = GLASS_LENS_LENSING_EDGE.y > GLASS_LENS_LENSING_EDGE.x
        ? clamp((d - GLASS_LENS_LENSING_EDGE.x) / (GLASS_LENS_LENSING_EDGE.y - GLASS_LENS_LENSING_EDGE.x), 0.0, 1.0) : 0.0;
    float edge = 1.0 - mix(GLASS_LENS_LENSING_EDGE.z, GLASS_LENS_LENSING_EDGE.w, ramp);
    vec3 lensed = sum * vec3(0.5, 1.0 / 3.0, 0.5) * (alpha / 7.0);
    lensContent(base, dpr, ease, inkPacked, itemCover);
    itemCover *= amount;
    // The unlensed read is the same portal, so it keeps the selection's ink: without it a fading lens washes its twins
    // back to their raw ink, which is white for a vibrant label and vanishes on light glass.
    return mix(lensContent(v_PixelPos, dpr, 0.0, inkPacked, cover).rgb, lensed, edge * amount);
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
// Routes through the SAME continuous corner (CornerDist) as the panel silhouette and border, so a clip
// mask and the shape it masks agree corner for corner. One implementation, two callers. (This was
// `clipShapeDistance`; its three lines are inline in cornerQueries below.)

// Loop bounded by a constant so drivers with stricter GLSL ES 3.00 loop
// heuristics still unroll / accept it. Practical clip-stack depth never
// exceeds a handful.
const int MAX_CLIP_DEPTH = 16;

// Intersection of a clip stack — a pixel is inside the combined clip iff
// it's inside every individual clip. Signed distance = max of per-clip SDFs.
//
// ONE CALL SITE FOR THE CORNER FIELD, SHARED WITH THE DROP SHADOW (2026-09-22). The shadow asks the
// same question of the same function -- `CornerDist` of a rounded shape -- so it rides this loop as one
// more query after the clips (`wantShadow`, answered in `shadowDist`). On Windows FXC inlines every
// call site of a function, and the corner field (the arc and its two easing polylines) is the heaviest code in
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
        float di = CornerDist(q, halfSize, radii, smoothness);
        if (i < nClips) d = max(d, di);
        else shadowDist = di;
    }
    return d;
}


#if defined(RIM_ONLY)
// ── THE RIM PASS ──
//
// Apple's highlight pass (Glass.Pipeline.glsl GlassRim): a 1 pt band lit by the key and fill lights,
// recoloring what is already drawn under it by vibrantColorMatrix. Glass lights it in its own fragment unless
// its content reaches the band; then, and for a solid surface's edge, this program draws the same layer over
// the scene snapshot the walk takes for it (u_RimScene), at the node's BorderLayer slot.
uniform sampler2D u_RimScene;

void main() {
    vec2 pLocal;
    if (v_Is3D > 0.5) {
        pLocal = v_PanelGeom.xy + v_Local;
    } else {
        vec2 rel = v_PixelPos - v_Rot.zw;
        pLocal = vec2(rel.x * v_Rot.x + rel.y * v_Rot.y, -rel.x * v_Rot.y + rel.y * v_Rot.x) + v_Rot.zw;
    }
    vec2 halfSize = v_PanelGeom.zw;
    vec2 p = pLocal - v_PanelGeom.xy;
    float smoothness = v_StyleParams.y;
    float dpr = max(v_Lighting.x, 1e-3);
    float height = v_Specular.y;
    float dist;
    vec2 normal;
    CornerEval(p, halfSize, v_Radii, smoothness, dist, normal);
    float d = dist / dpr;
    if (-d > height + 1.0) discard;
    float unusedShadow;
    float clipD = cornerQueries(v_PixelPos, int(v_Outline.z), int(v_Outline.w), false,
                                p, halfSize, v_Radii, smoothness, unusedShadow);
    if (clipD > 1.0) discard;
    float clipAlpha = 1.0 - smoothstep(-0.5, 0.5, clipD);
    vec2 uv = v_PixelPos / u_Resolution;
    uv.y = 1.0 - uv.y;
    vec3 under = texture(u_RimScene, uv).rgb;
    vec4 rim = GlassRim(under, d, normal, GlassKeyLight(v_Rot, v_Is3D), v_Specular.x, height, GlassLaneClear(v_Lighting.w), v_RimEdge.x);
    fragColor = vec4(rim.rgb, rim.a * v_StyleParams.z * clipAlpha);
}
#else
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
    float bodyTint = v_Lighting.y;
    float chromaticAberration = GlassLaneCa(v_Specular.z);
    float glassBlur = GlassLaneBlur(v_Specular.z);
    // DesignLibrary zeroes an absent exterior layer's amount and height (Layers 0x10, 0x40; Jwift/Apple/Sheets.md).
    float glassExterior = GlassLaneExterior(v_Specular.z);
    bool glassOuterOff = mod(glassExterior, 2.0) > 0.5;
    bool glassBleedOff = glassExterior > 1.5;
    float glassFrost = GlassLaneFrost(v_Specular.z);
    float borderFade = v_Specular.w;

    vec2 p = pLocal - panelCenter;

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
        // A glass surface's shadow (mode 1 and 2) is Apple's erf fall over two radii; any other is a smoothstep.
        shadowAlpha = (v_Refraction.z > 0.5 ? GlassShadowFall(shadowDist, shadowBlur)
                                            : smoothstep(shadowBlur, -shadowBlur, shadowDist)) * v_ShadowColor.a;
    }

    // ── SDF + normal ──
    float dist;
    // The ONE substitution in the NO_SHAPE_GRADIENT variant, and the only place this lane writes a
    // line rather than deleting one. `CornerDist` and `CornerEval` return the distance of the same
    // `ContinuousCorner` call. `normal` is not declared, because nothing that survives the exclusions
    // below reads it.
#if defined(NO_SHAPE_GRADIENT)
    dist = CornerDist(p, panelHalfSize, v_Radii, effectiveSmooth);
#else
    vec2 normal;
    CornerEval(p, panelHalfSize, v_Radii, effectiveSmooth, dist, normal);
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
    // ── APPLE'S GLASS (Glass.Pipeline.glsl, Core/Glass.md) ──
    // The glassBackground pass (lens, blur, face, edge bleed, holding tone), then the tint and highlight passes,
    // all over this fragment's own face. Mode 2 is the surface's colored drop shadow, drawn before it.
    float glassDpr = max(v_Lighting.x, 1e-3);
    float glassSpan = v_Refraction.y;
    float glassClear = GlassLaneClear(v_Lighting.w);
    float glassGlow = GlassLaneGlow(v_Lighting.w);
    float glassLight = v_RimEdge.x;
    float glassShadowTint = 0.0;
    vec3 glassShadowRgb = vec3(0.0);
    if (materialType == 1.0) {
        float d = dist / glassDpr;
        vec2 nScreen = v_Is3D > 0.5 ? normal
            : vec2(v_Rot.x * normal.x - v_Rot.y * normal.y, v_Rot.y * normal.x + v_Rot.x * normal.y);
        vec2 ramps = GlassSizeRamps(glassSpan);
        if (v_Refraction.z > 1.5) {
            // The colored shadow of large glass: the backdrop past the outline, blurred at 40 pt, saturated
            // (light) or dimmed (dark), carried by v. Its alpha is the shared fall above.
            float reach = GlassShift(d, min(0.625 * glassSpan, 75.0), 0.4 * glassSpan);
            vec3 seen = glassSample(v_PixelPos + nScreen * reach * glassDpr, GlassNativeLod(40.0, glassDpr, glassClear, glassFrost));
            vec3 mapped = mix(GlassYcc(seen, 0.5, 0.0, 1.0), GlassYcc(seen, 1.0, 0.0, 1.8), glassLight);
            float layerAlpha = mix(0.2 + 0.16 * ramps.x, 1.0, ramps.y);
            glassShadowRgb = clamp(mapped * ramps.y / max(layerAlpha, 1e-3), 0.0, 1.0);
            glassShadowTint = 1.0;
        } else {
            vec3 face;
            float lensInk = 0.0;
            // The lens is its own program (ACTIVE_LENS): D3D's compiler takes seconds over its unrolled taps, so the
            // glass every page boots with leaves it out, and a batch holding a lens draws with the lens program.
#if defined(ACTIVE_LENS)
            if (v_RimEdge.z > 0.0) {
                // It comes and goes with the glass itself, so a press and a release never pop.
                face = GlassActiveLens(d, nScreen, v_RimEdge.z, glassLight, glassiness, v_RimEdge.w, lensInk);
            } else
#endif
            {
            float lens = v_Refraction.w * glassiness;
            float innerShift = GlassInnerShift(d, glassSpan) * lens;
            float outerShift = glassOuterOff ? 0.0 : GlassShift(d, 0.2 * glassSpan, 0.125 * glassSpan) * lens;
            float radius = GlassBlurRadius(glassSpan, glassClear, glassBlur, glassFrost);
            float innerLod = GlassNativeLod(radius * GlassBlurScale(d + innerShift, glassSpan), glassDpr, glassClear, glassFrost);
            vec2 innerOffset = nScreen * innerShift * glassDpr;
            // Dispersion, where a class asks for it (the moving selection lens): red at (1 + 0.2 ca) of the
            // inner shift, green at (1 + 0.1 ca), blue at the shift itself.
            float caSpreadPx = 0.2 * chromaticAberration * length(innerOffset);
            if (GlassSkips(GLASS_SKIP_CA)) caSpreadPx = 0.0;
            vec3 lensed;
            if (caSpreadPx < 0.5) {
                lensed = glassSample(v_PixelPos + innerOffset, innerLod);
            } else {
                lensed = vec3(glassSample(v_PixelPos + innerOffset * (1.0 + 0.2 * chromaticAberration), innerLod).r,
                              glassSample(v_PixelPos + innerOffset * (1.0 + 0.1 * chromaticAberration), innerLod).g,
                              glassSample(v_PixelPos + innerOffset, innerLod).b);
            }
            // The outward-looking sample, at 30% across the outermost point of regular glass, at half radius.
            float outerMix = 0.3 * (1.0 - glassClear) * clamp(d + 1.0, 0.0, 1.0);
            if (outerMix > 0.0) {
                float outerLod = GlassNativeLod(radius * GlassBlurScale(d + outerShift, glassSpan), glassDpr, glassClear, glassFrost);
                lensed = mix(lensed, glassSample(v_PixelPos + nScreen * outerShift * glassDpr, outerLod), outerMix);
            }
            face = lensed;
            if (GlassSkips(GLASS_SKIP_GRADE)) {} else
            face = GlassFace(lensed, glassSpan, glassClear, glassLight, v_RimEdge.y);
            // The edge bleed of regular glass from 64 pt: the backdrop 0.35 S outward, blurred at 0.35 S,
            // weighted toward the face's own darks on light glass and its lights on dark glass.
            if (ramps.y > 0.0 && glassClear < 1.0 && !GlassSkips(GLASS_SKIP_BLEED)) {
                float bleedShift = glassBleedOff ? 0.0 : GlassShift(d, 0.35 * glassSpan, 0.35 * glassSpan);
                vec3 bleed = GlassBleed(glassSample(v_PixelPos + nScreen * bleedShift * glassDpr,
                                                    GlassNativeLod(0.35 * glassSpan, glassDpr, glassClear, glassFrost)), glassLight);
                float lum = dot(face, GLASS_BLEED_LUMA);
                float weight = mix(1.0 - lum, lum, glassLight);
                weight = weight * weight * clamp(1.0 - d, 0.0, 1.0);
                face = mix(face, bleed, clamp(weight * weight * ramps.y * mix(0.8, 0.5, glassLight), 0.0, 1.0) * (1.0 - glassClear));
            }
            // A vibrancy that could not be drawn under the element (a press fill) rides the grade lanes.
            face = applyGrading(face, brightness, saturation, contrast);
            // .tint(color): the Background is the seed.
            if (v_Tint.a > 0.001) face = mix(face, GlassTint(face, v_Tint.rgb), v_Tint.a);
            // The holding tone: the interior at 97%, the outer one to two points at full.
            face = clamp(face * mix(1.0, 0.97, clamp(-1.0 - d, 0.0, 1.0)), 0.0, 1.0);
            }
            if (!GlassSkips(GLASS_SKIP_RIM)) {
                // The highlight recolors what the pixel will show, as the rim pass does: where the face covers
                // it only partly (the silhouette's antialiasing, a translucent surface), that is the face over
                // the backdrop, so the face carries the difference the layer makes there, over its coverage.
                float cover = fillAlpha * opacity;
                vec3 shown = cover < 0.999 ? mix(sampleBackdrop(baseUv, frostLod), face, cover) : face;
                vec2 key = GlassKeyLight(v_Rot, v_Is3D);
                vec4 rim = GlassRim(shown, d, normal, key, v_Specular.x, v_Specular.y, glassClear, glassLight);
                // The lens's lifted copy lies above its glass, so its rim never paints over an item.
                float alpha = rim.a * (1.0 - lensInk);
                face = clamp(face + alpha / max(cover, 1e-3) * (rim.rgb - shown), 0.0, 1.0);
            }
            if (glassGlow > 0.0) face = GlassPressGlow(face, glassGlow);
            if (v_TouchGlow.w > 0.0) {
                vec2 touch = (v_TouchGlow.xy * 2.0 - 1.0) * panelHalfSize;
                face = GlassPressGlow(face, v_TouchGlow.w * GlassTouchGlow(length(p - touch), v_TouchGlow.z * glassDpr));
            }
            if (v_RimEdge.z > 0.0) {
                // The lens glass's inner glow, added (plusLighter) inside its outline, under the lifted items as the
                // glass's own layer is.
                float glow = GLASS_LENS_INNER_GLOW.x * GLASS_LENS_INNER_GLOW.y * (1.0 - GlassShadowFall(d, 2.0 * GLASS_LENS_INNER_GLOW.z));
                face = min(face + glow * glassiness * (1.0 - lensInk), vec3(1.0));
                // The lens's inner shadow, inverted: the outside cast GLASS_LENS_INNER_SHADOW.z pt down into it,
                // its radius and opacity Apple's. The shifted depth to first order along the normal.
                float shifted = d - dot(nScreen, vec2(0.0, GLASS_LENS_INNER_SHADOW.z));
                face *= 1.0 - GLASS_LENS_INNER_SHADOW.y * glassiness * (1.0 - GlassShadowFall(shifted, 2.0 * GLASS_LENS_INNER_SHADOW.x));
            }
            backdrop = face;
        }
    } else if (hasBackdropFilter) {
        // Flat panel backdrop sampling — no refraction, no CA.
        vec3 s = sampleBackdrop(baseUv, frostLod);
        backdrop = applyTint(applyGrading(s, brightness, saturation, contrast), bodyTint);
    }
#endif

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
    if (materialType == 1.0) {
        // Glass's Background is its tint seed, already in the face.
        fillRgb = backdrop;
        fillA = fillAlpha;
    } else if (hasBackdropFilter) {
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
    // The colored shadow draw carries no face: the shadow alone, where the surface is not.
    if (glassShadowTint > 0.5) result = vec4(glassShadowRgb, shadowAlpha * (1.0 - fillAlpha));
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

    fragColor = u_VibrancyCover < 0.0 ? result : vec4(result.rgb * result.a, result.a * u_VibrancyCover);
}
#endif
