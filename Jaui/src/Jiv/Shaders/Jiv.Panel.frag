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
flat in vec4 v_Refraction;     // thickness, bezelWidth, refractionStrength, bezelScale
flat in vec4 v_Lighting;       // lightAngle (rad), bodyTint (signed), lightIntensity, fresnelStrength
flat in vec4 v_Specular;       // specIntensity, specSharpness, chromaticAberration, innerBlur
flat in vec4 v_RimEdge;        // edgeLightTop, edgeLightBottom, borderVariance, bulge
flat in vec4 v_Outline;        // packed rim amounts, packed Fresnel grade, clipOffset, clipCount
                               // .x = alphaVariance*2047 * 4096 + fresnelStrength*1024
                               // .y = fresnelBrightness*256 * 1024 + fresnelSaturation*256
                               // (Jiv.InstanceBuffer._packOutlineAmounts / _packFresnelGrade. There is
                               //  no 17th vertex attribute to be had: WebGL2 caps at 16.)
flat in vec4 v_BorderFilter;   // brightnessMul, saturationMul, contrastMul, lodOffset

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
// Under MATERIAL_FLAT the normal returned by `ShapeEval` feeds exactly ONE chain — the border's
// `keyAlign`/`widthScale`/`borderCoverage` — and at BorderWidth 0 that chain's output is the
// EXACT float 0, so the two blends it drives are `x * 1.0 + c * 0.0`: a no-op in IEEE for finite
// x and c. This is the one place in the lane's two exclusions that removes instructions whose
// RESULT is provably zero rather than instructions that are unreachable. The arithmetic is
// written out in `tests/Borderless.Program.test.ts` and in `Perf/Borderless.Finding.md`.
//
// With that chain gone the only surviving consumer of the corner field is its DISTANCE, and
// `CornerDist` (below, already used by the clip stack and the shadow pass) returns it without
// `ShapeGrad_inner` — "two pow() calls, a length and a normalize" by this file's own comment —
// and without `SS_PillEval`'s closest-point tracking. The routing's `pillW == 0` term is what
// makes the substitution bit-identical BY INSPECTION: on that leg both functions return
// `ShapeSDF_inner(p, halfSize, vec2(rCorner), n)` off the same `CornerParams`. The pill leg is
// NOT admitted — `SS_PillSDF` and `SS_PillEval` are different function bodies, and a CPU port
// proving their distances bit-equal cannot speak for a GPU compiler's freedom to contract
// `a + t*ab` differently in a loop that also tracks a closest point.
//
// ── THE GLASS PROGRAM'S OWN VARIANTS (lane glassreg) ──
//
// Each is defined only TOGETHER with MATERIAL_GLASS, and each is a batch-level define routed by
// `WebGL2Renderer._glassBatchKind` off the packed instance floats, every instance of the batch
// answering yes or the batch taking the full program (and being counted as a fallback).
//
//   GLASS_BORDER_ONLY   every instance is a rim overlay (`v_StyleParams.x < 0`). The body's tap
//                       chain, its grade, the absorption, the shadow, the fill composite, the rim
//                       glow, the hemispherical ambient and the catchlight are excluded. Each is
//                       either runtime-dead on such an instance (the body taps, the rim glow, the
//                       shadow at alpha 0) or composites into a `result` that is exactly vec4(+0)
//                       with `fillAlpha` exactly 0, where `r*(1-e) + c*e` and `r + x*0` return +0
//                       for every finite x, c and e. The border zone and everything it reads stay.
//   GLASS_NO_GLOW       every instance has FresnelStrength exactly +0: the wide rim glow's block
//                       is excluded, so `edgeLightAlpha` / `edgeLightRgb` keep their 0.0 initialisers
//                       where the block would have produced +0 and a finite colour. The composite
//                       stays, and is `r*1 + (+0)` on both sides.
//   GLASS_NO_SPEC       every instance has SpecularIntensity exactly +0: the catchlight and the
//                       rim-specular line are excluded. `specAlpha` would have been +-0 and
//                       `rimSpecAlpha > 0.0` false.
//   GLASS_REG           register-LIFETIME hygiene: the same statements in a different order, so
//                       the drop shadow's corner field runs beside the main one, the fill
//                       composite runs straight after the taps (the backdrop dies there), and the
//                       chain the border and the rim glow read is computed after both. No
//                       expression is rewritten; `tests/Glass.Reg.test.ts` holds the two programs
//                       to being permutations of each other's lines.
//   GLASS_REG_REMAT     on top of GLASS_REG: three cheap values RECOMPUTED where they are next
//                       needed instead of held (`pLocal`, `edgeDist`, `glassiness`), each by a
//                       second copy of its own defining statement.
//   GLASS_NO_SKIP_GATES `?glass-skip`'s ten uniform gates folded to false: the glass program as
//                       it was before lane glassdraw added them, keeping that lane's moved lines.
//                       The arm that says whether the -43% of 62cfb35 was its line moves or its
//                       branches.
//   GLASS_NO_GATE_<S>   (lane gatebisect) ONE of those ten gates folded to false, S one of BACKDROP
//                       CA RIM SPECULAR BORDER SDF GRADE SHADOW SKIRT CLIP; all ten together are
//                       GLASS_NO_SKIP_GATES' text exactly. The bisect of what the ten were worth.
//   GLASS_GATE_<S>      (lane gatebisect) a NEW uniform gate, TRUE on every draw, around one heavy
//                       statement that runs unconditionally today, S one of BEZEL REFRACT LOD GRAD
//                       ABSORB AMBIENT. The statements inside are the shipped ones; a value a gated
//                       block hands on is declared ahead of the gate and assigned by the same
//                       expression. A control-flow boundary and nothing else.
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
// Specular tilt — added to lightDir ONLY for specular computations (bevel
// catchlight and rim-spec highlight), not for ambient/edge-light/border
// directionality. Canvas-wide, set by pointer or gyro each frame. This
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
// tables to each other.
uniform int u_GlassSkip;
const int GLASS_SKIP_BACKDROP = 1;     // every backdrop tap returns GLASS_SKIP_FLAT
const int GLASS_SKIP_CA       = 2;     // chromatic spread off: the 3-tap fill path becomes 1
const int GLASS_SKIP_RIM      = 4;     // the wide rim glow: its tap and its lighting math
const int GLASS_SKIP_SPECULAR = 8;     // the Blinn-Phong catchlight and the rim-specular line + tap
const int GLASS_SKIP_BORDER   = 16;    // the border zone: its band shape, its tap, its Fresnel
const int GLASS_SKIP_SDF      = 32;    // every corner-field evaluation becomes a sharp-rect distance
const int GLASS_SKIP_GRADE    = 64;    // the body grade + tint as identity (the border zone grades under border)
const int GLASS_SKIP_SHADOW   = 128;   // the drop shadow as 0
const int GLASS_SKIP_SKIRT    = 256;   // discard outside the face's padded box, before anything
const int GLASS_SKIP_CLIP     = 512;   // the clip stack as "inside everything"
const vec3 GLASS_SKIP_FLAT = vec3(0.5);
// ?glass-gates' BISECT (`Core/Glass.Programs.ts`): GLASS_NO_GATE_<STAGE> compiles that one stage's
// gate away, the way GLASS_NO_SKIP_GATES compiles all ten away, and nothing else. The call sites are
// untouched; what changes is which bits `GlassSkips` can ever answer yes for. A stage whose bit is
// out of GLASS_GATES_KEPT answers `(u_GlassSkip & 0) != 0` - a constant false once the call is
// inlined, the same fold that turns GLASS_NO_SKIP_GATES' `return false` into no branch - so its gate
// statement folds to the code its not-skipped side ran. With the mask at 0 on the uniform (the only
// value `?glass-gates` allows beside it) every kept gate takes that side too: the same arithmetic on
// every fragment, only the control flow differs. All ten defined is the `#else`: exactly the
// GLASS_NO_SKIP_GATES line, so `?glass-gates=all` IS `?glass-reg=nogates`, byte for byte.
#if defined(MATERIAL_GLASS) && !defined(GLASS_NO_SKIP_GATES) && !(defined(GLASS_NO_GATE_BACKDROP) || defined(GLASS_NO_GATE_CA) || defined(GLASS_NO_GATE_RIM) || defined(GLASS_NO_GATE_SPECULAR) || defined(GLASS_NO_GATE_BORDER) || defined(GLASS_NO_GATE_SDF) || defined(GLASS_NO_GATE_GRADE) || defined(GLASS_NO_GATE_SHADOW) || defined(GLASS_NO_GATE_SKIRT) || defined(GLASS_NO_GATE_CLIP))
bool GlassSkips(int bit) { return (u_GlassSkip & bit) != 0; }
#elif defined(MATERIAL_GLASS) && !defined(GLASS_NO_SKIP_GATES) && !(defined(GLASS_NO_GATE_BACKDROP) && defined(GLASS_NO_GATE_CA) && defined(GLASS_NO_GATE_RIM) && defined(GLASS_NO_GATE_SPECULAR) && defined(GLASS_NO_GATE_BORDER) && defined(GLASS_NO_GATE_SDF) && defined(GLASS_NO_GATE_GRADE) && defined(GLASS_NO_GATE_SHADOW) && defined(GLASS_NO_GATE_SKIRT) && defined(GLASS_NO_GATE_CLIP))
const int GLASS_GATES_KEPT = 0
#if !defined(GLASS_NO_GATE_BACKDROP)
    | GLASS_SKIP_BACKDROP
#endif
#if !defined(GLASS_NO_GATE_CA)
    | GLASS_SKIP_CA
#endif
#if !defined(GLASS_NO_GATE_RIM)
    | GLASS_SKIP_RIM
#endif
#if !defined(GLASS_NO_GATE_SPECULAR)
    | GLASS_SKIP_SPECULAR
#endif
#if !defined(GLASS_NO_GATE_BORDER)
    | GLASS_SKIP_BORDER
#endif
#if !defined(GLASS_NO_GATE_SDF)
    | GLASS_SKIP_SDF
