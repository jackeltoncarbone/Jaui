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
flat in vec4 v_RimEdge;        // edgeLightTop, edgeLightBottom, borderVariance, _pad

uniform sampler2D u_Backdrop;
uniform vec2 u_Resolution;

out vec4 fragColor;

// ────────── Shape mode + smoothness (matches Show Studio visible outline) ──────────
// SS's visible pill is a custom Bezier, NOT a uniform capsule. Its curvature profile
// is tighter near top/bottom and wider in the middle — approximately a superellipse
// with p ≈ 2.75 (smoothness 0.25). We use superellipse for ALL shapes with the
// appropriate smoothness, matching SS's GetMode() output:
//
//   0 = Rect    — aspect < 1.3 or radius small            (auto-smoothness 0.45..0.65)
//   1 = Pill    — aspect ≥ 1.3 AND radius ≈ max           (smoothness 0.25 — Apple squircle-pill)
//   2 = Circle  — aspect ∈ (0.7, 1.43) AND radius ≈ max   (smoothness 0.01 — near-perfect circle)
int ShapeMode(vec2 halfSize, vec4 radii) {
    float minHalf = min(halfSize.x, halfSize.y);
    float maxHalf = max(halfSize.x, halfSize.y);
    float aspect = maxHalf / max(minHalf, 0.0001);
    float minRadius = min(min(radii.x, radii.y), min(radii.z, radii.w));

    bool isCircle = aspect < 1.43 && minRadius >= minHalf * 0.9;
    if (isCircle) return 2;

    bool isPill = aspect >= 1.3 && minRadius >= minHalf - 1.0;
    if (isPill) return 1;

    return 0;
}

float AutoSmoothness(vec2 halfSize, vec4 radii, int mode) {
    if (mode == 2) return 0.01;   // Circle
    if (mode == 1) return 0.25;   // Pill — Apple squircle-pill (p = 2.75)

    // Rect: base + pill-easing
    float minHalf = min(halfSize.x, halfSize.y);
    float minRadius = min(min(radii.x, radii.y), min(radii.z, radii.w));

    float base;
    if (minHalf <= minRadius) base = 0.65;
    else if (minHalf >= minRadius * 1.5) base = 0.45;
    else {
        float t = (minHalf - minRadius) / (minRadius * 0.5);
        base = mix(0.65, 0.45, t);
    }

    float maxR = minHalf;
    float pillThreshold = maxR * 0.7;
    if (minRadius > pillThreshold) {
        float f = clamp((minRadius - pillThreshold) / (maxR - pillThreshold), 0.0, 1.0);
        float e = f * f * (3.0 - 2.0 * f);
        base = base * (1.0 - e * 0.96) + 0.04 * e;
    }
    return base;
}

// ────────── Superellipse (Rect / Squircle mode) ──────────
float SuperellipseSDF(vec2 p, vec2 halfSize, vec4 radii, float smoothness) {
    float r = p.x >= 0.0
        ? (p.y <= 0.0 ? radii.y : radii.z)
        : (p.y <= 0.0 ? radii.x : radii.w);
    r = min(r, min(halfSize.x, halfSize.y));
    float n = 2.0 + 3.0 * smoothness;
    vec2 q = abs(p) - halfSize + r;
    if (q.x <= 0.0 && q.y <= 0.0) {
        return -min(halfSize.x - abs(p.x), halfSize.y - abs(p.y));
    }
    float qxn = pow(max(q.x, 0.0), n);
    float qyn = pow(max(q.y, 0.0), n);
    return pow(qxn + qyn, 1.0 / n) - r;
}

vec2 SuperellipseGrad(vec2 p, vec2 halfSize, vec4 radii, float smoothness) {
    const float eps = 1.0;
    float dX = SuperellipseSDF(p + vec2(eps, 0.0), halfSize, radii, smoothness)
             - SuperellipseSDF(p - vec2(eps, 0.0), halfSize, radii, smoothness);
    float dY = SuperellipseSDF(p + vec2(0.0, eps), halfSize, radii, smoothness)
             - SuperellipseSDF(p - vec2(0.0, eps), halfSize, radii, smoothness);
    vec2 g = vec2(dX, dY);
    float L = length(g);
    return L > 0.0001 ? g / L : vec2(0.0);
}

