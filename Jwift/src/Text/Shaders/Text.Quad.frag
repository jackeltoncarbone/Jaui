#version 300 es
precision highp float;

in vec2 v_TexCoord;
in float v_Opacity;
in vec2 v_PixelPos;
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

bool insideClipShape(vec2 pixel, vec4 rect, vec4 radii, float smoothness) {
    vec2 center = rect.xy + rect.zw * 0.5;
    vec2 halfSize = rect.zw * 0.5;
    vec2 qSigned = pixel - center;
    vec2 qAbs = abs(qSigned);
    if (qAbs.x > halfSize.x || qAbs.y > halfSize.y) return false;
    float r = pickClipRadius(qSigned, radii);
    vec2 cornerP = qAbs - (halfSize - vec2(r));
    if (r <= 0.0 || cornerP.x <= 0.0 || cornerP.y <= 0.0) return true;
    float n = 2.0 + 6.0 * clamp(smoothness, 0.0, 1.0);
    float L = pow(cornerP.x / r, n) + pow(cornerP.y / r, n);
    return L <= 1.0;
}

const int MAX_CLIP_DEPTH = 16;

bool insideClipStack(vec2 pixel, int offset, int count) {
    for (int i = 0; i < MAX_CLIP_DEPTH; i++) {
        if (i >= count) break;
        int base = (offset + i) * 3;
        vec4 rect = texelFetch(u_ClipTex, ivec2(base, 0), 0);
        vec4 radii = texelFetch(u_ClipTex, ivec2(base + 1, 0), 0);
        vec4 meta = texelFetch(u_ClipTex, ivec2(base + 2, 0), 0);
        if (!insideClipShape(pixel, rect, radii, meta.x)) {
            return false;
        }
    }
    return true;
}

void main() {
    if (!insideClipStack(v_PixelPos, v_ClipOffset, v_ClipCount)) {
        discard;
    }
    vec4 texel = texture(u_Atlas, v_TexCoord);
    fragColor = texel * v_Opacity;
}