#endif
#if !defined(GLASS_NO_GATE_GRADE)
    | GLASS_SKIP_GRADE
#endif
#if !defined(GLASS_NO_GATE_SHADOW)
    | GLASS_SKIP_SHADOW
#endif
#if !defined(GLASS_NO_GATE_SKIRT)
    | GLASS_SKIP_SKIRT
#endif
#if !defined(GLASS_NO_GATE_CLIP)
    | GLASS_SKIP_CLIP
#endif
    ;
bool GlassSkips(int bit) { return (u_GlassSkip & (GLASS_GATES_KEPT & bit)) != 0; }
#else
bool GlassSkips(int bit) { return false; }
#endif

// ?glass-gates' EXTENSION: `+<stage>` puts a NEW uniform gate around a heavy statement that runs
// unconditionally today. `u_GlassGate` is uploaded as GLASS_GATE_OPEN (every bit set) on every glass
// draw (`WebGL2Renderer.PanelDrawBatch`), so each gate's condition is TRUE on the shipped path and
// the statements inside run exactly as they do without it; the gate's only effect is the
// control-flow boundary. Declared only in a program cut with one of the six defines, so the shipped
// programs do not contain a token of it. The bit values are `Glass.Programs.GLASS_GATE_BARRIERS`.
#if defined(MATERIAL_GLASS) && (defined(GLASS_GATE_BEZEL) || defined(GLASS_GATE_REFRACT) || defined(GLASS_GATE_LOD) || defined(GLASS_GATE_GRAD) || defined(GLASS_GATE_ABSORB) || defined(GLASS_GATE_AMBIENT))
uniform int u_GlassGate;
const int GLASS_BARRIER_BEZEL   = 1;     // the bezel hump: four smoothsteps into `bend` / `hump`
const int GLASS_BARRIER_REFRACT = 2;     // the refraction offset: rotated normal, bulge, clamp
const int GLASS_BARRIER_LOD     = 4;     // the rim blur LOD: rim boost, fwidth footprint, frost ramp
const int GLASS_BARRIER_GRAD    = 8;     // ShapeGrad_inner, split from ShapeSDF_inner in CornerEval
const int GLASS_BARRIER_ABSORB  = 16;    // the Beer-Lambert absorption: a vec3 pow
const int GLASS_BARRIER_AMBIENT = 32;    // the hemispherical rim ambient: a pow and its composite
bool GlassGate(int bit) { return (u_GlassGate & bit) != 0; }
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
// Generated by tests/Pill.PolylineGen.test.ts; do not hand-edit — re-run that
// test to regenerate. 32 segments → sub-pixel accuracy on 60-tall pills.
const int SS_PILL_POINT_COUNT = 33;
const vec2 SS_PILL_CURVE[33] = vec2[](
  vec2(0.00000000, 1.00000000),
  vec2(0.04265581, 0.99999445),
  vec2(0.08531159, 0.99993035),
  vec2(0.12796709, 0.99969402),
  vec2(0.17062123, 0.99912542),
  vec2(0.21327087, 0.99802453),
  vec2(0.25590906, 0.99615489),
  vec2(0.29852244, 0.99324588),
  vec2(0.34108789, 0.98899457),
  vec2(0.38356831, 0.98306800),
  vec2(0.42590761, 0.97510672),
  vec2(0.46802503, 0.96473086),
  vec2(0.50980938, 0.95155004),
  vec2(0.55111404, 0.93517850),
  vec2(0.59175424, 0.91525605),
  vec2(0.63150841, 0.89147416),
  vec2(0.67012530, 0.86360450),
  vec2(0.70733754, 0.83152444),
  vec2(0.74288036, 0.79523315),
  vec2(0.77651200, 0.75485312),
  vec2(0.80803128, 0.71061553),
  vec2(0.83728806, 0.66283306),
  vec2(0.86418529, 0.61186710),
  vec2(0.88867327, 0.55809644),
  vec2(0.91073888, 0.50189257),
  vec2(0.93039268, 0.44360330),
  vec2(0.94765574, 0.38354448),
  vec2(0.96254728, 0.32199785),
  vec2(0.97507274, 0.25921346),
  vec2(0.98521039, 0.19541521),
  vec2(0.99289197, 0.13080918),
  vec2(0.99796172, 0.06559637),
  vec2(1.00000000, 0.00000000)
);

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

    for (int i = 0; i < SS_PILL_POINT_COUNT - 1; i++) {
        vec2 a = vec2(SS_PILL_CURVE[i].x * maxExtent, SS_PILL_CURVE[i].y * halfY);
        vec2 b = vec2(SS_PILL_CURVE[i+1].x * maxExtent, SS_PILL_CURVE[i+1].y * halfY);
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

    for (int i = 0; i < SS_PILL_POINT_COUNT - 1; i++) {
        vec2 a = vec2(SS_PILL_CURVE[i].x * maxExtent, SS_PILL_CURVE[i].y * halfY);
        vec2 b = vec2(SS_PILL_CURVE[i+1].x * maxExtent, SS_PILL_CURVE[i+1].y * halfY);
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
    // `+grad`: a boundary between the distance's pow()s and the gradient's. A pure barrier - the
    // gradient feeds the refraction, the border chain and the rim, so no amount makes it skippable.
#if defined(MATERIAL_GLASS) && defined(GLASS_GATE_GRAD)
    if (GlassGate(GLASS_BARRIER_GRAD)) {
#endif
    if (pillW <= 0.0) {
        distOut = dSuper;
        gradOut = ShapeGrad_inner(p, halfSize, vec2(rCorner), n);
        return;
    }
#if defined(MATERIAL_GLASS) && defined(GLASS_GATE_GRAD)
    }
#endif
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

// Sample the backdrop at per-Jiv blur strength. When the effective LOD is
// zero — i.e. the Jiv asked for no frost and isn't at a rim-boosted glass
// edge — sample the raw scene snapshot (u_Scene), NOT the pyramid. The
// pyramid's LOD 0 has a ~1px Gaussian baked in (baseBlurCssPx = 1 inside
// ComputeBlur) so defaulting to it made flat panels with just
// BackdropBrightness look subtly blurred. `frostLod` is this Jiv's
// log2(BackdropFrostBlur * DPR); `extraLod` is glass rim-boost /
// inner-blur additions. One textureLod call = one Gaussian; one texture
// call = no filter.
vec3 sampleBackdrop(vec2 uv, float extraLod, float frostLod) {
    if (GlassSkips(GLASS_SKIP_BACKDROP)) return GLASS_SKIP_FLAT;
    float lod = max(0.0, frostLod - u_BaseFrostLod) + extraLod;
    // Every displaced/rim/CA tap comes through here, so the region map is applied ONCE, in one
    // place: two mads. `uv` stays the screen UV every caller computed, which is also what the
    // u_Scene branch below needs.
    vec2 backdropUv = uv * u_BackdropXf.xy + u_BackdropXf.zw;
    // Raw (unblurred) scene ONLY for panels that authored NO frost and have
    // no rim/inner boost (e.g. a flat panel with just BackdropBrightness).
    // Gate on frostLod, NOT the derived lod: the pyramid is now built at the
    // panel's own frost sigma with u_BaseFrostLod == frostLod, so a frosted
    // panel's blur lives at LOD 0 and its center lod rounds to 0 — it must
    // still sample the pyramid, or the frosted center shows the raw scene
    // (refracted but unblurred).
    if (frostLod < 0.01 && extraLod < 0.01) return texture(u_Scene, uv).rgb;
    return textureLod(u_Backdrop, backdropUv, lod).rgb;
}

#if defined(BORDER_DIRECT)
// ── THE GLASS BORDER'S BACKDROP, COMPUTED HERE INSTEAD OF IN A PYRAMID ─────────────────────────
//
// Under this variant `u_Backdrop` is NOT a pyramid. It is one blit of the scene over this
// border's own region rect — the same rect the pyramid was built over, so `u_BackdropXf` is the
// same map it always was — and the four passes that used to turn it into a pyramid run here, per
// fragment, over the band the border actually reads. See `Core/Border.Direct.ts` for the
// admission rule this whole function assumes: k = 1, depth = 2, maxLod = 0, tap offset < 0.75,
// and a region whose extent is a multiple of 4 so every halving is exact.
//
// The arithmetic below is `BlurPass`'s, hop for hop and tap for tap, with ONE substitution: the
// two DOWN hops are replaced by a 4x4 box, which is what they provably are at a tap offset of 1 or
// less (the corner taps of a hop sum to `(u+v)x(u+v)` with `u + v = (1,1)`, so each hop is a 2x2
// box). `tests/Border.Kernel.test.ts` pushes a delta through a CPU port of all four hops and
// asserts it: a source texel reaches exactly ONE level-2 cell, at weight 1/16 -- algebraically
// exact, and in float to a ulp of the accumulation, which is thirteen orders under the 1/1023
// quantum a pyramid level is stored at.
//
// What this path does NOT do is round through four RGB10_A2 intermediates — the pyramid quantises
// to 10 bits at every level on the way down and again on the way up, and this does not. So where
// the two differ they differ by up to a bit of the 8-bit result, and the direct answer is the
// truer one.
uniform vec2 u_BorderTexels;   // level 0 (= the copied region) in texels
uniform float u_BorderTap;     // the pyramid's own tapOffset for this build
// 1.0 = gather (the arm above, and the only one that draws a correct picture); 0.0 = take the one
// flat tap instead and leave everything else in the frame identical. A UNIFORM rather than a
// define, and that is the whole point of it: the compiler cannot fold a uniform, so the gather
// below stays COMPILED and its dynamically-indexed `_bdL2` / `_bdL1` windows stay allocated on
// every thread of this program's draws whichever value it holds. `?border-direct=skipgather` is
// therefore this program at this program's occupancy with the band work removed, which is the one
// arm that can separate "the taps cost" from "the program costs" -- see the M4's borderdirect
// cell, where 80 removed passes and 80 removed draws made the frame 2.59 ms SLOWER.
uniform float u_BorderGather;

// The level-2 window (4x4 boxes of the source) and the level-1 window (3x3) one level-0 texel
// reads. File scope rather than function parameters: GLSL ES 3.00 sized-array parameters are
// legal but unevenly optimised, and these are read by three functions in one call chain.
vec3 _bdL2[16];
vec3 _bdL1[9];
vec2 _bdQ0;                    // level-2 index of _bdL2[0]
vec2 _bdM0;                    // level-1 index of _bdL1[0]

// Bilinear over the level-2 window, in level-2 texel coordinates. The window holds CLAMPED cells,
// so a tap that left the region reads the same replicated cell CLAMP_TO_EDGE gave the pyramid —
// and the clamp is applied at the LEVEL-2 index, never at the source coordinate, because
// replicating source texels and then boxing them is a different number from replicating the box.
vec3 _bdTapL2(vec2 pos) {
    vec2 c = pos - 0.5;
    vec2 f0 = floor(c);
    vec2 fr = c - f0;
    ivec2 k = ivec2(f0 - _bdQ0);   // in [0, 2] on both axes; see BORDER_DIRECT_L2_WINDOW
    int i0 = k.x, j0 = k.y;
    vec3 a = mix(_bdL2[j0 * 4 + i0],       _bdL2[j0 * 4 + i0 + 1],       fr.x);
    vec3 b = mix(_bdL2[(j0 + 1) * 4 + i0], _bdL2[(j0 + 1) * 4 + i0 + 1], fr.x);
    return mix(a, b, fr.y);
}

vec3 _bdTapL1(vec2 pos) {
    vec2 c = pos - 0.5;
    vec2 f0 = floor(c);
    vec2 fr = c - f0;
    ivec2 k = ivec2(f0 - _bdM0);   // in [0, 1] on both axes; see BORDER_DIRECT_L1_WINDOW
    int i0 = k.x, j0 = k.y;
    vec3 a = mix(_bdL1[j0 * 3 + i0],       _bdL1[j0 * 3 + i0 + 1],       fr.x);
    vec3 b = mix(_bdL1[(j0 + 1) * 3 + i0], _bdL1[(j0 + 1) * 3 + i0 + 1], fr.x);
    return mix(a, b, fr.y);
}

// `BlurPass.UP_FRAG`'s eight taps, in the same order, over the level-2 window. `h` is
// `u_HalfPixel * u_Offset` expressed in the SOURCE level's own texels — `0.5 * tapOffset`, which
// is exactly what `0.5 / srcW * t` is once the normalized coordinate is multiplied back out.
vec3 _bdUpFromL2(vec2 pos, float h) {
    vec3 s  = _bdTapL2(pos + vec2(-h * 2.0, 0.0));
    s += _bdTapL2(pos + vec2(-h,  h)) * 2.0;
    s += _bdTapL2(pos + vec2(0.0,  h * 2.0));
    s += _bdTapL2(pos + vec2( h,  h)) * 2.0;
    s += _bdTapL2(pos + vec2( h * 2.0, 0.0));
    s += _bdTapL2(pos + vec2( h, -h)) * 2.0;
    s += _bdTapL2(pos + vec2(0.0, -h * 2.0));
    s += _bdTapL2(pos + vec2(-h, -h)) * 2.0;
    return s / 12.0;
}

vec3 _bdUpFromL1(vec2 pos, float h) {
    vec3 s  = _bdTapL1(pos + vec2(-h * 2.0, 0.0));
    s += _bdTapL1(pos + vec2(-h,  h)) * 2.0;
    s += _bdTapL1(pos + vec2(0.0,  h * 2.0));
    s += _bdTapL1(pos + vec2( h,  h)) * 2.0;
    s += _bdTapL1(pos + vec2( h * 2.0, 0.0));
    s += _bdTapL1(pos + vec2( h, -h)) * 2.0;
    s += _bdTapL1(pos + vec2(0.0, -h * 2.0));
    s += _bdTapL1(pos + vec2(-h, -h)) * 2.0;
    return s / 12.0;
}

// The direct twin of `sampleBackdrop`, for the border zone's ONE tap. Same signature, same
// `u_Scene` branch (a panel that authored no frost still reads the raw scene, and the walk still
// hands it the same snapshot), same region map — only the pyramid read is replaced.
//
// `lod` is not computed because it cannot matter: the admission rule requires `maxLod == 0`, which
// is where the pyramid calls `DisableMipmap` and every LOD resolves to level 0 anyway.
vec3 sampleBackdropDirect(vec2 uv, float extraLod, float frostLod) {
    if (frostLod < 0.01 && extraLod < 0.01) return texture(u_Scene, uv).rgb;
    vec2 inv = 1.0 / u_BorderTexels;
    // The level-0 texel this tap lands on. The border's `bUv` is the fragment's own screen
    // position when the rim gathers straight down (`solidness == 0`, which
    // `_batchTakesBorderDirectProgram` is what guarantees), so this lands on a texel CENTRE and
    // the hardware bilinear the pyramid path would have run is the identity.
    vec2 p = floor((uv * u_BackdropXf.xy + u_BackdropXf.zw) * u_BorderTexels);
    float t = u_BorderTap;
    float h = 0.5 * t;
    vec2 l1n = floor(u_BorderTexels * 0.5);
    vec2 l2n = floor(u_BorderTexels * 0.25);
    vec2 x1 = (p + 0.5) * 0.5;                 // the level-0 texel's centre, in level-1 texels
    _bdM0 = floor(x1 - t - 0.5);
    vec2 x2 = (_bdM0 + 0.5) * 0.5;             // that window's first level-1 texel, in level-2
    _bdQ0 = floor(x2 - t - 0.5);

    // Level 2 is an exact 4x4 box of the source, so each cell is four bilinear taps at the four
    // quadrant corners — a bilinear tap at an integer texel coordinate is the mean of the 2x2
    // straddling it, at weights exactly 0.25 each.
    for (int j = 0; j < 4; j++) {
        for (int i = 0; i < 4; i++) {
            vec2 q = clamp(_bdQ0 + vec2(float(i), float(j)), vec2(0.0), l2n - 1.0);
            vec2 b = q * 4.0;
            vec3 s  = textureLod(u_Backdrop, (b + vec2(1.0, 1.0)) * inv, 0.0).rgb;
            s += textureLod(u_Backdrop, (b + vec2(3.0, 1.0)) * inv, 0.0).rgb;
            s += textureLod(u_Backdrop, (b + vec2(1.0, 3.0)) * inv, 0.0).rgb;
            s += textureLod(u_Backdrop, (b + vec2(3.0, 3.0)) * inv, 0.0).rgb;
            _bdL2[j * 4 + i] = s * 0.25;
        }
    }
    for (int j = 0; j < 3; j++) {
        for (int i = 0; i < 3; i++) {
            // Clamped at the LEVEL-1 index for the same reason the level-2 fetch is: the UP hop
            // into level 0 reads level 1 through CLAMP_TO_EDGE, so a window cell outside the
            // region has to hold the replicated level-1 texel, not a level-1 texel computed from
            // replicated level-2 cells.
            vec2 m = clamp(_bdM0 + vec2(float(i), float(j)), vec2(0.0), l1n - 1.0);
            _bdL1[j * 3 + i] = _bdUpFromL2((m + 0.5) * 0.5, h);
        }
    }
    return _bdUpFromL1(x1, h);
}
#endif
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
float clipShapeDistance(vec2 pixel, vec4 rect, vec4 radii, float smoothness) {
    vec2 center = rect.xy + rect.zw * 0.5;
    vec2 halfSize = rect.zw * 0.5;
    return ShapeSDF(pixel - center, halfSize, radii, smoothness, 0);
}

// Loop bounded by a constant so drivers with stricter GLSL ES 3.00 loop
// heuristics still unroll / accept it. Practical clip-stack depth never
// exceeds a handful.
const int MAX_CLIP_DEPTH = 16;

// Intersection of a clip stack — a pixel is inside the combined clip iff
// it's inside every individual clip. Signed distance = max of per-clip SDFs.
float clipStackDistance(vec2 pixel, int offset, int count) {
#if !defined(MATERIAL_FLAT)
    if (GlassSkips(GLASS_SKIP_CLIP)) return -1e20;
#endif
    float d = -1e20;
    for (int i = 0; i < MAX_CLIP_DEPTH; i++) {
        if (i >= count) break;
        int base = (offset + i) * 3;
        vec4 rect = texelFetch(u_ClipTex, ivec2(base, 0), 0);
        vec4 radii = texelFetch(u_ClipTex, ivec2(base + 1, 0), 0);
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
        d = max(d, clipShapeDistance(local, rect, radii, meta.x));
    }
    return d;
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
    float clipD = clipStackDistance(v_PixelPos, int(v_Outline.z), int(v_Outline.w));
    if (clipD > 1.0) discard;
    float clipAlpha = 1.0 - smoothstep(-0.5, 0.5, clipD);

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
    // the one chain that reads it is excluded below, so the read has no consumer there.
    float borderWidth = v_ShadowParams.w;
#endif
    // Border-only flag: BorderLayer's glass overlay encodes "paint ONLY the
    // glass border, skip fill/shadow" as a NEGATIVE borderEdgeAa (the feather
    // is otherwise always >= 0). The frag still needs the magnitude for the
    // stroke feather, so abs() it immediately and keep the sign as the flag.
    float borderOnly = v_StyleParams.x < 0.0 ? 1.0 : 0.0;
    float borderEdgeAa = abs(v_StyleParams.x);
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
    float bezelWidth = max(v_Refraction.y, 0.5);
    float refractionStrength = v_Refraction.z;
    float bezelScale = max(v_Refraction.w, 0.05);

#if !defined(GLASS_REG)
    vec2 lightDir = vec2(cos(v_Lighting.x), -sin(v_Lighting.x));
#endif
    float bodyTint = v_Lighting.y;
    float lightIntensity = v_Lighting.z;
    float fresnelStrength = v_Lighting.w;

    float specIntensity = v_Specular.x;
    float specSharpness = max(v_Specular.y, 1.0);
    float chromaticAberration = v_Specular.z;
    // v_Specular.w packs the border's inward fade (device px, quarter steps) above InnerBlur (thousandths).
    float _blurFadePacked = v_Specular.w;
    float _fadeUnits = floor(_blurFadePacked / 1024.0);
    float borderFade = _fadeUnits / 4.0;
    float innerBlur = (_blurFadePacked - _fadeUnits * 1024.0) / 1000.0;

    float edgeLightTop = v_RimEdge.x;
    float edgeLightBottom = v_RimEdge.y;
    float borderVariance = v_RimEdge.z;
    float bulge = v_RimEdge.w;

    vec2 p = pLocal - panelCenter;

    // Shape mode — Rect uses the user's Smoothness as the superellipse exponent;
    // Pill/Circle bake their own exponent in ShapeSDF/ShapeGrad and ignore this.
    int mode = ShapeMode(panelHalfSize, v_Radii);
    float effectiveSmooth = smoothness;

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
#if defined(GLASS_REG) && !defined(GLASS_BORDER_ONLY)
    // GLASS_REG: the drop shadow (below, after the rim glow, is where the other programs have it)
    // runs HERE, beside the main corner field, while almost nothing else is live. What it hands
    // on is one float; what it used to hold across its own corner field was the whole body.
    float shadowAlpha = 0.0;
    if (GlassSkips(GLASS_SKIP_SHADOW)) {} else
    if (v_ShadowColor.a > 1e-4) {
        vec2 sp = p - shadowOffset;
        float shadowDist = ShapeSDF(sp, panelHalfSize, v_Radii, effectiveSmooth, mode);
        shadowAlpha = smoothstep(shadowBlur, -shadowBlur, shadowDist) * v_ShadowColor.a;
    }
#endif
    float edgeDist = max(-dist, 0.0);                 // positive inside

    // ── Bezel hump (pincushion profile) ──
    // Pincushion y = (x/s) * e^(1 - x/s) peaks at x=s and decays exponentially
    // toward 0 as x grows (by x=3 it's already < 2e-4 of peak). The old code
    // multiplied by `smoothstep(1.2, 0.8, x)` to force-kill the tail, which
    // created a visible seam where refraction abruptly stops. Remove that cap
    // and let the exponential decay handle the interior — matches Apple's
    // "continuous bevel → flat interior" profile with no boundary ring.
    float x = edgeDist / bezelWidth;
    float s = bezelScale;
    // A smooth bump that lives inside the bezel: it rises from the outline to its peak at BezelScale of
    // the width and eases back to flat by the width, with zero slope at both ends. The pincushion tail
    // bent twice the bezel and reached the cells inside a pill; a hard cutoff drew a line where the
    // bend stopped. Magnification is the slope of the displacement, so the slope must never jump.
    // The lens edge is signed, as a dome's is. In the first part of the bezel (to BezelScale of the width)
    // the surface bends light so the outline shows what lies OUTSIDE the panel: measured on the iPhone, a
    // dark band over a dark page, the icon that sits above the bar. Past it the bend reverses and pulls
    // the interior toward the edge, easing to flat by the width. About 12px outward at the outline and
    // 5px inward peaking mid-bezel on the iPhone, so the inward half carries 0.4 of the outward.
    //
    // `+bezel`: the two bands inside a gate, and the two values they hand on declared ahead of it and
    // assigned by the same expressions. It could skip on an amount only where both readers vanish
    // (Thickness x Refraction 0 AND ChromaticAberration 0); glass-grid has neither, so it is a
    // pure barrier there.
#if defined(MATERIAL_GLASS) && defined(GLASS_GATE_BEZEL)
    float bend;
    float hump;
    if (GlassGate(GLASS_BARRIER_BEZEL)) {
#endif
    float outwardBand = smoothstep(0.0, s * 0.4, x) * (1.0 - smoothstep(s * 0.4, s, x));
    float inwardBand = smoothstep(s, (s + 1.0) * 0.5, x) * (1.0 - smoothstep((s + 1.0) * 0.5, 1.0, x));
#if defined(MATERIAL_GLASS) && defined(GLASS_GATE_BEZEL)
    bend = 0.4 * inwardBand - outwardBand;
    hump = max(inwardBand, outwardBand);
    }
#else
    float bend = 0.4 * inwardBand - outwardBand;
    float hump = max(inwardBand, outwardBand);
#endif

    // ── Fill alpha (shape mask) ──
    // Silhouette AA is hardcoded ~0.5px — BorderBlur must NOT fade the
    // panel outline, or a soft border would just dissolve the whole edge.
    // `aa` below is the border-stroke feather, applied only to the border
    // smoothsteps. Floor at a tiny epsilon so BorderBlur=0 still yields a
    // valid (hard-step) smoothstep.
    float fillAlpha = 1.0 - smoothstep(-0.5, 0.5, dist);
#if !defined(GLASS_REG)
    float aa = max(borderEdgeAa, 1e-4);
#endif

    // ── Backdrop sample with refraction + chromatic aberration + variable LOD ──
    //
    // Show Studio combines TWO displacement fields:
    //   1) Edge refraction — rotated outward normal, scaled by `hump`, sampled INWARD
    //      (negative of the rotated normal) so rim content is pulled from further in.
    //   2) Surface bulge — radial direction from the panel CENTER outward, scaled by
    //      a dome profile. This offsets the whole panel like a convex lens.
    //
    // The sum is applied as a UV offset when sampling the backdrop.
    vec3 backdrop = vec3(0.0);
    // Hoisted so the border-zone refilter can reuse them
    float lodBoost = 0.0;
    vec2 baseUv = v_PixelPos / u_Resolution;
    baseUv.y = 1.0 - baseUv.y;

    // Backdrop filter is universal — any jiv with non-default brightness/saturation/
    // contrast/frostLod samples the backdrop, regardless of material. Glass layers
    // refraction + CA + bezel on top; flat panels get a clean filtered sample.
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

    // Continuous glass intensity. Drives every rim/inner effect that would
    // otherwise pop on/off when Thickness flips between 0 and >0 (since the
    // shader-variant choice flips with it). Multiplying lodBoost, the inner
    // dark line, and the rim-spec highlight by this makes MATERIAL_GLASS at
    // Thickness=0 produce the same output as MATERIAL_NONE — every glass
    // effect fades smoothly with its physical driver, no discontinuity.
    float glassiness = smoothstep(0.0, 1.0, thickness);

#if !defined(MATERIAL_FLAT)
    if (materialType == 1.0) {
        // `+refract`: the offset chain inside a gate, `refractOffset` declared ahead of it and
        // assigned by the same expression. It could skip on RefractionStrength exactly 0 (every
        // term is multiplied by it and the clamp is then a no-op); glass-grid refracts, so here it
        // is a pure barrier.
#if defined(MATERIAL_GLASS) && defined(GLASS_GATE_REFRACT)
        vec2 refractOffset;
        if (GlassGate(GLASS_BARRIER_REFRACT)) {
#endif
        // Edge refraction: rotate the outward normal ~10° along the tangent,
        // then negate to sample INWARD (Show Studio's `-refract * edgeIntensity`).
        vec2 tangent = vec2(-normal.y, normal.x);
        vec2 rotatedNormal = normal * 0.985 + tangent * 0.174; // cos(10°), sin(10°)
        vec2 edgeDisp = -rotatedNormal * bend * thickness;

        // Surface bulge: radial direction from panel center, scaled by dome profile.
        // Magnitude is proportional to the panel's MINOR axis (its thickness),
        // not a constant — otherwise long pills (halfY << halfX) produce a
        // displacement larger than the pill is tall, pulling samples off-screen
        // where CLAMP_TO_EDGE returns the FBO's cleared border (dark halos at
        // pill endcaps).
        vec2 bulgeDisp = vec2(0.0);
        if (bulge != 0.0) {
            float minHalf = min(panelHalfSize.x, panelHalfSize.y);
            float maxRadius = max(panelHalfSize.x, panelHalfSize.y);
            float normDist = clamp(length(p) / max(maxRadius, 1.0), 0.0, 1.0);
            float domeProfile = normDist * (1.0 - 0.3 * normDist);
            vec2 radialDir = length(p) > 0.001 ? p / length(p) : vec2(0.0);
            float bulgeMag = bulge * minHalf * 0.25;
            bulgeDisp = radialDir * domeProfile * bulgeMag;
        }

#if defined(MATERIAL_GLASS) && defined(GLASS_GATE_REFRACT)
        refractOffset = (edgeDisp + bulgeDisp) * refractionStrength;
#else
        vec2 refractOffset = (edgeDisp + bulgeDisp) * refractionStrength;
#endif

        // Clamp the displacement so a strong Thickness×Refraction can't push the
        // sample past the panel's OWN footprint — beyond it lies the scissored
        // backdrop's empty border, which CLAMP_TO_EDGE returns as the dark
        // "cleared" colour (the "no colour"/dark-halo bug when a glass pill
        // magnifies over text). Cap to the panel's minor half-extent: the bend
        // saturates to "max" instead of sampling into the void. Generous enough
        // that normal refraction (offset ≪ half-extent) is untouched.
        float _maxOff = min(panelHalfSize.x, panelHalfSize.y);
        float _offLen = length(refractOffset);
        if (_offLen > _maxOff) refractOffset *= _maxOff / _offLen;
#if defined(MATERIAL_GLASS) && defined(GLASS_GATE_REFRACT)
        }
#endif

        // The body's tap coordinates. A rim overlay (GLASS_BORDER_ONLY) takes no body tap and no
        // rim-specular tap, the only two readers of all five, so it computes none of them.
        // GLASS_REG computes the two chromatic ones inside the 3-tap branch below, their only
        // reader, instead of holding four floats across the LOD computation.
#if !defined(GLASS_BORDER_ONLY)
#if !defined(GLASS_REG)
        // CA spread along normal, scaled by hump and ca
        float caPx = chromaticAberration * hump * 3.0;
        vec2 caStep = normal * caPx;
#endif

        // FBO has top-of-scene at UV.y=1 (panel/text shaders flip Y in clip space).
        // Flip Y here so each fragment samples the pixel directly behind it.
        // `baseUv` was hoisted to the outer scope — assign instead of redeclare
        // so the border-zone refilter can reuse the same refracted UV.
        baseUv = (v_PixelPos + refractOffset) / u_Resolution;
#if !defined(GLASS_REG)
        vec2 uvR = (v_PixelPos + refractOffset + caStep) / u_Resolution;
        vec2 uvB = (v_PixelPos + refractOffset - caStep) / u_Resolution;
#endif
        baseUv.y = 1.0 - baseUv.y;
#if !defined(GLASS_REG)
        uvR.y = 1.0 - uvR.y;
        uvB.y = 1.0 - uvB.y;
#endif
#endif

        // Backdrop is the Dual-Filter PRE-BLURRED FBO with mipmaps generated.
        // Apple's blur is NON-UNIFORM — stronger at the rim, weaker at the
        // center (longer optical path through the glass = more diffusion at
        // the bevel where light enters/exits at a steep angle). We sample
        // with `textureLod` and ramp the LOD up near the rim. LOD 0 = base
        // Gaussian; +1 LOD ≈ 2× box blur; +2 LOD ≈ 4× box blur. The boost
        // peaks at the silhouette edge and dies inward over `bezelWidth`.
        // Wider transition (2.5 × bezelWidth) than the old 1.5× — stretches
        // the blur ramp over more of the interior so the rim↔center blur
        // difference doesn't read as a sharp ring. Gaussian-shaped falloff
        // (x * (2 - x)) gives a gentler inward dropoff than pure smoothstep.
        //
        // `+lod`: this whole computation inside a gate - every local it declares dies inside, and
        // `lodBoost` is the outer one. It sits at the fill program's register peak (the map's `lod`
        // column). It could skip on frostReq exactly 0 (a clear surface: the whole boost is
        // multiplied by it); glass-grid is frosted, so here it is a pure barrier.
#if defined(MATERIAL_GLASS) && defined(GLASS_GATE_LOD)
        if (GlassGate(GLASS_BARRIER_LOD)) {
#endif
        float rimT = clamp(edgeDist / (bezelWidth * 2.5), 0.0, 1.0);
        float rimBoost = (1.0 - rimT) * (1.0 - rimT);
        // Refraction-footprint LOD. `sampleBackdrop` uses textureLod (explicit
        // LOD), which — unlike texture() — ignores screen-space derivatives. So
        // where strong refraction COMPRESSES or FOLDS the backdrop (the bezel's
        // hump rises then falls, reversing the sample position → a caustic), the
        // fold isn't auto-blurred and shows as hard banded "holes" instead of
        // blur. Re-introduce that missing footprint: fwidth(refractOffset) is
        // how many device px the sampled position sweeps per 1 screen px, so
        // log2 of it is the mip level whose texel matches that footprint. Adding
        // it makes compressed/folded regions sample a blurrier mip — the caustic
        // dissolves back into smooth blur while the full displacement is kept.
        float refractFp = length(fwidth(refractOffset));
        float refractLod = log2(1.0 + refractFp);
        // Scale by glassiness so rim blur fades with Thickness rather than
        // disappearing the instant the shader variant flips to MATERIAL_NONE.
        //
        // Frost-gated sharpness: the rim + refraction-footprint LOD exists to HIDE
        // caustics in FROSTED glass. A CLEAR surface (BackdropFilter Blur 0 →
        // frostLod ≈ u_BaseFrostLod) explicitly asked for a sharp backdrop, so
        // forcing that blur on it just softens crisp content/refraction (the tab
        // bar pill's magnified label). Ramp the whole boost in with the requested
        // frost so clear glass refracts CRISP while frosted glass still hides folds.
        float frostReq = clamp((frostLod - u_BaseFrostLod) * 4.0, 0.0, 1.0);
        lodBoost = ((rimBoost * 1.5 + innerBlur * 1.0) * glassiness + refractLod) * frostReq;
#if defined(MATERIAL_GLASS) && defined(GLASS_GATE_LOD)
        }
#endif
        // Chromatic aberration splits the R/B taps by ±caStep along the normal.
        // caStep = normal * (ca * hump * 3) — and `hump` is ~0 across the entire
        // flat interior (decays to <2e-4 by x=3·bezel). So for the vast interior
        // of a panel/modal the three channel taps sample the SAME uv and the
        // fringe is sub-pixel. Collapse to ONE backdrop read there: pixel-
        // identical output, but 2 fewer mipmapped backdrop samples on millions
        // of interior fragments (the dominant cost of a full-screen glass modal).
        // The full 3-tap CA still runs in the thin rim band where it's visible.
#if !defined(GLASS_BORDER_ONLY)
        float caSpreadPx = chromaticAberration * hump * 3.0; // = length(caStep)
        if (GlassSkips(GLASS_SKIP_CA)) caSpreadPx = 0.0;
        // A border-only pass throws `backdrop` away: it only reaches `fillRgb`, and the
        // borderOnly block below resets `result` to a transparent interior. So the one
        // to three MIPMAPPED, REFRACTED, chromatically-split taps here were paid on every
        // fragment of the rim quad for a fill nobody sees. Skipping them is byte-identical
        // by construction — and it is what lets emitBorderOverlay stop padding its blur
        // scissor by `Thickness x Refraction`: with these gone, the only backdrop tap a
        // border-only fragment makes is the border zone's own, which is INWARD.
        // `lodBoost` is still computed above, because the border zone reads it.
        if (borderOnly == 0.0) {
            if (caSpreadPx < 0.5) {
                backdrop = sampleBackdrop(baseUv, lodBoost, frostLod);
            } else {
#if defined(GLASS_REG)
                float caPx = chromaticAberration * hump * 3.0;
                vec2 caStep = normal * caPx;
                vec2 uvR = (v_PixelPos + refractOffset + caStep) / u_Resolution;
                vec2 uvB = (v_PixelPos + refractOffset - caStep) / u_Resolution;
                uvR.y = 1.0 - uvR.y;
                uvB.y = 1.0 - uvB.y;
#endif
                vec3 sR = sampleBackdrop(uvR, lodBoost, frostLod);
                vec3 sG = sampleBackdrop(baseUv, lodBoost, frostLod);
                vec3 sB = sampleBackdrop(uvB, lodBoost, frostLod);
                backdrop = vec3(sR.r, sG.g, sB.b);
            }
            if (GlassSkips(GLASS_SKIP_GRADE)) {} else
            backdrop = applyTint(applyGrading(backdrop, brightness, saturation, contrast), bodyTint);
        }
#endif
    } else if (hasBackdropFilter && borderOnly == 0.0) {
        // Flat panel backdrop sampling — no refraction, no CA, no rim boost.
        vec3 s = sampleBackdrop(baseUv, 0.0, frostLod);
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
    // A rim overlay's `backdrop` reaches nothing (GLASS_BORDER_ONLY excludes the fill composite).
#if !defined(GLASS_BORDER_ONLY)
    // `+absorb`: a gate around the block. The block's own condition already skips on the
    // per-instance amounts (Tint.a, glassiness), coherently; the gate adds the uniform boundary only.
#if defined(MATERIAL_GLASS) && defined(GLASS_GATE_ABSORB)
    if (GlassGate(GLASS_BARRIER_ABSORB)) {
#endif
    if (materialType == 1.0 && v_Tint.a > 0.001 && glassiness > 0.001) {
#if defined(GLASS_REG_REMAT)
        edgeDist = max(-dist, 0.0);
#endif
        float pathLength = mix(0.3, 1.0, smoothstep(0.0, bezelWidth * 2.0, edgeDist)) * glassiness;
        vec3 absorb = pow(max(v_Tint.rgb, vec3(0.0001)), vec3(pathLength * v_Tint.a));
        backdrop *= absorb;
    }
#if defined(MATERIAL_GLASS) && defined(GLASS_GATE_ABSORB)
    }
#endif
#endif

#if defined(GLASS_REG)
    // GLASS_REG: the fill composite and the border-only reset, moved up from below the rim glow
    // and the shadow (neither of which it reads, and neither of which reads anything it writes
    // but `fillAlpha`, which the rim glow reads only where `borderOnly == 0.0` and the reset
    // never ran). `backdrop` dies here instead of being held across the rim glow's tap and the
    // shadow's corner field. The statements are the ones below, character for character.
#if defined(GLASS_BORDER_ONLY)
    vec4 result = vec4(0.0);
#else
#if defined(GLASS_REG_REMAT)
    if (v_Is3D > 0.5) {
        pLocal = panelCenter + v_Local;
    } else {
        vec2 _rel = v_PixelPos - v_Rot.zw;
        pLocal = vec2(
            _rel.x * v_Rot.x + _rel.y * v_Rot.y,
            -_rel.x * v_Rot.y + _rel.y * v_Rot.x
        ) + v_Rot.zw;
    }
#endif
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
    float outA = fillA + shadowAlpha * (1.0 - fillA);
    vec3 outRGB = outA > 1e-5
        ? (fillRgb * fillA + v_ShadowColor.rgb * shadowAlpha * (1.0 - fillA)) / outA
        : vec3(0.0);
    vec4 result = vec4(outRGB, outA);
#endif
    if (borderOnly == 1.0) {
        result = vec4(0.0);
        fillAlpha = 0.0;
    }
    // First read: the border chain just below.
    vec2 lightDir = vec2(cos(v_Lighting.x), -sin(v_Lighting.x));
#endif

    // ── Variable border width along perimeter ──
    //
    // THE CHAIN NO_SHAPE_GRADIENT REMOVES, and the whole reason the normal is computed at all on
    // a flat panel. At `borderWidth == 0` — which the borderless program's routing guarantees for
    // every instance in the batch — every number below is exactly 0 or exactly 1, whatever the
    // normal was:
    //     localBorderWidth  = 0 * widthScale                   = ±0    (widthScale is finite)
    //     variedBorderWidth = max(±0, 0.0)                     =  0
    //     drawnBorderWidth  = max(0, BORDER_MIN_DEVICE_PX)     =  1
    //     borderCoverage    = 0 / 1                            =  0
    // and every later consumer multiplies by borderCoverage, so the stroke composites
    // `x * 1.0 + c * 0.0` — exact, for finite x and c.
#if !defined(NO_SHAPE_GRADIENT)
    // Thicker where the rim's outward normal aligns with the light direction.
    // Two lights, as the iPhone's environment has them: the key light along lightDir and a bounce from
    // the opposite side nearly as bright (measured on a round button over black: 68 at the top left, 58
    // at the bottom right, 33 at the sides over a 24 body), so the rim reads top-left AND bottom-right.
    const float GROUND_BOUNCE = 0.95;
    float keyAlign = dot(normal, lightDir);
    float alignment = max(keyAlign, -keyAlign * GROUND_BOUNCE); // +1 key-lit, ~0.45 bounce-lit, 0 at the sides
    // Width scale keeps the signed form so the sides thin out below the base width.
    float widthAlign = alignment * 2.0 - 1.0;
    float widthScale = 1.0 + borderVariance * widthAlign;
    float localBorderWidth = borderWidth * widthScale;

    // ── Hairline floor ──
    // The border is point-sampled ONCE per fragment, so an annulus narrower than a device pixel can
    // fall entirely between pixel centres and paint nothing at all. That is not a faint line, it is an
    // absent one: at BorderBlur 0 every width below 1 device px has a sample phase at which no pixel on
    // the edge lights up. BorderVariance makes it worse on purpose, since widthScale bottoms out at
    // 1 - BorderVariance (0.5x for the glass rim, 0.4x for the toggle), so the rim can render on the
    // lit side and vanish on the thin sides of the same shape.
    // So never draw a stroke thinner than a device pixel: draw it AT the floor and carry the width it
    // lost as coverage. A 0.7px stroke becomes a 1.0px stroke at 0.7 alpha — the same ink, spread over
    // a footprint the sample grid cannot miss.
    // The floor sits AFTER BorderVariance deliberately: variance still thins the rim, because coverage
    // falls with it and the thin side reads thinner and dimmer exactly as authored. What it can no
    // longer do is delete it. A zero BorderWidth stays zero: coverage is 0, so "no border" is untouched.
    const float BORDER_MIN_DEVICE_PX = 1.0;
    float variedBorderWidth = max(localBorderWidth, 0.0);
    float drawnBorderWidth = max(variedBorderWidth, BORDER_MIN_DEVICE_PX);
    float borderCoverage = variedBorderWidth / drawnBorderWidth;
#endif

    // ── Edge lighting (Apple Liquid Glass) ──────────────────────────────
    // Two bands stacked:
    //   1) WIDE inward rim glow — vibrant color sampled from behind the glass,
    //      fading from the outline inward over `bezelWidth` px. This is the
    //      visible "edge thickness" — the optical light gathered along the
    //      bevel. NOT tied to BorderColor.a (that's the ink-line stroke).
    //      Strength controlled by `fresnelStrength` (preset default 0.7).
    //   2) THIN bright outline — a 1–2 px stroke drawn on top, color =
    //      BorderColor. Defines the silhouette under the rim glow.
    float edgeLightAlpha = 0.0;
    vec3 edgeLightRgb = vec3(0.0);
    // Edge light only exists within `rimBand` of the outline — edgeProximity
    // (and thus edgeLightAlpha) is exactly 0 once dist <= -rimBand. Skip the
    // whole block (incl. its extra rim backdrop tap) in the deep interior:
    // edgeLightAlpha stays 0 → the composite below is a no-op. Pixel-identical,
    // saves one mipmapped backdrop read across the entire panel/modal interior.
    //
    // A border-only pass is excluded OUTRIGHT, and that is a BUG FIX, not an economy.
    // The borderOnly block below zeroes `fillAlpha` so that every interior effect
    // drops out — but `edgeLightAlpha` had ALREADY captured fillAlpha here, several
    // hundred lines earlier, so the wide rim glow still composited into a pass whose
    // own comment promises a transparent interior. `JwiftGlass` hides it with
    // `FresnelStrength: 0`; `JwiftSolidGlass` did NOT (0.55, with `BorderLayer: 10`),
    // so its overlay painted a full-strength interior glow all along — the only edge
    // light that class had, since its fill draws as MATERIAL_NONE where this whole
    // block is dead code.
    //
    // That light was not deleted, it MOVED: `JwiftSolidGlass` now authors it in the
    // BORDER zone (BorderFade / BorderAlphaVariance / BorderFresnelStrength), where a
    // border-only pass is entitled to paint. `FresnelStrength` is the BODY's fresnel
    // and a border-only pass has no body — same reason the hemispherical ambient below
    // is multiplied by `fillAlpha`.
    //
    // GLASS_NO_GLOW excludes the block for a batch whose every instance has FresnelStrength +0, and
    // GLASS_BORDER_ONLY for a batch of rim overlays, where `borderOnly == 0.0` is false on every
    // fragment. Either way the two initialisers above are what the composite reads.
#if !defined(MATERIAL_FLAT) && !defined(GLASS_NO_GLOW) && !defined(GLASS_BORDER_ONLY)
    if (GlassSkips(GLASS_SKIP_RIM)) {} else
    if (materialType == 1.0 && borderOnly == 0.0 && fillAlpha > 0.0 && dist > -max(bezelWidth * 0.75, 6.0)) {
        // Wide rim band — at LEAST 6 px so the glow is actually visible,
        // scaled up with bezelWidth (the optical "thickness" of the glass).
        float rimBand = max(bezelWidth * 0.75, 6.0);

        // Proximity: 1 at the outline (dist ≈ 0), 0 a full band inward, 0 outside.
        // Must be zero where dist > 0 (the expanded-rect shadow region) or the
        // edge light leaks into the shadow and looks like a dark blob.
        float edgeProximity = dist > 0.0 ? 0.0 : clamp(1.0 + dist / rimBand, 0.0, 1.0);

        // Single soft falloff — exp 1.6 keeps a strong peak near the rim and a
        // gentle fade inward. Double-pow (4.7 effective) pinched the band to
        // invisibility.
        float falloff = pow(edgeProximity, 1.6);

        // Directional: lit side full, unlit side dimmed (not dark)
        float lightFacing = max(alignment, 0.0);
        float directional = 0.6 + 0.4 * pow(lightFacing, 1.5);

        // Rim backdrop sample — offset INWARD from the outline so the rim picks up
        // the color from behind the glass, not the pixel directly beneath it.
        vec2 rimUv = (v_PixelPos - normal * rimBand * 1.2) / u_Resolution;
        rimUv.y = 1.0 - rimUv.y;
        vec3 rimSample = sampleBackdrop(rimUv, 0.0, frostLod);

        // Saturation + brightness boost — Apple's rim picks up surrounding hue
        // and intensifies it (the "light gathering" feel).
        float rimLuma = dot(rimSample, LUMA);
        vec3 rimVibrant = clamp(mix(vec3(rimLuma), rimSample, 1.6) * 1.25, 0.0, 1.0);

        // Brighter near the rim (specular cap), pure backdrop color deeper in
        float specularCap = pow(edgeProximity, 3.5);
        edgeLightRgb = mix(rimVibrant, mix(rimVibrant, vec3(1.0), 0.6), specularCap);

        // Strength = Fresnel knob × directional × shape mask. NOT gated by
        // BorderColor.a (that's the ink-line, separate concern).
        edgeLightAlpha = falloff * directional * fresnelStrength * fillAlpha;
    }
#endif

    // ── Shadow ──
    // SOFT drop shadow — fades symmetrically across the silhouette edge so the
    // shadow extends OUTSIDE the silhouette (like CSS box-shadow). Old
    // formulation was `1 - smoothstep(-blur, 0, dist)` which clipped at
    // dist=0, producing a hard "shape mask in shadow color" with no outward
    // bleed. Now: full opacity at -blur (deep inside silhouette), 0.5 at the
    // edge, 0 at +blur outside.
    //
    // Early-out when the author didn't set a shadow. ShadowColor.a is
    // flat-interpolated per-instance, so the branch is uniform within a
    // single panel draw — GPUs evaluate it for the whole quad at once,
    // not per-fragment. Within a batched draw, the branch is coherent
    // across the quads of any one panel instance (which is what matters
    // for GPU divergence cost). Panels without shadows (most things
    // except Cards on Home) skip an entire ShapeSDF call per fragment.
    //
    // GLASS_REG runs this beside the main corner field instead (above); GLASS_BORDER_ONLY never
    // runs it, because a rim overlay's shadow alpha is 0 (`Jiv.InstanceBuffer.Push`) and its only
    // reader, the fill composite, is excluded with it.
#if !defined(GLASS_REG) && !defined(GLASS_BORDER_ONLY)
    float shadowAlpha = 0.0;
#if !defined(MATERIAL_FLAT)
    if (GlassSkips(GLASS_SKIP_SHADOW)) {} else
#endif
    if (v_ShadowColor.a > 1e-4) {
        vec2 sp = p - shadowOffset;
        float shadowDist = ShapeSDF(sp, panelHalfSize, v_Radii, effectiveSmooth, mode);
        shadowAlpha = smoothstep(shadowBlur, -shadowBlur, shadowDist) * v_ShadowColor.a;
    }
#endif

    // ── Fill: source composited over the (refracted, filtered, absorbed) backdrop.
    //
    // The fill source is selected by u_BgMode:
    //   • Color   → v_Tint (the legacy solid-fill path; no texture / no stops)
    //   • Image   → sampled u_BgTexture with CPU-baked Cover/Contain UV
    //   • Linear/RadialGradient → evaluated against u_BgGradColor[]/Pos[]
    //
    // Once we have the source, the same glass / non-glass composite below
    // applies. Image-Background panels reuse the entire material treatment
    // (border, shadow, refraction, frost, rim-spec) for free — there is no
    // separate "image draw" pipeline, image is just one of many fill modes.
    //
    // GLASS_REG runs this and the reset below straight after the taps (above). A rim overlay
    // (GLASS_BORDER_ONLY) composites nothing here: the reset below overwrites `result` with
    // exactly vec4(0.0) on every one of its fragments, so that is what it starts from.
#if !defined(GLASS_REG)
#if defined(GLASS_BORDER_ONLY)
    vec4 result = vec4(0.0);
#else
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
    // Was `mix(shadow, fill, fillA)`, which applies fillA as BOTH a lerp factor
    // AND a color scale — a white fill at 18% alpha became grey at 3% alpha
    // (barely visible). Correct over compositing: out.a = A.a + B.a * (1−A.a);
    // out.rgb = (A.rgb * A.a + B.rgb * B.a * (1−A.a)) / out.a.
    float outA = fillA + shadowAlpha * (1.0 - fillA);
    vec3 outRGB = outA > 1e-5
        ? (fillRgb * fillA + v_ShadowColor.rgb * shadowAlpha * (1.0 - fillA)) / outA
        : vec3(0.0);
    vec4 result = vec4(outRGB, outA);
#endif

    // Border-only overlay (BorderLayer glass rim drawn OVER children): start
    // from a fully transparent interior — no fill, no shadow — and zero the
    // fill-coupled alpha so every interior glass effect (bevel/rim specular,
    // hemispherical rim ambient) contributes nothing. Only the border zone below
    // will paint, sampling the real backdrop with its BorderFilter grading.
    // The wide rim glow is NOT covered by this line — it reads a copy of fillAlpha
    // taken before it — so its block is gated on `borderOnly` at the source.
    if (borderOnly == 1.0) {
        result = vec4(0.0);
        fillAlpha = 0.0;
    }
#else
    // GLASS_REG: first read, the rim-specular line and the border zone just below.
    float aa = max(borderEdgeAa, 1e-4);
#endif

    // Composite order for glass:
    //   1) Wide rim glow (vibrant backdrop pickup, inward fade) — the optical
    //      "light gathering" along the bevel
    //   2) Physical Fresnel rim stroke — a thin highlight at the very outline,
    //      thicker + brighter on the lit side (BorderVariance × light angle),
    //      tinted with backdrop vibrancy, fading on the unlit side. This is
    //      what makes the outline read as a real bevel catching light, not a
    //      flat CSS border. For non-glass it falls back to a uniform stroke.
    //
    // The `#if` closes on a DANGLING `else`, so MATERIAL_FLAT drops the glass arm and the
    // non-glass stroke below stands alone as a bare compound statement — same scope, same
    // statements, same order. The alternative (a second copy of the stroke under
    // `#if defined(MATERIAL_FLAT)`) is the hand-written second shader the lane exists to avoid.
#if !defined(MATERIAL_FLAT)
    if (materialType == 1.0) {
        // ── Hemispherical edge light (rim ambient — top vs bottom bias) ──
        // Apple uses a virtual "sky above, ground below" environment so the
        // top of the rim picks up brighter ambient than the bottom. In screen
        // coords (y-down), the TOP edge has normal.y < 0; the BOTTOM has
        // normal.y > 0. Mix between EdgeLightTop and EdgeLightBottom by the
        // vertical normal component. Modulated by edge proximity so it only
        // shows in the rim band, not the flat interior.
        //
        // A rim overlay (GLASS_BORDER_ONLY) adds `rimAmbientRgb * 0.0` to an rgb of exactly +0,
        // which is +0 for every finite ambient: excluded, ambient and all.
#if !defined(GLASS_BORDER_ONLY)
        // `+ambient`: a gate around the ambient and its composite; every local dies inside. It could
        // skip on EdgeLightTop and EdgeLightBottom both exactly 0 (the ambient is then +0 and the
        // composite adds +0 * fillAlpha); it does not - the gate is TRUE on every draw.
#if defined(MATERIAL_GLASS) && defined(GLASS_GATE_AMBIENT)
        if (GlassGate(GLASS_BARRIER_AMBIENT)) {
#endif
        float hemiTop = max(-normal.y, 0.0);
        float hemiBottom = max(normal.y, 0.0);
        float hemiAmbient = (edgeLightTop * hemiTop + edgeLightBottom * hemiBottom);
        float rimMask = (dist > 0.0)
            ? 0.0
            : pow(clamp(1.0 + dist / max(bezelWidth, 0.5), 0.0, 1.0), 2.0);
        vec3 rimAmbientRgb = vec3(hemiAmbient) * rimMask;

        // Composite order:
        //   1) hemispherical rim ambient (additive, sub-rim)
        //   2) wide rim glow (vibrant backdrop pickup)
        //   4) Blinn-Phong specular catchlight (additive bright)
        //   5) hairline silhouette stroke
        result.rgb += rimAmbientRgb * fillAlpha;
#if defined(MATERIAL_GLASS) && defined(GLASS_GATE_AMBIENT)
        }
#endif
#endif
        result.rgb = result.rgb * (1.0 - edgeLightAlpha) + edgeLightRgb * edgeLightAlpha;
        result.a = result.a * (1.0 - edgeLightAlpha) + edgeLightAlpha;

        // GLASS_NO_SPEC: SpecularIntensity is +0 on every instance, so `specAlpha` is +-0 (every
        // other factor is finite) and `rimSpecAlpha > 0.0` is false. GLASS_BORDER_ONLY: `fillAlpha`
        // is 0, so the same two facts hold at any intensity. Excluded whole in both.
#if !defined(GLASS_NO_SPEC) && !defined(GLASS_BORDER_ONLY)
        if (!GlassSkips(GLASS_SKIP_SPECULAR)) {
#if defined(GLASS_REG_REMAT)
            glassiness = smoothstep(0.0, 1.0, thickness);
#endif
            // ── Blinn-Phong specular catchlight on the bevel ──
            // The bevel has a 3D normal: 2D outward normal (when on the bevel)
            // tilted toward +Z (out of screen) at the flat center. We model this
            // as `(normal * hump, 1 - hump*0.7)`: mostly +Z at the center where
            // the surface is flat (hump=0), tilted outward at the rim (hump=1).
            // View direction is +Z (orthographic). Light direction in 3D adds an
            // elevation + the SpecularTilt offset — this reproduces Apple's
            // gyro-driven catchlight (tilt device → specular slides across rim).
            vec3 N3 = normalize(vec3(normal * hump, 1.0 - hump * 0.7));
            vec2 specLightDir = normalize(lightDir + u_SpecularTilt);
            vec3 L3 = normalize(vec3(specLightDir, 0.6));
            vec3 V3 = vec3(0.0, 0.0, 1.0);
            vec3 H3 = normalize(L3 + V3);
            float specBase = pow(max(dot(N3, H3), 0.0), specSharpness);
            float specAlpha = specBase * specIntensity * hump * fillAlpha * lightIntensity;
            vec3 specRgb = vec3(1.0);  // bright white catchlight
            result.rgb = result.rgb * (1.0 - specAlpha) + specRgb * specAlpha;
            result.a = result.a * (1.0 - specAlpha) + specAlpha;

            // ── Rim specular highlight (Apple's chrome-edge catchlight) ─────
            // A SECOND very thin bright line right at the silhouette, on the LIT
            // side only — sharper directional falloff than the main border, and
            // picks up vibrant color from the backdrop. Distinct from:
            //   - Blinn-Phong catchlight (on the bevel SURFACE, not the silhouette)
            //   - Main border stroke (uniform around the perimeter)
            //   - Wide rim glow (soft inward fade, not pinned at the edge)
            // This is the "variable vibrant rim line" that reads as chrome-like
            // specular reflection off the glass rim, brightest where the rim's
            // outward normal points toward the light.
            //
            // Width is PHYSICAL — proportional to perceived glass thickness. A
            // thicker slab shows a wider rim edge-on. Floor at 0.75 px so the
            // highlight never disappears on thin glass.
            // Floor scales with glassiness so the highlight band collapses to 0
            // as Thickness fades, preventing a hard pop at the variant flip.
            float rimSpecW = max(thickness * 0.18, 0.75 * glassiness);
            // Thin band between the outline (dist=0) and rimSpecW inside (dist=-rimSpecW).
            // Previous subtraction formulation left the second term at 0 deep inside
            // while the first stayed at 1, so the "thin line" was actually a 55%
            // wash over the entire lit-side interior. Now: inside-outline mask
            // multiplied by a reverse ramp that goes to 0 past rimSpecW inward.
            float insideOutline = 1.0 - smoothstep(-aa, aa, dist);
            float withinBand = smoothstep(-rimSpecW - aa, -rimSpecW + aa, dist);
            float rimSpecBand = insideOutline * withinBand;
            // Directional alignment uses the TILTED light direction so the
            // rim-spec line slides around the perimeter as pointer/gyro moves.
            // The ambient, edge-light, and border directionality stay fixed to
            // the stylesheet-set LightAngle (via `alignment` above).
            vec2 specLightDirRim = normalize(lightDir + u_SpecularTilt);
            float rimSpecKey = dot(normal, specLightDirRim);
            float rimSpecAlign = max(rimSpecKey, -rimSpecKey * GROUND_BOUNCE);
            float rimSpecDir = pow(max(rimSpecAlign, 0.0), 3.0);
            float rimSpecAlpha = rimSpecBand * rimSpecDir * specIntensity * fillAlpha;
            // rimSpecAlpha is 0 once dist <= -rimSpecW (the thin rim band) — i.e. the
            // entire interior. Skip the vibrant-rim backdrop tap + composite there:
            // a no-op composite anyway. Pixel-identical, saves the second per-pixel
            // backdrop read across the whole interior.
            if (rimSpecAlpha > 0.0) {
                // Color: vibrant-boosted backdrop (sampled at the rim) mixed toward white.
                // LOD offset slightly sharper than the panel so the rim highlight reads
                // as "specular reflection of crisper nearby content."
                vec3 rimSpecBackdrop = sampleBackdrop(baseUv, max(0.0, lodBoost - 0.5), frostLod);
                float rimSpecLuma = dot(rimSpecBackdrop, LUMA);
                vec3 rimSpecVibrant = clamp(mix(vec3(rimSpecLuma), rimSpecBackdrop, 1.8) * 1.4, 0.0, 1.0);
                vec3 rimSpecRgb = mix(rimSpecVibrant, vec3(1.0), 0.45);
                result.rgb = result.rgb * (1.0 - rimSpecAlpha) + rimSpecRgb * rimSpecAlpha;
                result.a = result.a * (1.0 - rimSpecAlpha) + rimSpecAlpha;
            }
        }
#endif

        // ── Border zone backdrop refilter ───────────────────────────────
        // Apple's glass rim isn't a flat color — it's an optical zone where
        // the backdrop is sampled with its OWN grading (typically brighter,
        // more saturated than the panel face). Then the BorderColor is
        // overlaid on top with its alpha as a tint, NOT a solid stroke.
        // This is what gives Apple's rim its "light-gathering" quality
        // without the static UI-border feel.
        if (!GlassSkips(GLASS_SKIP_BORDER)) {
            float borderOuter = smoothstep(-aa, aa, dist);
            // The inner edge eases over BorderFade (scaled with the width) past the stroke; with no fade it
            // feathers by the same aa as the outer edge.
            float fadeIn = max(borderFade * widthScale, aa);
            float borderInner = smoothstep(-drawnBorderWidth - fadeIn, -drawnBorderWidth + aa, dist);
            // Drawn at the hairline floor, inked by the width it actually has.
            float borderBase = (1.0 - borderOuter) * borderInner * borderCoverage;

            if (borderBase > 0.001) {
                // Re-sample backdrop with border-zone grading. Apply LOD offset for
                // sharper or blurrier border vs the panel.
                float bLod = max(0.0, lodBoost + v_BorderFilter.w);
                // SOLID-slab rim gather. A slab with Refraction 0 renders a SOLID
                // (opaque) fill, so it OCCLUDES whatever is behind the card — the rim
                // must gather from the card's OWN content at the edge, not the scene
                // behind it. Sampling straight down (baseUv) lets the rim's tap —
                // especially a blurred BorderFilter — straddle the silhouette and pull
                // in the occluded exterior, which BorderFilter Brightness/Saturate then
                // amplifies (a black card over a green field gets a bright green rim).
                // Offset the tap INWARD along the normal so it lands fully inside the
                // content, mirroring the wide rim glow's inward `rimUv`. Scaled by
                // `solidness` so refractive (see-through) glass is byte-identical: its
                // rim legitimately gathers from behind via the refracted baseUv.
                // The rim gathers what lies straight under it, never the panel's own content: the bezel's inward
                // displacement (baseUv) would pull a BorderLayer overlay's glyphs and text into the stroke.
                vec2 straightUv = v_PixelPos / u_Resolution;
                straightUv.y = 1.0 - straightUv.y;
                float solidness = 1.0 - smoothstep(0.0, 4.0, refractionStrength);
                float borderInset = (max(bezelWidth * 0.75, 6.0) * 1.2 + localBorderWidth) * solidness;
                vec2 bUv = straightUv + vec2(-normal.x, normal.y) * (borderInset / u_Resolution);
                // THE ONE BACKDROP TAP A BORDER-ONLY PASS MAKES, and the whole reason the rim needed a
                // pyramid of its own. Under BORDER_DIRECT it is computed from a blit of the scene with
                // the pyramid's own kernel; the pyramid arm's arithmetic below is untouched.
#if defined(BORDER_DIRECT)
                // The branch is on a UNIFORM, so it is coherent across every wavefront and costs one
                // compare; `u_BorderGather` is 1.0 on the arm that draws, and the `else` exists only so
                // that `=skipgather` can take the program's cost without the gather's.
                vec3 bSample;
                if (u_BorderGather > 0.5) bSample = sampleBackdropDirect(bUv, bLod, frostLod);
                else bSample = sampleBackdrop(bUv, bLod, frostLod);
#else
                vec3 bSample = sampleBackdrop(bUv, bLod, frostLod);
#endif
                // The rim looks through the same slab as the body, so it carries the body's tint: a rim
                // brighter than the body stays brighter in both themes, lifted by BorderFilter and BorderColor.
                vec3 borderBackdrop = applyTint(applyGrading(
                    bSample,
                    brightness * v_BorderFilter.x,
                    saturation * v_BorderFilter.y,
                    contrast * v_BorderFilter.z
                ), bodyTint);

                // Optional tint stroke from BorderColor — alpha controls strength
                // of the colored overlay on top of the refiltered backdrop.
                // Directional brightness from BorderAlphaVariance / BorderFresnelStrength. Both are
                // amounts sharing v_Outline.x (11 bits over [0,1] and 12 over [0,2]); v_Outline.y
                // carries the Fresnel's own grade (BorderFresnelFilter) at 10 bits each. Named
                // `border*` because the body has its own, different fresnel in v_Lighting.w.
                float lightFacing = max(alignment, 0.0);
                float avCode = floor(v_Outline.x / 4096.0);
                float borderAlphaVariance = avCode / 2047.0;
                float borderFresnelStrength = (v_Outline.x - avCode * 4096.0) / 1024.0;
                float fbCode = floor(v_Outline.y / 1024.0);
                float borderFresnelBrightness = fbCode / 256.0;
                float borderFresnelSaturation = (v_Outline.y - fbCode * 1024.0) / 256.0;
                float alphaFloor = 1.0 - borderAlphaVariance;
                float strokeBrightness = mix(alphaFloor, 1.0, pow(lightFacing, 2.0));
                // ── What the Fresnel converges on ──
                // The lit side of a real bevel INTENSIFIES what is behind it; it does not turn white.
                // White is only the right answer where the backdrop has no colour, because the most
                // intense form of a neutral IS white. So the target is the rim's own gather driven to
                // full value: hue and saturation kept, value pinned to 1, then pushed past the hue —
                // and blended back to white by how little chroma the gather actually has.
                //
                // This is the same operation the wide rim glow already performs a hundred lines up
                // (`rimVibrant`: saturate 1.6, brighten 1.25), which is where the DEFAULT Saturate(1.6)
                // comes from rather than an invented number.
                //
                // It saturates about WHITE, not about luma, and that is the whole difference from the
                // attempt that was backed out. applyGrading's saturation is a lerp about luma, so any
                // saturation above 1 drives the channels BELOW luma down — over the border's alpha fade
                // that reads as a darker ring inside the stroke. Here every target has max channel 1.0,
                // so the stroke can never land dimmer in value than the white it replaces; only the
                // off-hue channels come down, which IS the colour being carried.
                //
                // Over a neutral gather (grey, black, white) chroma is 0, carry is 0 and the target is
                // exactly vec3(1.0) — byte-identical to the old line, so every sheet calibrated over
                // black keeps its measured numbers.
                //
                // Both knobs are authored PER CLASS as `BorderFresnelFilter: Brightness(b) Saturate(s)`.
                // The gain was a hard-coded RIM_CHROMA_GAIN = 1.6 here until it became authorable, which
                // meant every glass class in the app carried the same edge saturation and no sheet could
                // see it, let alone change it. 1.6 is now only the default (Jiv.Defaults), so nothing
                // moved when the constant left.
                vec3 gather = clamp(borderBackdrop, 0.0, 1.0);
                float gatherHi = max(max(gather.r, gather.g), gather.b);
                float gatherLo = min(min(gather.r, gather.g), gather.b);
                vec3 huedTarget = gather / max(gatherHi, 0.001);
                huedTarget = clamp(mix(vec3(1.0), huedTarget, borderFresnelSaturation), 0.0, 1.0);
                // Carry colour only where there IS colour, and only where the gather is bright enough
                // for its hue to be trustworthy — normalising a near-black pixel amplifies noise.
                float rimCarry = smoothstep(0.0, 0.18, gatherHi - gatherLo)
                               * smoothstep(0.015, 0.09, gatherHi);
                // Brightness() is the last word on the highlight's value, applied after its hue is
                // settled. The target is pinned to full value by construction, so this is the only way
                // to author a cooler flare (below 1) or burn a hued one back toward white (above 1).
                vec3 fresnelTarget = clamp(mix(vec3(1.0), huedTarget, rimCarry) * borderFresnelBrightness, 0.0, 1.0);
                vec3 strokeTint = mix(v_BorderColor.rgb, fresnelTarget, pow(lightFacing, 3.0) * borderFresnelStrength);
                vec3 borderRgb = mix(borderBackdrop, strokeTint, v_BorderColor.a * strokeBrightness);

                // Replace the panel result in the border zone (alpha-blended by mask).
                // borderBase is the antialiased annulus. Normally the rim alpha
                // follows the panel fill (so a rim never extends past a faded panel);
                // but in border-only mode the fill is intentionally transparent, so
                // drive the rim straight from borderBase — that's the whole point of
                // the overlay (a glass rim floating over the children).
                float borderZoneAlpha = mix(fillAlpha, 1.0, borderOnly);
                result.rgb = mix(result.rgb, borderRgb, borderBase);
                result.a = max(result.a, borderBase * borderZoneAlpha);
            }
        }
    } else
#endif
    // The plain stroke. Under NO_SHAPE_GRADIENT the whole compound statement goes: every
    // assignment in it is `result.<c> * (1 - 0) + <c> * 0`, because `borderCoverage` is exactly 0
    // (see the chain above). It mutates nothing else — `borderOuter`, `fadeIn`, `borderInner`,
    // `borderBase` and `borderAlpha` are locals that die here.
#if !defined(NO_SHAPE_GRADIENT)
    {
        float borderOuter = smoothstep(-aa, aa, dist);
        // The inner edge eases over BorderFade (scaled with the width) past the stroke; with no fade it
        // feathers by the same aa as the outer edge.
        float fadeIn = max(borderFade * widthScale, aa);
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
