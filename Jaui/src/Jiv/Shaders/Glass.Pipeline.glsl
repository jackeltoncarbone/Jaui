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

// The blur ramp against (d + inner shift): full radius from half the span in, half radius over the last point.
float GlassBlurScale(float t, float span) {
    if (t >= -1.0) return 0.5;
    float from = -0.5 * span;
    return mix(1.0, 0.5, clamp((t - from) / max(-1.0 - from, 1e-3), 0.0, 1.0));
}

float GlassBackdropScale(float clear) { return clear > 0.5 ? 0.5 : 0.25; }

float GlassBlurRadius(float span, float clear) {
    return clear > 0.5 ? 1.0 : 1.3333 + 2.6667 * GlassSizeRamps(span).x;
}

// A radius in points to the LOD of our native pyramid with the blur Apple's quarter (clear: half) resolution
// mip reads at: Apple's LOD, then log2(texel sigma / backdrop scale).
float GlassNativeLod(float radiusPt, float dpr, float clear) {
    float scale = GlassBackdropScale(clear);
    float r = radiusPt * scale * dpr * 1.6;
    float appleLod = max(0.0, r < 2.0 ? log2(1.0 + 0.5 * r) : log2(r));
    return appleLod + log2((clear > 0.5 ? GLASS_TEXEL_SIGMA_CLEAR : GLASS_TEXEL_SIGMA_REGULAR) / scale);
}

// QuartzCore's set_ycc_composite without its fill: BT.709 luma remapped to (white - black) Y + black, chroma
// scaled by `saturation`.
vec3 GlassYcc(vec3 c, float white, float black, float saturation) {
    float y = dot(c, GLASS_BT709);
    return vec3((white - black) * y + black) + saturation * (c - y);
}

// The face: (white, black, saturation, fill alpha), light filled white and dark filled black, premultiplied.
// Apple's structure with its parameters FITTED (Core/Glass.md): light and clear to SwiftUI's own render of the
// same inputs (macOS 27), dark to Apple's native iOS 26 dark captures. Glass 56 pt and under tracks its
// backdrop: its light face moves between Apple's observed settled values by the mean luma, its dark face is
// the one fitted to iOS's small controls.
vec3 GlassFace(vec3 c, float span, float clear, float light, float mean) {
    if (clear > 0.5) return GlassYcc(c, 1.1054, 0.1295, 0.885);
    vec4 l = vec4(1.0054, 0.0829, 1.2246, 0.4);
    vec4 k = vec4(0.9608, 0.2941, 1.4167, 0.4);
    if (span <= 56.0) {
        l = mix(vec4(0.919, 0.319, 1.0, 0.516), vec4(1.03, 0.819, 1.0, 0.266), clamp((mean - 0.45) / 0.5, 0.0, 1.0));
        k = vec4(0.6879, 0.1412, 1.6, 0.25);
    }
    vec3 lit = GlassYcc(c, l.x, l.y, l.z) * (1.0 - l.w) + vec3(l.w);
    vec3 dim = GlassYcc(c, k.x, k.y, k.z) * (1.0 - k.w);
    return mix(dim, lit, light);
}

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
// chroma, dark to 0.15 + 1.35 Y with 3x chroma. Apple's iOS 26 dark rims are neither alone: the Games bar's and
// its search button's lit lobes over teal, (66, 215, 223) and (97, 230, 229), are the rows mixed 0.6 light to
// 0.4 dark, whatever the appearance (fitted, Core/Glass.md).
vec3 GlassRimMatrix(vec3 c) {
    vec3 lit = vec3(dot(c, vec3(1.2024, -1.0014, -0.1010)), dot(c, vec3(-0.2976, 0.4987, -0.1011)),
                    dot(c, vec3(-0.2977, -1.0012, 1.3989))) + 0.90;
    vec3 dim = vec3(dot(c, vec3(2.6492, -1.1803, -0.1189)), dot(c, vec3(-0.3507, 1.8199, -0.1192)),
                    dot(c, vec3(-0.3509, -1.1799, 2.8809))) + 0.15;
    return clamp(mix(dim, lit, 0.6), 0.0, 1.0);
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
    float cosSpread = clear > 0.5 ? -0.9397 : 0.0;
    return clamp(amount * (GlassRimWeight(GlassRimBand(s, fw, height, n, key, cosSpread))
                         + GlassRimWeight(GlassRimBand(s, fw, height, n, -key, cosSpread))), 0.0, 1.0);
}

vec3 GlassRim(vec3 c, float d, vec2 n, vec2 key, float amount, float height, float clear) {
    return mix(c, GlassRimMatrix(c), GlassRimAlpha(d, n, key, amount, height, clear));
}

// .tint(color): a line in the glassed pixel's luma, the seed at full luma and at none the seed's own luma at
// 0.35 with its chroma at 1.10, fitted to SwiftUI's own render (Core/Glass.md).
vec3 GlassTint(vec3 face, vec3 seed) {
    return mix(GlassYcc(seed, 0.35, 0.0, 1.10), seed, dot(face, GLASS_BT709));
}
