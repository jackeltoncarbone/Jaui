#version 300 es
precision highp float;

in vec2 v_PixelPos;

// Per-instance data from vertex shader (flat = no interpolation)
flat in vec4 v_PanelGeom;     // centerX, centerY, halfW, halfH
flat in vec4 v_Radii;         // tl, tr, br, bl
flat in vec4 v_Background;    // RGBA
flat in vec4 v_BorderColor;   // RGBA
flat in vec4 v_ShadowColor;   // RGBA
flat in vec4 v_ShadowParams;  // shadowOffX, shadowOffY, shadowBlur, borderWidth
flat in vec4 v_StyleParams;   // borderBlur, smoothness, opacity, _pad

out vec4 fragColor;

// ─── SDF (rect / pill / circle via auto-mode) ───

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

// Auto-derived smoothness (matches Show Studio's GetMode):
//   Circle: 0.01      — near-perfect circle
//   Pill:   0.25      — Apple squircle-pill (p = 2.75)
//   Rect:   0.45..0.65 with pill-easing toward 0.04 as radius approaches maxR
float AutoSmoothness(vec2 halfSize, vec4 radii) {
    float minHalf = min(halfSize.x, halfSize.y);
    float maxHalf = max(halfSize.x, halfSize.y);
    float aspect = maxHalf / max(minHalf, 0.0001);
    float minRadius = min(min(radii.x, radii.y), min(radii.z, radii.w));

    if (aspect < 1.43 && minRadius >= minHalf * 0.9) return 0.01;
    if (aspect >= 1.3 && minRadius >= minHalf - 1.0) return 0.25;

    float base;
    if (minHalf <= minRadius) base = 0.65;
    else if (minHalf >= minRadius * 1.5) base = 0.45;
    else base = mix(0.65, 0.45, (minHalf - minRadius) / (minRadius * 0.5));

    float maxR = minHalf;
    float pillThreshold = maxR * 0.7;
    if (minRadius > pillThreshold) {
        float f = clamp((minRadius - pillThreshold) / (maxR - pillThreshold), 0.0, 1.0);
        float e = f * f * (3.0 - 2.0 * f);
        base = base * (1.0 - e * 0.96) + 0.04 * e;
    }
    return base;
}

// All shapes are superellipses with per-shape auto-smoothness (matches SS visuals).
float ShapeSDF(vec2 p, vec2 halfSize, vec4 radii, float smoothness) {
    return SuperellipseSDF(p, halfSize, radii, smoothness);
}

void main() {
    // Unpack instance data
    vec2 panelCenter = v_PanelGeom.xy;
    vec2 panelHalfSize = v_PanelGeom.zw;
    vec2 shadowOffset = v_ShadowParams.xy;
    float shadowBlur = v_ShadowParams.z;
    float borderWidth = v_ShadowParams.w;
    float borderBlur = v_StyleParams.x;
    float smoothness = v_StyleParams.y;
    float opacity = v_StyleParams.z;

    vec2 p = v_PixelPos - panelCenter;

    // Use auto-derived smoothness so rect / pill / circle all get SS's profiles.
    float effectiveSmooth = AutoSmoothness(panelHalfSize, v_Radii);

    // ─── Shadow ───
    vec2 sp = p - shadowOffset;
    float shadowDist = ShapeSDF(sp, panelHalfSize, v_Radii, effectiveSmooth);
    float shadowAlpha = (1.0 - smoothstep(-shadowBlur, 0.0, shadowDist)) * v_ShadowColor.a;
    vec4 shadow = vec4(v_ShadowColor.rgb, shadowAlpha);

    // ─── Panel body ───
    float dist = ShapeSDF(p, panelHalfSize, v_Radii, effectiveSmooth);
    float fillAlpha = 1.0 - smoothstep(-0.5, 0.5, dist);  // antialiased edge

    // ─── Border ───
    float borderOuter = smoothstep(-0.5, 0.5, dist);
    float borderInner = smoothstep(-0.5, 0.5, dist + borderWidth);
    float borderBase = (1.0 - borderOuter) * borderInner;

    // Apply border blur (soft glow effect)
    float borderGlow = 0.0;
    if (borderBlur > 0.0) {
        borderGlow = (1.0 - smoothstep(-borderBlur, 0.0, dist)) *
                     smoothstep(-borderBlur - borderWidth, -borderWidth, dist);
    }
    float borderAlpha = max(borderBase, borderGlow) * v_BorderColor.a;

    // ─── Composite ───
    // Shadow behind everything
    vec4 result = shadow;

    // Fill over shadow
    vec4 fill = vec4(v_Background.rgb, v_Background.a * fillAlpha);
    result = mix(result, fill, fillAlpha);

    // Border on top (premultiplied-over composite — rgb scaled by borderAlpha)
    result.rgb = result.rgb * (1.0 - borderAlpha) + v_BorderColor.rgb * borderAlpha;
    result.a = result.a * (1.0 - borderAlpha) + borderAlpha;

    result.a *= opacity;

    fragColor = result;
}
