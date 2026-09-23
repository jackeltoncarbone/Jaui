// The clip stack as a signed distance, for the programs that draw inside a panel's clip without being
// a panel: text and the progressive blur. Spliced in where a program writes
// `#pragma ClipStack` (WebGL2.Renderer `_withClipStack`), after it declares `uniform sampler2D u_ClipTex`.

#include "../../Jiv/Shaders/Corner.Continuous.glsl"

// Negative inside, positive outside, device px, so the edge takes the same half-pixel feather the
// panel's silhouette does: the same continuous corner the panel draws its clip with.
float clipShapeDistance(vec2 pixel, vec4 rect, vec4 radii, float smoothness) {
    vec2 unused;
    return ContinuousCorner(pixel - (rect.xy + rect.zw * 0.5), rect.zw * 0.5, radii, smoothness, unused);
}

const int MAX_CLIP_DEPTH = 16;

// Inside the stack iff inside every clip: the max of the per-clip distances. Each clip's meta is
// (smoothness, cos, sin, _) and the sample is un-rotated about the clip's center first.
float clipStackDistance(vec2 pixel, int offset, int count) {
    float d = -1e20;
    for (int i = 0; i < MAX_CLIP_DEPTH; i++) {
        if (i >= count) break;
        int base = (offset + i) * 3;
        vec4 rect = texelFetch(u_ClipTex, ivec2(base, 0), 0);
        vec4 radii = texelFetch(u_ClipTex, ivec2(base + 1, 0), 0);
        vec4 meta = texelFetch(u_ClipTex, ivec2(base + 2, 0), 0);
        vec2 cc = rect.xy + rect.zw * 0.5;
        vec2 rel = pixel - cc;
        vec2 local = vec2(rel.x * meta.y + rel.y * meta.z,
                          -rel.x * meta.z + rel.y * meta.y) + cc;
        d = max(d, clipShapeDistance(local, rect, radii, meta.x));
    }
    return d;
}
