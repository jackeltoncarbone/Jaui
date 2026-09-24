// APPLE'S LIQUID GLASS, the fragment half (Core/Glass.md has every value and its source; Core/Glass.Pipeline.ts
// states the same laws for the CPU). Lengths are in points unless a name says device px. `d` is the signed
// distance to the outline, negative inside; `span` is the shape's minor dimension.

const vec3 GLASS_BT709 = vec3(0.2126, 0.7152, 0.0722);
const vec3 GLASS_BLEED_LUMA = vec3(0.2125, 0.7154, 0.0721);
// Our native pyramid's LOD n is a Gaussian 2^n device px wide; Apple's texel reads as this share of its width,
// fitted per backdrop scale to SwiftUI's own render (Core/Glass.Pipeline.ts states the same two).
const float GLASS_TEXEL_SIGMA_REGULAR = 0.62;
const float GLASS_TEXEL_SIGMA_CLEAR = 0.28;

vec2 GlassSizeRamps(float span) {
    return vec2(clamp((span - 48.0) / 112.0, 0.0, 1.0), clamp((span - 64.0) / 96.0, 0.0, 1.0));
}

// The quarter-circle bezel: the full amount at the outline, none at `height` deep.
float GlassShift(float d, float amount, float height) {
    float h = clamp(-d / max(height, 1e-4), 0.0, 1.0);
    return amount * (1.0 - sqrt(h * (2.0 - h)));
}
// Apple's inner refraction (QuartzCore GlassBackgroundFilter): max(-0.8 S, -60) pt at the outline, over a bezel
// min(0.25 S, 20) pt deep. Negative: the rim reads from further in, so the content wraps into the bezel.
float GlassInnerShift(float d, float span) {
    return GlassShift(d, max(-0.8 * span, -60.0), min(0.25 * span, 20.0));
}

// The blur ramp against (d + inner shift): full radius from half the span in, half radius over the last point.
float GlassBlurScale(float t, float span) {
    if (t >= -1.0) return 0.5;
    float from = -0.5 * span;
    return mix(1.0, 0.5, clamp((t - from) / max(-1.0 - from, 1e-3), 0.0, 1.0));
}

float GlassBackdropScale(float clear) { return mix(0.25, 0.5, clear); }

float GlassBlurRadius(float span, float clear) {
    return mix(1.3333 + 2.6667 * GlassSizeRamps(span).x, 1.0, clear);
}

// A radius in points to the LOD of our native pyramid with the blur Apple's quarter (clear: half) resolution
// mip reads at: Apple's LOD, then log2(texel sigma / backdrop scale).
float GlassNativeLod(float radiusPt, float dpr, float clear) {
    float scale = GlassBackdropScale(clear);
    float r = radiusPt * scale * dpr * 1.6;
    float appleLod = max(0.0, r < 2.0 ? log2(1.0 + 0.5 * r) : log2(r));
    return appleLod + log2(mix(GLASS_TEXEL_SIGMA_REGULAR, GLASS_TEXEL_SIGMA_CLEAR, clear) / scale);
}

// QuartzCore's set_ycc_composite without its fill: BT.709 luma remapped to (white - black) Y + black, chroma
// scaled by `saturation`.
vec3 GlassYcc(vec3 c, float white, float black, float saturation) {
    float y = dot(c, GLASS_BT709);
    return vec3((white - black) * y + black) + saturation * (c - y);
}

// The face: (white, black, saturation, fill alpha), light filled white and dark filled black, premultiplied.
// Apple's structure with its parameters FITTED (Core/Glass.md): light and clear to SwiftUI's own render of the
// same inputs (macOS 27), dark to Apple's native iOS 26 dark captures. Glass 64 pt and under tracks its
// backdrop: its light face moves between Apple's observed settled values by the mean luma, its dark face is
// the one fitted to iOS's small controls.
vec3 GlassFace(vec3 c, float span, float clear, float light, float mean) {
    vec3 clearFace = GlassYcc(c, 1.1054, 0.1295, 0.885);
    if (clear >= 1.0) return clearFace;
    vec4 l = vec4(1.0054, 0.0829, 1.2246, 0.4);
    vec4 k = vec4(0.9608, 0.2941, 1.4167, 0.4);
    if (span <= 64.0) {
        l = mix(vec4(0.919, 0.319, 1.0, 0.516), vec4(1.03, 0.819, 1.0, 0.266), clamp((mean - 0.45) / 0.5, 0.0, 1.0));
        k = vec4(0.6879, 0.1412, 1.6, 0.25);
    }
    vec3 lit = GlassYcc(c, l.x, l.y, l.z) * (1.0 - l.w) + vec3(l.w);
    vec3 dim = GlassYcc(c, k.x, k.y, k.z) * (1.0 - k.w);
    // A glass changing kind blends its two faces.
    return mix(mix(dim, lit, light), clearFace, clear);
}

