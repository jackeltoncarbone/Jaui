#version 300 es
precision highp float;

layout(location = 0) in vec2 a_Position;    // unit quad [0,1]
layout(location = 1) in vec4 a_Rect;        // per-instance: screen x,y,w,h (2D) | NATURAL x,y,w,h (3D)
layout(location = 2) in vec4 a_UvRect;      // per-instance: atlas u,v,uW,uH
layout(location = 3) in vec4 a_OpacityClip; // per-instance: opacity, clipOffset, clipCount, _pad
layout(location = 4) in vec4 a_Tint;        // per-instance: RGBA multiplier (1,1,1,1 = passthrough)
layout(location = 5) in vec4 a_Rot;         // 2D: cosθ, sinθ, pivotX, pivotY — 3D: (2.0 sentinel, xformIndex, _, _)

uniform vec2 u_Resolution;
// Shared 3D-transform table (1-row RGBA32F, 3 texels per homography entry).
uniform sampler2D u_XformTex;

out vec2 v_TexCoord;
out float v_Opacity;
out vec2 v_PixelPos;
out vec4 v_Tint;
flat out int v_ClipOffset;
flat out int v_ClipCount;

void main() {
    v_TexCoord = a_UvRect.xy + a_Position * a_UvRect.zw;
    v_Opacity = a_OpacityClip.x;
    v_Tint = a_Tint;
    v_ClipOffset = int(a_OpacityClip.y);
    v_ClipCount = int(a_OpacityClip.z);

    // cos can only be in [-1, 1]; the CPU stores 2.0 to flag a projective glyph.
    if (a_Rot.x > 1.5) {
        // 3D: a_Rect is the glyph in NODE-NATURAL coords. Fetch this glyph's
        // homography from the shared table and project the corner, keeping the
        // homogeneous W on gl_Position so the atlas UV stays perspective-correct.
        int xi = int(a_Rot.y) * 3;
        vec3 h0 = texelFetch(u_XformTex, ivec2(xi + 0, 0), 0).xyz;
        vec3 h1 = texelFetch(u_XformTex, ivec2(xi + 1, 0), 0).xyz;
        vec3 h2 = texelFetch(u_XformTex, ivec2(xi + 2, 0), 0).xyz;
        vec3 p = vec3(a_Rect.xy + a_Position * a_Rect.zw, 1.0);
        float X = dot(h0, p), Y = dot(h1, p), W = dot(h2, p);
        vec2 screen = vec2(X, Y) / W;
        v_PixelPos = screen;
        vec2 clip = (screen / u_Resolution) * 2.0 - 1.0;
        clip.y = -clip.y;
        gl_Position = vec4(clip * W, 0.0, W);
        return;
    }

    vec2 pos = a_Rect.xy + a_Position * a_Rect.zw;
    // Rotate the glyph quad about its pivot by (cosθ, sinθ) so text tilts WITH a
    // rotated ancestor. (1,0) ⇒ identity. v_PixelPos stays the rotated screen
    // position so clip / AA in the fragment operate in the same space.
    vec2 rel = pos - a_Rot.zw;
    pos = vec2(rel.x * a_Rot.x - rel.y * a_Rot.y,
               rel.x * a_Rot.y + rel.y * a_Rot.x) + a_Rot.zw;
    v_PixelPos = pos;

    vec2 clip = (pos / u_Resolution) * 2.0 - 1.0;
    clip.y = -clip.y;

    gl_Position = vec4(clip, 0.0, 1.0);
}
