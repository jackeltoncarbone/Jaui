#version 300 es
precision highp float;

layout(location = 0) in vec2 a_Position;    // unit quad [0,1]
layout(location = 1) in vec4 a_Rect;        // per-instance: screen x,y,w,h
layout(location = 2) in vec4 a_UvRect;      // per-instance: atlas u,v,uW,uH
layout(location = 3) in vec4 a_OpacityClip; // per-instance: opacity, clipOffset, clipCount, _pad
layout(location = 4) in vec4 a_Tint;        // per-instance: RGBA multiplier (1,1,1,1 = passthrough)
layout(location = 5) in vec4 a_Rot;         // per-instance: cosθ, sinθ, pivotX, pivotY (device px)
layout(location = 6) in vec4 a_H0;          // 3D: device homography row 0 (m00,m01,m02,_)
layout(location = 7) in vec4 a_H1;          //     row 1 (m10,m11,m12,_)
layout(location = 8) in vec4 a_H2;          //     row 2 (m20,m21,m22,_); m22==0 ⇒ 2D glyph

uniform vec2 u_Resolution;

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

    if (a_H2.z != 0.0) {
        // 3D: a_Rect is the glyph in NODE-NATURAL coords. Project the corner
        // through the homography and keep the homogeneous W on gl_Position so
        // the atlas UV interpolates perspective-correctly across the tilt.
        vec2 nat = a_Rect.xy + a_Position * a_Rect.zw;
        vec3 h = vec3(nat, 1.0);
        float X = dot(a_H0.xyz, h);
        float Y = dot(a_H1.xyz, h);
        float W = dot(a_H2.xyz, h);
        vec2 screen = vec2(X, Y) / W;
        v_PixelPos = screen;
        vec2 clip = (screen / u_Resolution) * 2.0 - 1.0;
        clip.y = -clip.y;
        gl_Position = vec4(clip * W, 0.0, W);
        return;
    }

    vec2 pos = a_Rect.xy + a_Position * a_Rect.zw;
    // Rotate the glyph quad about its pivot by (cosθ, sinθ) so text tilts WITH a
    // rotated ancestor instead of staying axis-aligned. (1,0) ⇒ identity (no cost
    // for unrotated text). v_PixelPos stays the rotated screen position so clip /
    // AA in the fragment operate in the same space.
    vec2 rel = pos - a_Rot.zw;
    pos = vec2(rel.x * a_Rot.x - rel.y * a_Rot.y,
               rel.x * a_Rot.y + rel.y * a_Rot.x) + a_Rot.zw;
    v_PixelPos = pos;

    vec2 clip = (pos / u_Resolution) * 2.0 - 1.0;
    clip.y = -clip.y;

    gl_Position = vec4(clip, 0.0, 1.0);
}
