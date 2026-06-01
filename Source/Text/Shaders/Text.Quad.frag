#version 300 es
precision highp float;

in vec2 v_TexCoord;
in float v_Opacity;
in vec2 v_PixelPos;
in vec4 v_Tint;
flat in int v_ClipOffset;
flat in int v_ClipCount;

uniform sampler2D u_Atlas;
uniform sampler2D u_ClipTex;

out vec4 fragColor;

// Shared inline because WebGL2 GLSL has no #include. Matches the panel's
// painted superellipse so the clip traces the exact same visual edge.
float pickClipRadius(vec2 p, vec4 radii) {
    if (p.x >= 0.0) {
        return p.y <= 0.0 ? radii.y : radii.z;
    }
    return p.y <= 0.0 ? radii.x : radii.w;
}

// Signed distance to the rounded-rect clip boundary. Negative inside,
// positive outside, in device pixels. Enables fwidth-free 1px AA at the
// clip edge via a fixed ±0.5px smoothstep instead of a hard discard.
float clipShapeDistance(vec2 pixel, vec4 rect, vec4 radii, float smoothness) {
    vec2 center = rect.xy + rect.zw * 0.5;
    vec2 halfSize = rect.zw * 0.5;
    vec2 qSigned = pixel - center;
    vec2 qAbs = abs(qSigned);
    float r = pickClipRadius(qSigned, radii);
    vec2 cornerP = qAbs - (halfSize - vec2(r));
    if (r <= 0.0 || cornerP.x <= 0.0 || cornerP.y <= 0.0) {
        return max(qAbs.x - halfSize.x, qAbs.y - halfSize.y);
    }
    float n = 2.0 + 6.0 * clamp(smoothness, 0.0, 1.0);
    float L = pow(cornerP.x / r, n) + pow(cornerP.y / r, n);
    return r * (pow(max(L, 0.0), 1.0 / n) - 1.0);
}

const int MAX_CLIP_DEPTH = 16;

// Intersection of a clip stack — a pixel is inside the combined clip iff
// it's inside every individual clip. Signed distance = max of per-clip SDFs.
float clipStackDistance(vec2 pixel, int offset, int count) {
    float d = -1e20;
    for (int i = 0; i < MAX_CLIP_DEPTH; i++) {
        if (i >= count) break;
        int base = (offset + i) * 3;
        vec4 rect = texelFetch(u_ClipTex, ivec2(base, 0), 0);
        vec4 radii = texelFetch(u_ClipTex, ivec2(base + 1, 0), 0);
        vec4 meta = texelFetch(u_ClipTex, ivec2(base + 2, 0), 0);
        d = max(d, clipShapeDistance(pixel, rect, radii, meta.x));
    }
    return d;
}

void main() {
    float clipD = clipStackDistance(v_PixelPos, v_ClipOffset, v_ClipCount);
    if (clipD > 1.0) discard;
    float clipAlpha = 1.0 - smoothstep(-0.5, 0.5, clipD);
    vec4 texel = texture(u_Atlas, v_TexCoord);
    fragColor = texel * v_Tint * v_Opacity * clipAlpha;
}
