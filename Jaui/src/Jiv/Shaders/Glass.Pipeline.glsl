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

// `frost` is the regular recipe's blur class (Core/Glass.Pipeline.ts, GlassFrost): 0 Automatic, 1 Reduced (a half-scale
// backdrop, 0.667 pt), 2 None (no blur). Clear glass keeps its own recipe.
bool GlassFrostReduced(float frost) { return abs(frost - 1.0) < 0.5; }
float GlassBackdropScale(float clear, float frost) { return mix(GlassFrostReduced(frost) ? 0.5 : 0.25, 0.5, clear); }

// An authored GlassBlur (above 0) replaces the law (Core/Glass.Pipeline.ts, GlassBlurRadius).
float GlassBlurRadius(float span, float clear, float authored, float frost) {
    float regular = frost > 1.5 ? 0.0 : GlassFrostReduced(frost) ? 0.66666667 : 1.3333 + 2.6667 * GlassSizeRamps(span).x;
    return authored > 0.0 ? authored : mix(regular, 1.0, clear);
}

// A radius in points to the LOD of our native pyramid with the blur Apple's quarter (clear: half) resolution
// mip reads at: Apple's LOD, then log2(texel sigma / backdrop scale).
// The texel share follows the backdrop's scale, so Reduced frost's half-scale backdrop reads with clear's.
float GlassNativeLod(float radiusPt, float dpr, float clear, float frost) {
    float scale = GlassBackdropScale(clear, frost);
    float r = radiusPt * scale * dpr * 1.6;
    float appleLod = max(0.0, r < 2.0 ? log2(1.0 + 0.5 * r) : log2(r));
    return appleLod + log2(mix(GLASS_TEXEL_SIGMA_REGULAR, GLASS_TEXEL_SIGMA_CLEAR, GlassFrostReduced(frost) ? 1.0 : clear) / scale);
}

// The pyramid level that delivers a Gaussian of `sigma` device px. Level L of a pyramid whose level 0 has `texel`
// device px and delivers `sigma0` reads as variance sigma0^2 + (5/12) texel^2 (4^L - 1): each [1 3 3 1] mip hop adds
// 3/4 of its source texel squared, the bilinear read 1/6 of its own. Trilinear mixes variances, so the fraction is
// linear in variance between whole levels (Core/Glass.Pipeline.ts states the same).
float GlassPyramidLevel(float sigma, float texel, float sigma0) {
    float q = (sigma * sigma - sigma0 * sigma0) / (0.41666667 * texel * texel) + 1.0;
    if (q <= 1.0) return 0.0;
    float whole = floor(0.5 * log2(q));
    float p = exp2(2.0 * whole);
    return whole + (q - p) / (3.0 * p);
}

// QuartzCore's set_ycc_composite without its fill: BT.709 luma remapped to (white - black) Y + black, chroma
// scaled by `saturation`.
vec3 GlassYcc(vec3 c, float white, float black, float saturation) {
    float y = dot(c, GLASS_BT709);
    return vec3((white - black) * y + black) + saturation * (c - y);
}