// THE ACTIVE LENS: Apple's pressed selection, built as UIKit's _UILiquidLensView is (Jwift/Apple/LiquidGlass.md 7),
// its math QuartzCore's (iOS 26.1 default.metallib). Bottom to top, while lifted:
//   BackdropView: everything under the bar's lifted content, through a displacementMap filter (inputAmount
//     GLASS_LENS_BACKDROP_WARP.x [C: the spec's liftedDisplacement 9, UIKitCore sub_1891F47F0]) on an SDF with
//     CASDFGlassDisplacementEffect height GLASS_LENS_BACKDROP_WARP.y [C 36], curvature 1, angle 0, its capsule's
//     gradientOvalization 0.5 [C sub_1891F7498], and a gaussianBlur of radius 0 when lifted [C], captured at the backdrop
//     layer's default scale, 0.25 [C CABackdropLayer defaultValueForKey].
//   ClearGlassView: its glass face over it (the variant's, not yet decoded); its contentWrapper, the lifted copy
//     of the items through a displacementMap of inputAmount GLASS_LENS_ITEM_WARP.x [C -17.5, sub_1891F7824] on an SDF of
//     height GLASS_LENS_ITEM_WARP.y [C 11.2], curvature 1, angle 0; the copy is a portal of the items, where they lie [C];
//     its inverted inner shadow, GLASS_LENS_INNER_SHADOW [C].
//   DestOutView: the real items under the lens erased [C] (here: the lens covers them).
// The displacement is QuartzCore's sdf_glass_displacement (uber shader) read by displacement_map: `amount` x (1 -
// mix(flat, sqrt(1 - (1 - t)^2), curvature)) along the SDF's normal, t = depth / height, none past `height` [C]. At
// curvature 1 that is Apple's quarter-circle bezel, GlassShift. The map is the outward gradient and displacement_map
// adds it, times the amount, to the read point, so a positive amount reads outward and a negative one inward
// [C: sdf_glass_displacement returns (1 - profile) x the rotated gradient]. SampleMapFilter::render negates its
// vertical row only to undo a flipped texture's storage [C: QuartzCore 0x183CB6AE4 to 0x183CB6B2C].
const vec2 GLASS_LENS_BACKDROP_WARP = vec2(9.0, 36.0);
// The BackdropView's displacement runs in its capture's texels, at the backdrop layer's scale 0.25 of the device
// pixel, so its amount lands as points times device scale times 0.25 [I: SampleMapFilter::render builds its matrix
// from the transform and the source texture's texels (QuartzCore 0x183CB6B80); which of the two carries the capture
// scale is not settled. Read through the blurred pyramid it put Apple's inner band edges within 0.25 pt; read
// through the capture itself (lensCapture) they sit 0.7 to 0.8 pt deeper than Apple's, so the warp's strength is open].
// The items' portal is at full scale.
const float GLASS_LENS_BACKDROP_CAPTURE = 0.25;
const vec2 GLASS_LENS_ITEM_WARP = vec2(-17.5, 11.2);
// Both warp SDFs' capsule, its gradientOvalization [C: sub_1891F7498, 0x1891F7760].
const float GLASS_LENS_OVALIZATION = 0.5;
// The lens glass's content lensing, its glassForeground [C: UIKitCore sub_1891F7824 adds the contentLensing option to
// the lens's _Glass configuration; DesignLibrary sub_18AF84454 sets Parameters.Lensing from __TEXT.__const
// 0x18AFDF150, 0x18AFDC160]: refraction height 8, amount -16, inset -3.3 (pt); edge distances 0, 0 and opacities 0, 1.
// Its dispersion is the GlassDispersion setting (Auto: amount -3, height 3.3, inset 0, angle 90 degrees).
const vec3 GLASS_LENS_LENSING_REFRACTION = vec3(8.0, -16.0, -3.3);
const vec4 GLASS_LENS_LENSING_EDGE = vec4(0.0, 0.0, 0.0, 1.0);
const vec3 GLASS_LENS_INNER_SHADOW = vec3(3.0, 0.12, 7.0);
// The edge bleed's own matrix: light (1, 0.9, 1.2), dark (0.5, 0, 1).
vec3 GlassBleed(vec3 c, float light) {
    return mix(GlassYcc(c, 0.5, 0.0, 1.0), GlassYcc(c, 1.0, 0.9, 1.2), light);
}