// ────────── Apple squircle-pill SDF (TRUE perpendicular distance) ──────────
// `extent(u) = maxExt * (1 - u²)^0.284` where u = |py / halfH|, constants from SS's
// `GeneratePillPath` Bezier control points.
//
// The cap's implicit equation is F(x, y) = x − (flatExtent + ext(|y/halfH|)) = 0.
// The perpendicular distance from a point to F=0 is F / |∇F|. We compute ∇F
// analytically via d(ext)/du, then take max with the vertical constraint
// (y ≤ halfH) to get the SDF of the convex intersection. This is a TRUE SDF —
// constant-distance offsets are real perpendicular offsets — so a
// `dist − borderWidth` contour produces a concentric pill-shaped inner border.
float ApplePillSDF(vec2 p, vec2 halfSize) {
    bool horiz = halfSize.x >= halfSize.y;
    vec2 hs = horiz ? halfSize : halfSize.yx;
    vec2 q = horiz ? vec2(abs(p.x), abs(p.y)) : vec2(abs(p.y), abs(p.x));

    // SS's pill: the curve never reaches its CP at 42.5 — it bulges to ~40.59
    // (empirically the max of the Bezier mid-segment). flatExtent is where the
    // straight side ends, so the cap tip at u=0 lands at flatExtent + maxExtent
    // — and we want that == hs.x so the shape exactly fills its bbox (otherwise
    // a thin shadow sliver shows through at the cap tips).
    float endScale = hs.y / 25.0;
    float maxExtent = 40.59 * endScale;
    float flatExtent = hs.x - maxExtent;

    float u = q.y / hs.y;
    float oneMinusU2 = max(1.0 - u * u, 0.0001);
    float ext = maxExtent * pow(oneMinusU2, 0.284);

    // ∂ext/∂u = 0.284 · maxExtent · (1−u²)^(−0.716) · (−2u) = −0.568 · u · maxExtent · (1−u²)^(−0.716)
    float dExtDu = -0.568 * u * maxExtent * pow(oneMinusU2, -0.716);
    float dExtDy = dExtDu / hs.y;

    // Perpendicular distance to cap curve: F / |∇F|  (∇F = (1, -dExt/dy))
    float horiz_d = q.x - (flatExtent + ext);
    float gradLen = sqrt(1.0 + dExtDy * dExtDy);
    float horiz_perp = horiz_d / gradLen;

    float vert_d = q.y - hs.y;   // already a true perpendicular distance

    return max(horiz_perp, vert_d);
}

vec2 ApplePillGrad(vec2 p, vec2 halfSize) {
    const float eps = 1.0;
    float dX = ApplePillSDF(p + vec2(eps, 0.0), halfSize)
             - ApplePillSDF(p - vec2(eps, 0.0), halfSize);
    float dY = ApplePillSDF(p + vec2(0.0, eps), halfSize)
             - ApplePillSDF(p - vec2(0.0, eps), halfSize);
    vec2 g = vec2(dX, dY);
    float L = length(g);
    return L > 0.0001 ? g / L : vec2(0.0);
}

// ────────── Unified shape SDF / gradient ──────────
//   mode 0: Rect    — superellipse with auto-smoothness
//   mode 1: Pill    — Apple squircle-pill (Bezier-derived, true SDF)
//   mode 2: Circle  — superellipse at smoothness ≈ 0.01
float ShapeSDF(vec2 p, vec2 halfSize, vec4 radii, float smoothness, int mode) {
    if (mode == 1) return ApplePillSDF(p, halfSize);
    return SuperellipseSDF(p, halfSize, radii, smoothness);
}

