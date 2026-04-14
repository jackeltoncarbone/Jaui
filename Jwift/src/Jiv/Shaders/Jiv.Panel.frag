#version 300 es
precision highp float;

in vec2 v_PixelPos;
flat in vec4 v_PanelGeom;      // cx, cy, halfW, halfH
flat in vec4 v_Radii;
flat in vec4 v_Tint;
flat in vec4 v_BorderColor;
flat in vec4 v_ShadowColor;
flat in vec4 v_ShadowParams;   // shadowOffX, shadowOffY, shadowBlur, borderWidth
flat in vec4 v_StyleParams;    // borderBlur, smoothness, opacity, materialType
flat in vec4 v_Grading;        // brightness, saturation, contrast, frostLod
flat in vec4 v_Refraction;     // thickness, bezelWidth, refractionStrength, bezelScale
flat in vec4 v_Lighting;       // lightDirX, lightDirY, lightIntensity, fresnelStrength
flat in vec4 v_Specular;       // specIntensity, specSharpness, chromaticAberration, innerBlur
flat in vec4 v_RimEdge;        // edgeLightTop, edgeLightBottom, borderVariance, bulge
flat in vec4 v_Outline;        // borderAlphaVariance, borderFresnelBrightness, _pad, _pad
flat in vec4 v_BorderFilter;   // brightnessMul, saturationMul, contrastMul, lodOffset

uniform sampler2D u_Backdrop;
uniform vec2 u_Resolution;
// Specular tilt — added to lightDir ONLY for specular computations (bevel
// catchlight and rim-spec highlight), not for ambient/edge-light/border
// directionality. Canvas-wide, set by pointer or gyro each frame. This
// reproduces Apple's gyro-driven catchlight without sliding the virtual
// "sun" for the rest of the material.
uniform vec2 u_SpecularTilt;

out vec4 fragColor;

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
  vec2(0.000000, 1.000000), vec2(0.071905, 0.999903), vec2(0.141683, 0.999227),
  vec2(0.209303, 0.997390), vec2(0.274729, 0.993813), vec2(0.337929, 0.987916),
  vec2(0.398867, 0.979119), vec2(0.457512, 0.966841), vec2(0.513828, 0.950503),
  vec2(0.567783, 0.929525), vec2(0.619341, 0.903327), vec2(0.668471, 0.871328),
  vec2(0.715137, 0.832948), vec2(0.759307, 0.787608), vec2(0.800946, 0.734728),
  vec2(0.840021, 0.673727), vec2(0.874726, 0.607726), vec2(0.889889, 0.574476),
  vec2(0.904073, 0.540309), vec2(0.917279, 0.505288), vec2(0.929507, 0.469473),
  vec2(0.940756, 0.432925), vec2(0.951027, 0.395705), vec2(0.960321, 0.357875),
  vec2(0.968635, 0.319495), vec2(0.975972, 0.280627), vec2(0.982330, 0.241331),
  vec2(0.987711, 0.201669), vec2(0.992113, 0.161702), vec2(0.995536, 0.121490),
  vec2(0.997982, 0.081095), vec2(0.999449, 0.040578), vec2(0.999938, 0.000000)
);

const float SS_PILL_MAXEXTENT = 1.6236; // SS pill max horizontal extent / halfY