// The drop shadow's fall, erf-like, 1 at `reach` inside the shifted outline to 0 at `reach` outside it
// (reach = two shadow radii).
float GlassShadowFall(float sd, float reach) {
    float x = 4.0 * clamp(sd / (2.0 * max(reach, 1e-4)) + 0.5, 0.0, 1.0) - 2.0;
    float x2 = x * x;
    return 0.5 + x * (-0.560547 + x2 * (0.168213 + x2 * (-0.034454 + 0.002954 * x2)));
}

// The highlight band of one light: 1 pt deep with an inner shoulder (fade 1 - 0.7 depth), lit where the
// outline faces the light within the spread.
float GlassRimBand(float s, float fw, float height, vec2 n, vec2 light, float cosSpread) {
    if (s < -5.0) return 0.0;
    float nd = clamp(s / max(height, 1e-4), 0.0, 1.0);
    float fade = 1.0 - 0.7 * nd;
    float cov = clamp(s / fw + 0.5, 0.0, 1.0) * clamp((height - s) / fw + 0.5, 0.0, 1.0) * fade;
    float dir = clamp((dot(n, light) - cosSpread) / (1.0 - cosSpread), 0.0, 1.0);
    return cov * dir;
}

// vibrantColorMatrix over what is already drawn, Apple's exact rows: light pushes it to 0.9 + 0.1 Y with 1.5x
// chroma, dark to 0.15 + 1.35 Y with 3x chroma, picked by the glass's appearance (its backdrop's luminance, or its
// theme when it is large), `light` 0..1. Apple's iOS 26 dark rims are not the dark rows alone: the Games bar's and
// its search button's lit lobes over teal, (66, 215, 223) and (97, 230, 229), are the rows mixed 0.6 light to
// 0.4 dark (fitted, Core/Glass.md). Light glass takes the light rows.
vec3 GlassRimMatrix(vec3 c, float light) {
    vec3 lit = vec3(dot(c, vec3(1.2024, -1.0014, -0.1010)), dot(c, vec3(-0.2976, 0.4987, -0.1011)),
                    dot(c, vec3(-0.2977, -1.0012, 1.3989))) + 0.90;
    vec3 dim = vec3(dot(c, vec3(2.6492, -1.1803, -0.1189)), dot(c, vec3(-0.3507, 1.8199, -0.1192)),
                    dot(c, vec3(-0.3509, -1.1799, 2.8809))) + 0.15;
    return clamp(mix(mix(dim, lit, 0.6), lit, light), 0.0, 1.0);
}

// The key light upper left in y-down screen space (its fill is the opposite corner), in the panel's frame.
vec2 GlassKeyLight(vec4 rot, float is3D) {
    vec2 key = vec2(-0.70710678, -0.70710678);
    return is3D > 0.5 ? key : vec2(key.x * rot.x + key.y * rot.y, -key.x * rot.y + key.y * rot.x);
}

// Each light's weight is Apple's `w = a / ((1 - a) c + 1)` of its band alpha `a`. The shaping `c` is not in the
// dumps; 3 is fitted to Apple's iOS 26 dark rims, whose lit lobe stands +100 over the body while the straight top,
// 45 degrees off it, stands +40: a lobe sharper than the plain cosine (Core/Glass.md).
const float GLASS_RIM_SHAPE = 3.0;
float GlassRimWeight(float a) { return a / ((1.0 - a) * GLASS_RIM_SHAPE + 1.0); }

// The highlight's alpha: `amount` per light, key and fill, over a band `height` points deep; the spread is a
// cosine lobe on regular glass and 160 degrees on clear.
float GlassRimAlpha(float d, vec2 n, vec2 key, float amount, float height, float clear) {
    float s = -d;
    float fw = max(fwidth(s), 1e-4);
    float cosSpread = mix(0.0, -0.9397, clear);
    return clamp(amount * (GlassRimWeight(GlassRimBand(s, fw, height, n, key, cosSpread))
                         + GlassRimWeight(GlassRimBand(s, fw, height, n, -key, cosSpread))), 0.0, 1.0);
}

// The highlight as a layer over `under`: its recolor and its alpha. The glass fragment mixes it over its own face;
// the rim pass draws it over the scene, where content reaches the band.
vec4 GlassRim(vec3 under, float d, vec2 n, vec2 key, float amount, float height, float clear, float light) {
    return vec4(GlassRimMatrix(under, light), GlassRimAlpha(d, n, key, amount, height, clear));
}

// .tint(color): a line in the glassed pixel's luma, the seed at full luma and at none the seed's own luma at
// 0.35 with its chroma at 1.10, fitted to SwiftUI's own render (Core/Glass.md).
vec3 GlassTint(vec3 face, vec3 seed) {
    return mix(GlassYcc(seed, 0.35, 0.0, 1.10), seed, dot(face, GLASS_BT709));
}