vec2 ShapeGrad(vec2 p, vec2 halfSize, vec4 radii, float smoothness, int mode) {
    if (mode == 1) return ApplePillGrad(p, halfSize);
    return SuperellipseGrad(p, halfSize, radii, smoothness);
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
    if (materialType == 1.0) {
        // Edge refraction: rotate the outward normal ~10° along the tangent,
        // then negate to sample INWARD (Show Studio's `-refract * edgeIntensity`).
        vec2 tangent = vec2(-normal.y, normal.x);
        vec2 rotatedNormal = normal * 0.985 + tangent * 0.174; // cos(10°), sin(10°)
        vec2 edgeDisp = -rotatedNormal * hump * thickness;

        // Surface bulge: radial direction from panel center, scaled by dome profile.
        vec2 bulgeDisp = vec2(0.0);
        if (bulge != 0.0) {
            float maxRadius = max(panelHalfSize.x, panelHalfSize.y);
            float normDist = clamp(length(p) / max(maxRadius, 1.0), 0.0, 1.0);
            float domeProfile = normDist * (1.0 - 0.3 * normDist);
            vec2 radialDir = length(p) > 0.001 ? p / length(p) : vec2(0.0);
            bulgeDisp = radialDir * domeProfile * bulge * 40.0;
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
        vec2 baseUv = (v_PixelPos + refractOffset) / u_Resolution;
        vec2 uvR = (v_PixelPos + refractOffset + caStep) / u_Resolution;
        vec2 uvB = (v_PixelPos + refractOffset - caStep) / u_Resolution;
        baseUv.y = 1.0 - baseUv.y;
        uvR.y = 1.0 - uvR.y;
        uvB.y = 1.0 - uvB.y;

        // Backdrop is a PRE-BLURRED 2-pass Gaussian FBO. Sample directly — no
        // need for mipmap LOD or multi-tap (which would double-blur and muddy
        // the image). The texture has LINEAR filtering for free.
        vec3 sR = texture(u_Backdrop, uvR).rgb;
        vec3 sG = texture(u_Backdrop, baseUv).rgb;
        vec3 sB = texture(u_Backdrop, uvB).rgb;
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
    vec2 sp = p - shadowOffset;
    float shadowDist = ShapeSDF(sp, panelHalfSize, v_Radii, effectiveSmooth, mode);
    float shadowAlpha = (1.0 - smoothstep(-shadowBlur, 0.0, shadowDist)) * v_ShadowColor.a;

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

    // ── Composite: shadow → fill → edge-light (premultiplied-over) ──
    vec4 shadow = vec4(v_ShadowColor.rgb, shadowAlpha);
    vec4 fill = vec4(fillRgb, fillA);
    vec4 result = shadow;
    result = mix(result, fill, fillA);

    // Composite order for glass:
    //   1) Wide rim glow (vibrant backdrop pickup, inward fade) — the optical
    //      "light gathering" along the bevel
    //   2) Physical Fresnel rim stroke — a thin highlight at the very outline,
    //      thicker + brighter on the lit side (BorderVariance × light angle),
    //      tinted with backdrop vibrancy, fading on the unlit side. This is
    //      what makes the outline read as a real bevel catching light, not a
    //      flat CSS border. For non-glass it falls back to a uniform stroke.
    if (materialType == 1.0) {
        result.rgb = result.rgb * (1.0 - edgeLightAlpha) + edgeLightRgb * edgeLightAlpha;
        result.a = result.a * (1.0 - edgeLightAlpha) + edgeLightAlpha;

        // Fresnel rim stroke — variable width, color = backdrop-vibrant + white spec,
        // alpha modulated by light facing.
        float lightFacing = max(alignment, 0.0);
        // Brighter on lit side (60..100%), dimmer on unlit (10..50%).
        float strokeBrightness = mix(0.15, 1.0, pow(lightFacing, 1.0));
        // Stroke color: backdrop vibrancy carrying the rim character, brightened
        // toward white on the lit side (Fresnel specular peak).
        vec3 strokeColor = mix(edgeLightRgb, vec3(1.0), pow(lightFacing, 2.0) * 0.7);
        // Tint by user BorderColor.rgb so brand-coloured borders still read.
        strokeColor = mix(strokeColor, v_BorderColor.rgb, 0.25);

        float borderOuter = smoothstep(-0.5, 0.5, dist);
        float borderInner = smoothstep(-0.5, 0.5, dist + localBorderWidth);
        float borderBase = (1.0 - borderOuter) * borderInner;
        float borderAlpha = borderBase * v_BorderColor.a * strokeBrightness;
        result.rgb = result.rgb * (1.0 - borderAlpha) + strokeColor * borderAlpha;
        result.a = result.a * (1.0 - borderAlpha) + borderAlpha;
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