// Polyline-based SDF for the SS pill. Pixel-accurate match to SS's
// GeneratePillPath (within ~0.05 px on a 60-tall pill at 33 sample points).
//
// Folds query to first quadrant via abs(). Distinguishes:
//   - flat zone     (|q.x| ≤ halfX − maxExtent): straight-edge SDF in y
//   - endcap zone   (|q.x| > halfX − maxExtent): min distance to polyline
//
// Returns signed distance (negative inside).
float SS_PillSDF(vec2 p, vec2 halfSize) {
    bool horiz = halfSize.x >= halfSize.y;
    vec2 q = horiz ? abs(p) : abs(p.yx);
    vec2 hs = horiz ? halfSize : halfSize.yx;
    float halfY = hs.y;
    float halfX = hs.x;
    float maxExtent = SS_PILL_MAXEXTENT * halfY;
    float flatStart = halfX - maxExtent;

    if (q.x <= flatStart) {
        // Flat zone — top/bottom edge is the only boundary in this column
        return q.y - halfY;
    }

    // Endcap zone — convert to local coords (0,0) at the flat-zone-end + middle
    vec2 qL = vec2(q.x - flatStart, q.y);

    // Min unsigned distance to polyline (32 segments)
    float minDSq = 1e9;
    for (int i = 0; i < SS_PILL_POINT_COUNT - 1; i++) {
        vec2 a = vec2(SS_PILL_CURVE[i].x * maxExtent, SS_PILL_CURVE[i].y * halfY);
        vec2 b = vec2(SS_PILL_CURVE[i+1].x * maxExtent, SS_PILL_CURVE[i+1].y * halfY);
        vec2 ab = b - a;
        vec2 ap = qL - a;
        float t = clamp(dot(ap, ab) / dot(ab, ab), 0.0, 1.0);
        vec2 closest = a + t * ab;
        vec2 d = qL - closest;
        minDSq = min(minDSq, dot(d, d));
    }
    float udist = sqrt(minDSq);

    // Inside test: find boundary u_b on the curve at v = qL.y. The polyline
    // is sorted by decreasing v (starts at v=1, ends at v=0), so a single
    // linear scan finds the bracketing segment.
    float u_b = -1.0;
    for (int i = 0; i < SS_PILL_POINT_COUNT - 1; i++) {
        vec2 a = vec2(SS_PILL_CURVE[i].x * maxExtent, SS_PILL_CURVE[i].y * halfY);
        vec2 b = vec2(SS_PILL_CURVE[i+1].x * maxExtent, SS_PILL_CURVE[i+1].y * halfY);
        if (qL.y <= a.y && qL.y >= b.y) {
            float dv = a.y - b.y;
            float t = dv > 0.0001 ? (a.y - qL.y) / dv : 0.0;
            u_b = mix(a.x, b.x, t);
            break;
        }
    }
    bool inside = qL.y <= halfY && u_b > 0.0 && qL.x <= u_b;
    return inside ? -udist : udist;
}

// Polyline-based gradient. Same loop as SDF but tracks closest point, then
// gradient direction = (qL - closest_point) / |qL - closest_point|, sign-
// flipped for inside points. Restored to original quadrant via sign(p).
vec2 SS_PillGrad(vec2 p, vec2 halfSize) {
    bool horiz = halfSize.x >= halfSize.y;
    vec2 q = horiz ? abs(p) : abs(p.yx);
    vec2 hs = horiz ? halfSize : halfSize.yx;
    float halfY = hs.y;
    float halfX = hs.x;
    float maxExtent = SS_PILL_MAXEXTENT * halfY;
    float flatStart = halfX - maxExtent;

    if (q.x <= flatStart) {
        // Flat zone — outward normal is in y direction
        vec2 g = vec2(0.0, sign(p.y));
        return horiz ? g : g.yx;
    }

    vec2 qL = vec2(q.x - flatStart, q.y);

    float minDSq = 1e9;
    vec2 bestClosest = qL;
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
    }

    // Inside check (same as SDF)
    float u_b = -1.0;
    for (int i = 0; i < SS_PILL_POINT_COUNT - 1; i++) {
        vec2 a = vec2(SS_PILL_CURVE[i].x * maxExtent, SS_PILL_CURVE[i].y * halfY);
        vec2 b = vec2(SS_PILL_CURVE[i+1].x * maxExtent, SS_PILL_CURVE[i+1].y * halfY);
        if (qL.y <= a.y && qL.y >= b.y) {
            float dv = a.y - b.y;
            float t = dv > 0.0001 ? (a.y - qL.y) / dv : 0.0;
            u_b = mix(a.x, b.x, t);
            break;
        }
    }
    bool inside = qL.y <= halfY && u_b > 0.0 && qL.x <= u_b;

    // Outward normal: from closest point on polyline to query, sign-flipped if inside
    vec2 d = qL - bestClosest;
    float L = length(d);
    vec2 g = L > 0.0001 ? d / L : vec2(1.0, 0.0);
    if (inside) g = -g;

    // Restore quadrant sign + axis swap
    g.x *= sign(p.x);
    g.y *= sign(p.y);
    return horiz ? g : g.yx;
}

