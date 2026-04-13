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

// ─── SDF ───

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

    // ─── Shadow ───
    vec2 sp = p - shadowOffset;
    float shadowDist = SuperellipseSDF(sp, panelHalfSize, v_Radii, smoothness);
    float shadowAlpha = (1.0 - smoothstep(-shadowBlur, 0.0, shadowDist)) * v_ShadowColor.a;
    vec4 shadow = vec4(v_ShadowColor.rgb, shadowAlpha);

    // ─── Panel body ───
    float dist = SuperellipseSDF(p, panelHalfSize, v_Radii, smoothness);
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

    // Border on top
    vec4 border = vec4(v_BorderColor.rgb, borderAlpha);
    result = result * (1.0 - borderAlpha) + border;

    result.a *= opacity;

    fragColor = result;
}
