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

// ────────── Unified shape SDF / gradient ──────────
// All three modes (rect/pill/circle) use superellipse. Smoothness picks the
// curvature profile: ~0.6 squircle, 0.25 Apple pill, 0.01 near-perfect circle.
float ShapeSDF(vec2 p, vec2 halfSize, vec4 radii, float smoothness, int mode) {
    return SuperellipseSDF(p, halfSize, radii, smoothness);
}

vec2 ShapeGrad(vec2 p, vec2 halfSize, vec4 radii, float smoothness, int mode) {
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

        vec2 baseUv = (v_PixelPos + refractOffset) / u_Resolution;
        vec2 uvR = (v_PixelPos + refractOffset + caStep) / u_Resolution;
        vec2 uvB = (v_PixelPos + refractOffset - caStep) / u_Resolution;

        vec3 sR = textureLod(u_Backdrop, uvR, bandLod).rgb;
        vec3 sG = textureLod(u_Backdrop, baseUv, bandLod).rgb;
        vec3 sB = textureLod(u_Backdrop, uvB, bandLod).rgb;
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

    // ── Fresnel rim (stronger at grazing angle = smaller edgeDist) ──
    float cosTheta = smoothstep(0.0, bezelWidth, edgeDist);    // 0 at edge → 1 inside
    float fresnel = 0.04 + 0.96 * pow(1.0 - cosTheta, 5.0);
    fresnel *= fresnelStrength;

    // ── Specular catchlight (Blinn-Phong on fake bevel 3D normal) ──
    // Bevel normal: xy comes from SDF gradient scaled by (1 - hump) so it tilts,
    // z comes from hump so the bevel curls "up" near the edge.
    vec3 N3 = normalize(vec3(normal * (1.0 - hump * 0.8), max(hump * 1.3, 0.05)));
    vec3 L3 = normalize(vec3(lightDir, 0.55));
    vec3 V3 = vec3(0.0, 0.0, 1.0);
    vec3 H3 = normalize(L3 + V3);
    float NdotH = max(dot(N3, H3), 0.0);
    float NdotL = max(dot(N3, L3), 0.0);
    float specHard = pow(NdotH, specSharpness);
    float specSoft = pow(NdotH, max(specSharpness * 0.15, 4.0)) * 0.35;
    float catchlight = (specHard + specSoft) * hump * fresnel * specIntensity * lightIntensity;
    vec3 specColor = vec3(1.0, 0.98, 0.92) * catchlight;

    // ── Hemispherical rim ambient (top vs bottom, aligned to light dir) ──
    // Dot with light direction: +1 on lit side, -1 on unlit.
    float upness = 0.5 + 0.5 * dot(normal, lightDir);
    float rimAmbient = mix(edgeLightBottom, edgeLightTop, upness);
    float rimBand = 1.0 - smoothstep(0.0, bezelWidth * 1.5, edgeDist);
    vec3 rimAmb = vec3(rimAmbient * rimBand * lightIntensity);

    // ── Variable border width along perimeter ──
    float theta = atan(-normal.y, normal.x);            // screen angle
    float phi = atan(-lightDir.y, lightDir.x);          // light angle
    float widthScale = 1.0 + borderVariance * sin(theta - phi);
    float localBorderWidth = borderWidth * widthScale;
    float localBorderBlur = borderBlur * widthScale;

    // ── Border composite (thin ink stroke + optional soft glow) ──
    float borderOuter = smoothstep(-0.5, 0.5, dist);
    float borderInner = smoothstep(-0.5, 0.5, dist + localBorderWidth);
    float borderBase = (1.0 - borderOuter) * borderInner;
    float borderGlow = 0.0;
    if (localBorderBlur > 0.0) {
        borderGlow = (1.0 - smoothstep(-localBorderBlur, 0.0, dist))
                    * smoothstep(-localBorderBlur - localBorderWidth, -localBorderWidth, dist);
    }
    float borderAlpha = max(borderBase, borderGlow) * v_BorderColor.a;

    // ── Shadow ──
    vec2 sp = p - shadowOffset;
    float shadowDist = ShapeSDF(sp, panelHalfSize, v_Radii, effectiveSmooth, mode);
    float shadowAlpha = (1.0 - smoothstep(-shadowBlur, 0.0, shadowDist)) * v_ShadowColor.a;

    // ── Fill color mix (backdrop or tinted panel for SolidGlass) ──
    vec3 fillRgb;
    float fillA;
    if (materialType == 1.0) {
        // LiquidGlass: backdrop is the base, Fresnel lightens the rim slightly
        fillRgb = backdrop + fresnel * 0.08;
        fillRgb += rimAmb + specColor;
        fillA = fillAlpha;
    } else if (materialType == 2.0) {
        // SolidGlass: tint over a clean background (no refraction)
        fillRgb = v_Tint.rgb + rimAmb + specColor * 0.3;
        fillA = fillAlpha * v_Tint.a;
    } else {
        fillRgb = v_Tint.rgb;
        fillA = fillAlpha * v_Tint.a;
    }

    // ── Composite: shadow → fill → border (premultiplied-over) ──
    vec4 shadow = vec4(v_ShadowColor.rgb, shadowAlpha);
    vec4 fill = vec4(fillRgb, fillA);
    vec4 result = shadow;
    result = mix(result, fill, fillA);
    result.rgb = result.rgb * (1.0 - borderAlpha) + v_BorderColor.rgb * borderAlpha;
    result.a = result.a * (1.0 - borderAlpha) + borderAlpha;
    result.a *= opacity;

    fragColor = result;
}
