#version 300 es
precision highp float;

in vec2 v_PixelPos;

// Panel geometry
uniform vec2 u_PanelCenter;    // center of the panel in pixels
uniform vec2 u_PanelHalfSize;  // half-width, half-height
uniform vec4 u_Radii;          // corner radii: (tl, tr, br, bl)
uniform float u_Smoothness;    // superellipse smoothness (0-1)

// Fill
uniform vec4 u_Background;

// Border
uniform vec4 u_BorderColor;
uniform float u_BorderWidth;
uniform float u_BorderBlur;

// Shadow
uniform vec4 u_ShadowColor;
uniform float u_ShadowBlur;
uniform vec2 u_ShadowOffset;

// Appearance
uniform float u_Opacity;

out vec4 fragColor;

// ─── SDF (inlined at compile time by vite-plugin-glsl) ───

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
    vec2 p = v_PixelPos - u_PanelCenter;

    // ─── Shadow ───
    vec2 sp = p - u_ShadowOffset;
    float shadowDist = SuperellipseSDF(sp, u_PanelHalfSize, u_Radii, u_Smoothness);
    float shadowAlpha = (1.0 - smoothstep(-u_ShadowBlur, 0.0, shadowDist)) * u_ShadowColor.a;
    vec4 shadow = vec4(u_ShadowColor.rgb, shadowAlpha);

    // ─── Panel body ───
    float dist = SuperellipseSDF(p, u_PanelHalfSize, u_Radii, u_Smoothness);
    float fillAlpha = 1.0 - smoothstep(-0.5, 0.5, dist);  // antialiased edge

    // ─── Border ───
    float borderOuter = smoothstep(-0.5, 0.5, dist);
    float borderInner = smoothstep(-0.5, 0.5, dist + u_BorderWidth);
    float borderBase = (1.0 - borderOuter) * borderInner;

    // Apply border blur (soft glow effect)
    float borderGlow = 0.0;
    if (u_BorderBlur > 0.0) {
        borderGlow = (1.0 - smoothstep(-u_BorderBlur, 0.0, dist)) *
                     smoothstep(-u_BorderBlur - u_BorderWidth, -u_BorderWidth, dist);
    }
    float borderAlpha = max(borderBase, borderGlow) * u_BorderColor.a;

    // ─── Composite ───
    // Shadow behind everything
    vec4 result = shadow;

    // Fill over shadow (only where shadow is visible but fill is not)
    vec4 fill = vec4(u_Background.rgb, u_Background.a * fillAlpha);
    result = mix(result, fill, fillAlpha);

    // Border on top
    vec4 border = vec4(u_BorderColor.rgb, borderAlpha);
    result = result * (1.0 - borderAlpha) + border;

    result.a *= u_Opacity;

    fragColor = result;
}