// The face: (white, black, saturation, fill alpha), light filled white and dark filled black, premultiplied.
// LARGE GLASS TAKES APPLE'S DECOMPILED FACES (Drill Sentences lane GL1; LiquidGlass.md 3.3 [C]): regular light
// (1.03, 0.5, 1.0, white 0.4), Y -> 0.318 Y + 0.70; regular dark (0.6, 0.2, 1.0, black 0.4), Y -> 0.24 Y + 0.12;
// chroma x 0.6 both. The fitted faces below (Core/Glass.md) were fitted to glass 64 pt and under (iOS's 62 pt bars and
// small controls, SwiftUI's capsule), where Apple's glass tracks its backdrop's luma; the dark one, Y -> 0.40 Y + 0.176
// with chroma x 0.85, carries that adaptive lift, so on a sheet or a panel it lifted every backdrop darker than 0.29 (a
// dark-theme field, +11 L* live) where Apple's never lifts anything brighter than 0.16. They hold to 64 pt and hand
// off to Apple's over 64 to 96 pt (GLASS_FACE_LARGE_SPAN), so a pill that grows into its menu never pops. Glass 56 pt
// and under (GLASS_TRACKS_LUMA_SPAN) tracks its backdrop: its light face moves between Apple's observed settled
// values by the mean luma, its dark face is the one fitted to iOS's small controls. Core/Glass.Pipeline.ts states the
// same numbers (GlassFaceParams), and the App's GlassStack.Render.spec.ts reads them out of this file.
const vec2 GLASS_FACE_LARGE_SPAN = vec2(64.0, 96.0);
const vec4 GLASS_FACE_APPLE_LIGHT = vec4(1.03, 0.5, 1.0, 0.4);
const vec4 GLASS_FACE_APPLE_DARK = vec4(0.6, 0.2, 1.0, 0.4);
// GLASS PRESENTED OVER GLASS (Drill Sentences lanes GL3 and GL5): a large dark face that stands over an earlier glass
// face (`elevation`, 0 to 1, Core/Jaui.ts from Core/Glass.Pipeline.ts `GlassElevationOf`) reads that glass's final
// pixels (Core/Glass.Plate.ts, `GlassReadsComposite`) and wears the presented dark face once over them: Apple's slope,
// Y -> 0.24 Y + 0.222, fixed point 0.29, chroma held (x 1), so it stands a step above the glass under it and never
// darker or greyer [I] (Core/Glass.Pipeline.ts, GLASS_FACE_APPLE_DARK_ELEVATED; Jwift/Apple/LiquidGlass.md 8.1).
// Light glass keeps its face.
const vec4 GLASS_FACE_APPLE_DARK_ELEVATED = vec4(0.77, 0.37, 1.6667, 0.4);
vec3 GlassFace(vec3 c, float span, float clear, float light, float mean, float elevation) {
    vec3 clearFace = GlassYcc(c, 1.1054, 0.1295, 0.885);
    if (clear >= 1.0) return clearFace;
    vec4 l = vec4(1.0054, 0.0829, 1.2246, 0.4);
    vec4 k = vec4(0.9608, 0.2941, 1.4167, 0.4);
    if (span <= 56.0) {
        l = mix(vec4(0.919, 0.319, 1.0, 0.516), vec4(1.03, 0.819, 1.0, 0.266), clamp((mean - 0.45) / 0.5, 0.0, 1.0));
        k = vec4(0.6879, 0.1412, 1.6, 0.25);
    }
    float toApple = clamp((span - GLASS_FACE_LARGE_SPAN.x) / (GLASS_FACE_LARGE_SPAN.y - GLASS_FACE_LARGE_SPAN.x), 0.0, 1.0);
    l = mix(l, GLASS_FACE_APPLE_LIGHT, toApple);
    k = mix(k, mix(GLASS_FACE_APPLE_DARK, GLASS_FACE_APPLE_DARK_ELEVATED, clamp(elevation, 0.0, 1.0)), toApple);
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
// The lens glass's inner glow: grey, opacity, radius (pt) [C: DesignLibrary sub_18AF84454 sets Parameters.innerGlow
// {hdr 0.8, opacity 0.3, radius 8}; GlassMaterialProvider draws it as SDFLayer.shadow_v2 (inset 0, that grey, the radius,
// no offset, knockout, inverted), grouped plusLighter at the opacity, DesignLibrary 0x18AE87638 to 0x18AE87740].
const vec3 GLASS_LENS_INNER_GLOW = vec3(0.8, 0.3, 8.0);
// Lane 43 carries the glass's clear amount (0..1) and its pressed glow in thousandths above it.
float GlassLaneClear(float lane) { return mod(lane, 4.0); }
float GlassLaneGlow(float lane) { return floor(lane / 4.0) / 1000.0; }
// The dispersion lane: the dispersion (0..4), an authored GlassBlur in sixteenths of a point above it, then the
// exterior switches (1 outer refraction off, 2 bleed reach off), then the frost times 4.
float GlassLaneCa(float lane) { return mod(lane, 4.0); }
float GlassLaneBlur(float lane) { return floor(mod(lane, 16384.0) / 4.0) / 16.0; }
float GlassLaneExterior(float lane) { return mod(floor(lane / 16384.0), 4.0); }
float GlassLaneFrost(float lane) { return floor(lane / 65536.0); }
// UIKit's flex big glow over a pressed glass: a white layer with a backdrop-aware vibrant colour matrix, YCC black
// 0.05, white 1.05, saturation 1.2, at `glow` (the spec's bigGlowOpacity) [C: _UIFlexInteraction.BigGlow,
// UIKitCore 0x188B0F3D0]. It lies over the glass and its rim; here it recolours both (the items draw over it).
vec3 GlassPressGlow(vec3 c, float glow) {
    return mix(c, clamp(GlassYcc(c, 1.05, 0.05, 1.2), 0.0, 1.0), glow);
}
// UIKit's flex little glow under the finger: a white disc of `diameter` casting a white shadow of radius half the
// diameter (shadowPathIsBounds, opacity 1), shown only through that shadow [C: _UIFlexInteractionLittleGlowView,
// UIKitCore sub_188F4C4CC]. CA's shadow radius read as two sigma, and the disc's blur as a logistic edge [I].
float GlassTouchGlow(float r, float diameter) {
    float sigma = max(diameter * 0.25, 1e-3);
    return 1.0 / (1.0 + exp(1.702 * (r - diameter * 0.5) / sigma));
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

// THE POPOVER ARROW (Drill Sentences lane GL4; Jwift/Apple/Sizing.md 13 [C]; Core/Glass.Pipeline.ts states the same,
// GlassArrowField and GlassArrowUnion). A popover's glass is one outline, the body and an arrow 13 pt tall on a 26 pt
// base, its tip rounded by one cubic on the peak, its flanks leaving the edge through concave fillets over 37 pt. The
// union's distance feeds everything the body's does: the fill, the lens, the rim, the bleed and both shadows.
// Lane 38 carries the shadow draw's mode (0..2) and above it, in 4s, the arrow: its side (1 top, 2 bottom, 3 left,
// 4 right, 0 none) and, in 8s above that, its offset from the edge's centre in quarter device px biased by 32768.
float GlassLaneShadowMode(float lane) { return mod(lane, 4.0); }
float GlassLaneArrow(float lane) { return floor(lane / 4.0); }
const float GLASS_ARROW_HALF_FOOTPRINT = 18.5;

vec2 GlassArrowCubic(vec2 a, vec2 b, vec2 c, vec2 d, float t) {
    float u = 1.0 - t;
    return u * u * u * a + 3.0 * u * u * t * b + 3.0 * u * t * t * c + t * t * t * d;
}
// Keep the nearer of the best so far and the segment from `a` to `b` (left to right in u), and read the outline's height
// over q.x where the segment spans it.
void GlassArrowNearest(vec2 q, vec2 a, vec2 b, inout float best, inout vec2 bestPoint, inout vec2 bestOut, inout float graph) {
    vec2 span = b - a;
    float t = clamp(dot(q - a, span) / max(dot(span, span), 1e-12), 0.0, 1.0);
    vec2 point = a + span * t;
    vec2 off = q - point;
    float d2 = dot(off, off);
    if (d2 < best) { best = d2; bestPoint = point; bestOut = vec2(-span.y, span.x) * inversesqrt(max(dot(span, span), 1e-12)); }
    if (q.x >= a.x && q.x <= b.x && b.x > a.x) graph = mix(a.y, b.y, (q.x - a.x) / (b.x - a.x));
}
// The arrow's own field at (u, w) points, u along the edge from its centre and w outward: the distance to its outline,
// the outward normal there and whether the point lies inside it. The right half is walked, folded: the tip cubic's
// second half, the straight flank, the fillet.
float GlassArrowField(vec2 uw, out vec2 outward, out bool inside) {
    vec2 q = vec2(abs(uw.x), uw.y);
    float best = 1e20;
    vec2 bestPoint = q;
    vec2 bestOut = vec2(0.0, 1.0);
    float graph = -1.0;
    vec2 prev = vec2(0.0, 12.75);
    for (int i = 1; i <= 4; i++) {
        vec2 next = GlassArrowCubic(vec2(-2.0, 12.0), vec2(0.0, 13.0), vec2(0.0, 13.0), vec2(2.0, 12.0), 0.5 + 0.125 * float(i));
        GlassArrowNearest(q, prev, next, best, bestPoint, bestOut, graph);
        prev = next;
    }
    GlassArrowNearest(q, prev, vec2(7.5, 6.0), best, bestPoint, bestOut, graph);
    prev = vec2(7.5, 6.0);
    for (int i = 1; i <= 8; i++) {
        vec2 next = GlassArrowCubic(vec2(7.5, 6.0), vec2(13.0, 0.0), vec2(13.0, 0.0), vec2(18.5, 0.0), float(i) / 8.0);
        GlassArrowNearest(q, prev, next, best, bestPoint, bestOut, graph);
        prev = next;
    }
    inside = q.y > 0.0 && q.y < graph;
    float d = sqrt(best);
    vec2 n = d > 1e-4 ? (inside ? bestPoint - q : q - bestPoint) / d : bestOut;
    outward = vec2(uw.x < 0.0 ? -n.x : n.x, n.y);
    return d;
}
// The body and its arrow as one outline: the union's signed distance (device px, negative inside) at `p`, taken from the
// body's centre, given the body's own `bodyDist`, and its outward unit vector written over `outward` where the arrow decides
// it. `pt` is device px per point. Under the arrow's footprint, inside the body, the body's own edge is no edge: the
// nearest is the arrow's outline or one of the body's other three sides, so no rim or lens runs along the seam. The
// offset is clamped so the footprint stays clear of the edge's corner radius.
float GlassArrowUnion(vec2 p, vec2 halfSize, vec4 radii, float arrow, float pt, float bodyDist, inout vec2 outward) {
    float side = mod(arrow, 8.0);
    bool across = side > 2.5;
    float along = across ? halfSize.y : halfSize.x;
    float perp = across ? halfSize.x : halfSize.y;
    vec4 r = clamp(radii, vec4(0.0), vec4(min(halfSize.x, halfSize.y)));
    float corner = side < 1.5 ? max(r.x, r.y) : side < 2.5 ? max(r.z, r.w) : side < 3.5 ? max(r.x, r.w) : max(r.y, r.z);
    float room = max(0.0, along - corner - GLASS_ARROW_HALF_FOOTPRINT * pt);
    float offset = clamp((floor(arrow / 8.0) - 32768.0) * 0.25, -room, room);
    float sgn = (side < 1.5 || (side > 2.5 && side < 3.5)) ? -1.0 : 1.0;
    vec2 uw = across ? vec2(p.y - offset, sgn * p.x - perp) : vec2(p.x - offset, sgn * p.y - perp);
    vec2 n;
    bool inside;
    float dArrow = GlassArrowField(uw / pt, n, inside) * pt;
    vec2 nShape = across ? vec2(sgn * n.y, n.x) : vec2(n.x, sgn * n.y);
    if (inside) { outward = nShape; return -dArrow; }
    if (bodyDist >= 0.0) {
        if (dArrow < bodyDist) { outward = nShape; return dArrow; }
        return bodyDist;
    }
    if (abs(uw.x) < GLASS_ARROW_HALF_FOOTPRINT * pt) {
        float toSides = along - abs(uw.x + offset);
        float toFar = 2.0 * perp + uw.y;
        float other = min(toSides, toFar);
        if (dArrow < other) { outward = nShape; return -dArrow; }
        vec2 o = toSides < toFar ? vec2(uw.x + offset < 0.0 ? -1.0 : 1.0, 0.0) : vec2(0.0, -1.0);
        outward = across ? vec2(sgn * o.y, o.x) : vec2(o.x, sgn * o.y);
        return -other;
    }
    return bodyDist;
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

// .tint(color) (Jwift/Apple/LiquidGlass.md 4 [C]): the glass filter does not change; over the glassed pixel a
// backdrop-aware vibrant matrix whose rows are affine in that pixel's luma L, the seed exactly at L = 1 and its dark
// shade at L = 0: tint = mix(darkShade, seed, L). The dark shade is the general law fitted to iOS 26's two decompiled
// rows (orange, blue) [I]: the seed's luma x 0.58, its chroma x 0.63 (Drill Sentences lane GL6; Core/Glass.md, Tint).
// Core/Glass.Pipeline.ts states the same numbers (GLASS_TINT_SHADE, GlassTintOf).
const vec2 GLASS_TINT_SHADE = vec2(0.58, 0.63);
// GLASS THAT ADAPTS (Core/Glass.Pipeline.ts states the same numbers): at full adaptation the frost is this much more
// again, and a seeded tint reaches this alpha at most, so the glass never goes a flat grey.
const float GLASS_ADAPT_FROST = 1.5;
const float GLASS_ADAPT_TINT_MAX = 0.72;
float GlassAdaptedTint(float alpha, float adapt) {
    return alpha + (max(alpha, GLASS_ADAPT_TINT_MAX) - alpha) * adapt;
}
// A seeded glass (a panel) takes the regular face at every size: any span past the thin control's fit.
const float GLASS_PANEL_FACE_SPAN = 57.0;

vec3 GlassTint(vec3 face, vec3 seed) {
    return mix(GlassYcc(seed, GLASS_TINT_SHADE.x, 0.0, GLASS_TINT_SHADE.y), seed, clamp(dot(face, GLASS_BT709), 0.0, 1.0));
}

// THE INK ON A TINTED GLASS (Drill Sentences lane GL6b). A fully tinted glass (Apple's `.glassProminent`) is the seed
// over light content and its dark shade over dark content, so no single ink reads on it everywhere: its label takes
// white where the tinted body is dark and black where it is light, decided on the body itself. Black, not a warm
// near-black: WCAG puts the two inks' crossover at relative luminance sqrt(0.05 x 1.05) - 0.05 = 0.1791, where white
// and black both read 4.58:1; any ink brighter than relative luminance 0.0018 leaves a band of bodies where neither
// reaches 4.5:1. Apple's own label on light glass is black (LiquidGlass.md 6). Core/Glass.Pipeline.ts states the same
// (GlassTintedBodyOf, GLASS_TINT_INK_SWITCH, GlassTintInkOf); the text shader reads it at the glass's probed mean.
const float GLASS_TINT_INK_SWITCH = 0.1791;

// The body of a fully tinted glass over an even backdrop `c`, inside its rim: the face at the panel span, the edge bleed,
// the holding tone, then the tint, as Jiv.Panel.frag runs them.
vec3 GlassTintedBody(vec3 c, float span, float light, vec3 seed) {
    vec3 face = GlassFace(c, max(span, GLASS_PANEL_FACE_SPAN), 0.0, light, 0.5, 0.0);
    float v = GlassSizeRamps(span).y;
    if (v > 0.0) {
        float lum = dot(face, GLASS_BLEED_LUMA);
        float weight = mix(1.0 - lum, lum, light);
        weight = weight * weight;
        face = mix(face, GlassBleed(c, light), clamp(weight * weight * v * mix(0.8, 0.5, light), 0.0, 1.0));
    }
    face = clamp(face * 0.97, 0.0, 1.0);
    return clamp(GlassTint(face, seed), 0.0, 1.0);
}

// WCAG relative luminance of an encoded colour.
float GlassRelativeLuminance(vec3 c) {
    vec3 lin = mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
    return dot(lin, GLASS_BT709);
}

// 1 for white ink on the tinted body, 0 for black.
float GlassTintInkWhite(vec3 body) {
    return GlassRelativeLuminance(body) <= GLASS_TINT_INK_SWITCH ? 1.0 : 0.0;
}