// Master SDF — operates on a shape defined by halfSize + cornerBox (rx, ry) + exponent n.
// qc is the corner-offset vector (positive in the corner region, zero in the flat zone).
float ShapeSDF_inner(vec2 p, vec2 halfSize, vec2 rAxis, float n) {
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
vec2 ShapeGrad_inner(vec2 p, vec2 halfSize, vec2 rAxis, float n) {
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

float ShapeSDF(vec2 p, vec2 halfSize, vec4 radii, float smoothness, int mode) {
    if (mode == 1) {
        // Pill — pixel-accurate Show Studio Bezier via polyline-SDF
        return SS_PillSDF(p, halfSize);
    }

    vec2 rAxis;
    float n;
    if (mode == 2) {
        // Circle — pure ellipse / circle
        float r = min(halfSize.x, halfSize.y);
        rAxis = vec2(r);
        n = 2.0;
    } else {
        // Rect — pick per-corner radius based on which quadrant we're in
        float r = PickRectRadius(p, radii);
        r = min(r, min(halfSize.x, halfSize.y));
        rAxis = vec2(r);
        n = SmoothnessToExponent(smoothness);
    }
    return ShapeSDF_inner(p, halfSize, rAxis, n);
}

vec2 ShapeGrad(vec2 p, vec2 halfSize, vec4 radii, float smoothness, int mode) {
    if (mode == 1) {
        return SS_PillGrad(p, halfSize);
    }

    vec2 rAxis;
    float n;
    if (mode == 2) {
        float r = min(halfSize.x, halfSize.y);
        rAxis = vec2(r);
        n = 2.0;
    } else {
        float r = PickRectRadius(p, radii);
        r = min(r, min(halfSize.x, halfSize.y));
        rAxis = vec2(r);
        n = SmoothnessToExponent(smoothness);
    }

    return ShapeGrad_inner(p, halfSize, rAxis, n);
}

// Back-compat alias — previously used `AutoSmoothness` to pick a smoothness
// per mode. In the new formulation, Rect uses the user's `Smoothness`; Pill and
// Circle hard-code their own n (2.55 and 2). This wrapper exists so main() can
// still pass a `smoothness` parameter through without change.
float AutoSmoothness(vec2 halfSize, vec4 radii, int mode) {
    // Only Rect honors the input smoothness. Pill/Circle ignore it entirely
    // (their exponent is baked in). Caller can continue to pass user smoothness.
    return 0.6;
}

// Rec. 709 luma
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

vec3 applyGrading(vec3 color, float brightness, float saturation, float contrast) {
    color *= brightness;
    float luma = dot(color, LUMA);
    color = mix(vec3(luma), color, saturation);
    color = (color - 0.5) * contrast + 0.5;
    return color;
}

void main() {
    vec2 panelCenter = v_PanelGeom.xy;
    vec2 panelHalfSize = v_PanelGeom.zw;
    vec2 shadowOffset = v_ShadowParams.xy;
    float shadowBlur = v_ShadowParams.z;
    float borderWidth = v_ShadowParams.w;
    float borderBlur = v_StyleParams.x;
    float smoothness = v_StyleParams.y;
    float opacity = v_StyleParams.z;
    float materialType = v_StyleParams.w;

    float brightness = v_Grading.x;
    float saturation = v_Grading.y;
    float contrast = v_Grading.z;
    float frostLod = v_Grading.w;

    float thickness = v_Refraction.x;
    float bezelWidth = max(v_Refraction.y, 0.5);
    float refractionStrength = v_Refraction.z;
    float bezelScale = max(v_Refraction.w, 0.05);

    vec2 lightDir = v_Lighting.xy;
    float lightIntensity = v_Lighting.z;
    float fresnelStrength = v_Lighting.w;

    float specIntensity = v_Specular.x;
    float specSharpness = max(v_Specular.y, 1.0);
    float chromaticAberration = v_Specular.z;
    float innerBlur = v_Specular.w;

    float edgeLightTop = v_RimEdge.x;
    float edgeLightBottom = v_RimEdge.y;
    float borderVariance = v_RimEdge.z;
    float bulge = v_RimEdge.w;

    vec2 p = v_PixelPos - panelCenter;

    // ── Shape mode + auto-derived smoothness (matches Show Studio) ──
    int mode = ShapeMode(panelHalfSize, v_Radii);
    float effectiveSmooth = AutoSmoothness(panelHalfSize, v_Radii, mode);

    // ── SDF + normal ──
    float dist = ShapeSDF(p, panelHalfSize, v_Radii, effectiveSmooth, mode);
    float edgeDist = max(-dist, 0.0);                 // positive inside
    vec2 normal = ShapeGrad(p, panelHalfSize, v_Radii, effectiveSmooth, mode);

    // ── Bezel hump (pincushion profile) ──
    float x = edgeDist / bezelWidth;
    float s = bezelScale;
    float hump = (x / s) * exp(1.0 - x / s);          // peak = 1 at x = s
    hump *= smoothstep(1.2, 0.8, x);                  // die past the band
    hump = clamp(hump, 0.0, 1.0);

    // ── Fill alpha (shape mask) ──
    float fillAlpha = 1.0 - smoothstep(-0.5, 0.5, dist);

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

    if (materialType == 1.0) {
        // Edge refraction: rotate the outward normal ~10° along the tangent,
        // then negate to sample INWARD (Show Studio's `-refract * edgeIntensity`).
        vec2 tangent = vec2(-normal.y, normal.x);
        vec2 rotatedNormal = normal * 0.985 + tangent * 0.174; // cos(10°), sin(10°)
        vec2 edgeDisp = -rotatedNormal * hump * thickness;

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

        vec2 refractOffset = (edgeDisp + bulgeDisp) * refractionStrength;

        // Variable LOD — center more blurred than rim
        float bandLod = frostLod + innerBlur * 3.0
                       * smoothstep(bezelWidth * 0.5, bezelWidth * 4.0, edgeDist);

        // CA spread along normal, scaled by hump and ca
        float caPx = chromaticAberration * hump * 3.0;
        vec2 caStep = normal * caPx;

        // FBO has top-of-scene at UV.y=1 (panel/text shaders flip Y in clip space).
        // Flip Y here so each fragment samples the pixel directly behind it.
        // `baseUv` was hoisted to the outer scope — assign instead of redeclare
        // so the border-zone refilter can reuse the same refracted UV.
        baseUv = (v_PixelPos + refractOffset) / u_Resolution;
        vec2 uvR = (v_PixelPos + refractOffset + caStep) / u_Resolution;
        vec2 uvB = (v_PixelPos + refractOffset - caStep) / u_Resolution;
        baseUv.y = 1.0 - baseUv.y;
        uvR.y = 1.0 - uvR.y;
        uvB.y = 1.0 - uvB.y;

        // Backdrop is the Dual-Filter PRE-BLURRED FBO with mipmaps generated.
        // Apple's blur is NON-UNIFORM — stronger at the rim, weaker at the
        // center (longer optical path through the glass = more diffusion at
        // the bevel where light enters/exits at a steep angle). We sample
        // with `textureLod` and ramp the LOD up near the rim. LOD 0 = base
        // Gaussian; +1 LOD ≈ 2× box blur; +2 LOD ≈ 4× box blur. The boost
        // peaks at the silhouette edge and dies inward over `bezelWidth`.
        float rimBoost = 1.0 - smoothstep(0.0, bezelWidth * 1.5, edgeDist);
        lodBoost = rimBoost * 1.5 + innerBlur * 1.0;
        vec3 sR = textureLod(u_Backdrop, uvR, lodBoost).rgb;
        vec3 sG = textureLod(u_Backdrop, baseUv, lodBoost).rgb;
        vec3 sB = textureLod(u_Backdrop, uvB, lodBoost).rgb;
        backdrop = vec3(sR.r, sG.g, sB.b);

        backdrop = applyGrading(backdrop, brightness, saturation, contrast);
    }

    // ── Beer-Lambert tint (multiplicative absorption) ──
    // Tint.a scales absorption strength; path length grows toward center.
    if (materialType == 1.0 && v_Tint.a > 0.001) {
        float pathLength = mix(0.3, 1.0, smoothstep(0.0, bezelWidth * 2.0, edgeDist));
        vec3 absorb = pow(max(v_Tint.rgb, vec3(0.0001)), vec3(pathLength * v_Tint.a));
        backdrop *= absorb;
    }

    // ── Variable border width along perimeter ──
    // Thicker where the rim's outward normal aligns with the light direction.
    float alignment = dot(normal, lightDir);            // +1 lit, -1 unlit
    float widthScale = 1.0 + borderVariance * alignment;
    float localBorderWidth = borderWidth * widthScale;
    float localBorderBlur = borderBlur * widthScale;

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
    if (materialType == 1.0 && fillAlpha > 0.0) {
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
        vec3 rimSample = texture(u_Backdrop, rimUv).rgb;

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

    // ── Shadow ──
    // SOFT drop shadow — fades symmetrically across the silhouette edge so the
    // shadow extends OUTSIDE the silhouette (like CSS box-shadow). Old
    // formulation was `1 - smoothstep(-blur, 0, dist)` which clipped at
    // dist=0, producing a hard "shape mask in shadow color" with no outward
    // bleed. Now: full opacity at -blur (deep inside silhouette), 0.5 at the
    // edge, 0 at +blur outside.
    vec2 sp = p - shadowOffset;
    float shadowDist = ShapeSDF(sp, panelHalfSize, v_Radii, effectiveSmooth, mode);
    float shadowAlpha = smoothstep(shadowBlur, -shadowBlur, shadowDist) * v_ShadowColor.a;

    // ── Fill: interior is PURELY the refracted backdrop (LG) or the tint (SG/None).
    // No internal haze, no rim ambient, no specular overlay. All rim brightness
    // comes from the border glow, per Apple Liquid Glass design intent.
    vec3 fillRgb;
    float fillA;
    if (materialType == 1.0) {
        fillRgb = backdrop;
        fillA = fillAlpha;
    } else {
        fillRgb = v_Tint.rgb;
        fillA = fillAlpha * v_Tint.a;
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

    // Composite order for glass:
    //   1) Wide rim glow (vibrant backdrop pickup, inward fade) — the optical
    //      "light gathering" along the bevel
    //   2) Physical Fresnel rim stroke — a thin highlight at the very outline,
    //      thicker + brighter on the lit side (BorderVariance × light angle),
    //      tinted with backdrop vibrancy, fading on the unlit side. This is
    //      what makes the outline read as a real bevel catching light, not a
    //      flat CSS border. For non-glass it falls back to a uniform stroke.
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
            : pow(clamp(1.0 + dist / max(bezelWidth, 0.5), 0.0, 1.0), 2.0);
        vec3 rimAmbientRgb = vec3(hemiAmbient) * rimMask;

        // ── Inner darkening (inset dark ring) ──
        // Apple's glass has a faint inset dark line — the perceptual boundary
        // between the bright rim and the flat interior. Position scales with
        // bezel width (where the refraction band transitions to flat), width
        // with thickness (a thicker slab shows a wider inner line edge-on).
        float innerPos = bezelWidth * 0.35;                  // how far inside to place it
        float innerW   = max(thickness * 0.12, 0.5);         // band half-width
        float innerDarkBand = max(0.0, 1.0 - abs(dist + innerPos) / max(innerW, 0.5));
        float innerDarkAlpha = innerDarkBand * 0.04;

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

        // Composite order:
        //   1) hemispherical rim ambient (additive, sub-rim)
        //   2) wide rim glow (vibrant backdrop pickup)
        //   3) inner darkening (multiplicative subtle dim)
        //   4) Blinn-Phong specular catchlight (additive bright)
        //   5) hairline silhouette stroke
        result.rgb += rimAmbientRgb * fillAlpha;
        result.rgb = result.rgb * (1.0 - edgeLightAlpha) + edgeLightRgb * edgeLightAlpha;
        result.a = result.a * (1.0 - edgeLightAlpha) + edgeLightAlpha;
        result.rgb *= 1.0 - innerDarkAlpha;
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
        float rimSpecW = max(thickness * 0.18, 0.75);
        float rimSpecBand = smoothstep(0.5, -0.5, dist)
                          - smoothstep(-0.5 - rimSpecW, 0.5 - rimSpecW, dist);
        // Directional alignment uses the TILTED light direction so the
        // rim-spec line slides around the perimeter as pointer/gyro moves.
        // The ambient, edge-light, and border directionality stay fixed to
        // the stylesheet-set LightAngle (via `alignment` above).
        vec2 specLightDirRim = normalize(lightDir + u_SpecularTilt);
        float rimSpecAlign = dot(normal, specLightDirRim);
        float rimSpecDir = pow(max(rimSpecAlign, 0.0), 3.0);
        float rimSpecAlpha = rimSpecBand * rimSpecDir * specIntensity * fillAlpha;
        // Color: vibrant-boosted backdrop (sampled at the rim) mixed toward white.
        // LOD offset slightly sharper than the panel so the rim highlight reads
        // as "specular reflection of crisper nearby content."
        vec3 rimSpecBackdrop = textureLod(u_Backdrop, baseUv, max(0.0, lodBoost - 0.5)).rgb;
        float rimSpecLuma = dot(rimSpecBackdrop, LUMA);
        vec3 rimSpecVibrant = clamp(mix(vec3(rimSpecLuma), rimSpecBackdrop, 1.8) * 1.4, 0.0, 1.0);
        vec3 rimSpecRgb = mix(rimSpecVibrant, vec3(1.0), 0.45);
        result.rgb = result.rgb * (1.0 - rimSpecAlpha) + rimSpecRgb * rimSpecAlpha;
        result.a = result.a * (1.0 - rimSpecAlpha) + rimSpecAlpha;

        // ── Border zone backdrop refilter ───────────────────────────────
        // Apple's glass rim isn't a flat color — it's an optical zone where
        // the backdrop is sampled with its OWN grading (typically brighter,
        // more saturated than the panel face). Then the BorderColor is
        // overlaid on top with its alpha as a tint, NOT a solid stroke.
        // This is what gives Apple's rim its "light-gathering" quality
        // without the static UI-border feel.
        float borderOuter = smoothstep(-0.5, 0.5, dist);
        float borderInner = smoothstep(-0.5, 0.5, dist + localBorderWidth);
        float borderBase = (1.0 - borderOuter) * borderInner;

        if (borderBase > 0.001) {
            // Re-sample backdrop with border-zone grading. Same UV (no extra
            // refraction offset — the border is the rim, refraction already
            // applied via `refractOffset`). Apply LOD offset for sharper or
            // blurrier border vs the panel.
            float bLod = max(0.0, lodBoost + v_BorderFilter.w);
            vec3 bSample = textureLod(u_Backdrop, baseUv, bLod).rgb;
            vec3 borderBackdrop = applyGrading(
                bSample,
                brightness * v_BorderFilter.x,
                saturation * v_BorderFilter.y,
                contrast * v_BorderFilter.z
            );

            // Optional tint stroke from BorderColor — alpha controls strength
            // of the colored overlay on top of the refiltered backdrop.
            // Directional brightness from BorderAlphaVariance / FresnelBrightness.
            float lightFacing = max(alignment, 0.0);
            float alphaFloor = 1.0 - v_Outline.x;
            float strokeBrightness = mix(alphaFloor, 1.0, pow(lightFacing, 2.0));
            vec3 strokeTint = mix(v_BorderColor.rgb, vec3(1.0), pow(lightFacing, 3.0) * v_Outline.y);
            vec3 borderRgb = mix(borderBackdrop, strokeTint, v_BorderColor.a * strokeBrightness);

            // Replace the panel result in the border zone (alpha-blended by mask).
            // borderBase is the antialiased annulus; result alpha follows panel.
            result.rgb = mix(result.rgb, borderRgb, borderBase);
            result.a = max(result.a, borderBase * fillAlpha);
        }
    } else {
        float borderOuter = smoothstep(-0.5, 0.5, dist);
        float borderInner = smoothstep(-0.5, 0.5, dist + localBorderWidth);
        float borderBase = (1.0 - borderOuter) * borderInner;
        float borderAlpha = borderBase * v_BorderColor.a;
        result.rgb = result.rgb * (1.0 - borderAlpha) + v_BorderColor.rgb * borderAlpha;
        result.a = result.a * (1.0 - borderAlpha) + borderAlpha;
    }

    result.a *= opacity;
    fragColor = result;
}
