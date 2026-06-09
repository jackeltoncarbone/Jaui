#version 300 es
precision highp float;

layout(location = 0) in vec2 a_Position;   // unit quad [0,1]

// Per-instance
layout(location = 1) in vec4 a_Rect;          // AABB of the (possibly rotated) panel
layout(location = 2) in vec4 a_PanelGeom;     // cosθ, sinθ, halfW, halfH (device px)
                                              // center is recomputed from a_Rect below
layout(location = 3) in vec4 a_Radii;
layout(location = 4) in vec4 a_Tint;
layout(location = 5) in vec4 a_BorderColor;
layout(location = 6) in vec4 a_ShadowColor;
layout(location = 7) in vec4 a_ShadowParams;  // shadowOffX, shadowOffY, shadowBlur, borderWidth
layout(location = 8) in vec4 a_StyleParams;   // borderEdgeAa, smoothness, opacity, materialType
layout(location = 9) in vec4 a_Grading;       // brightness, saturation, contrast, frostLod
layout(location = 10) in vec4 a_Refraction;   // thickness, bezelWidth, refractionStrength, bezelScale
layout(location = 11) in vec4 a_Lighting;     // lightDirX, lightDirY, lightIntensity, fresnelStrength
layout(location = 12) in vec4 a_Specular;     // specIntensity, specSharpness, chromaticAberration, innerBlur
layout(location = 13) in vec4 a_RimEdge;      // edgeLightTop, edgeLightBottom, borderVariance, bulge
layout(location = 14) in vec4 a_Outline;      // borderAlphaVariance, borderFresnelBrightness, clipOffset, clipCount
layout(location = 15) in vec4 a_BorderFilter; // brightnessMul, saturationMul, contrastMul, lodOffset
// a_Outline.zw carries (clipOffset, clipCount) — packed to stay within the
// 16-slot WebGL2 vertex attribute limit.

uniform vec2 u_Resolution;

out vec2 v_PixelPos;
flat out vec4 v_PanelGeom;
flat out vec4 v_Rot;        // cosθ, sinθ, centerX, centerY (device px)
flat out vec4 v_Radii;
flat out vec4 v_Tint;
flat out vec4 v_BorderColor;
flat out vec4 v_ShadowColor;
flat out vec4 v_ShadowParams;
flat out vec4 v_StyleParams;
flat out vec4 v_Grading;
flat out vec4 v_Refraction;
flat out vec4 v_Lighting;
flat out vec4 v_Specular;
flat out vec4 v_RimEdge;
flat out vec4 v_Outline;
flat out vec4 v_BorderFilter;

void main() {
    // The quad spans the expanded AABB. v_PixelPos is the screen pixel; the
    // fragment un-rotates it about the panel center into local (unrotated)
    // space before its SDF. The center is the AABB center (identical to the
    // legacy stored center — margins are symmetric).
    vec2 pos = a_Rect.xy + a_Position * a_Rect.zw;
    v_PixelPos = pos;

    vec2 clip = (pos / u_Resolution) * 2.0 - 1.0;
    clip.y = -clip.y;
    gl_Position = vec4(clip, 0.0, 1.0);

    vec2 center = a_Rect.xy + a_Rect.zw * 0.5;
    // Reconstruct the legacy v_PanelGeom (cx, cy, halfW, halfH) the frag's SDF
    // expects, and hand the frag the rotation basis + pivot for un-rotation.
    v_PanelGeom = vec4(center, a_PanelGeom.zw);
    v_Rot = vec4(a_PanelGeom.xy, center);
    v_Radii = a_Radii;
    v_Tint = a_Tint;
    v_BorderColor = a_BorderColor;
    v_ShadowColor = a_ShadowColor;
    v_ShadowParams = a_ShadowParams;
    v_StyleParams = a_StyleParams;
    v_Grading = a_Grading;
    v_Refraction = a_Refraction;
    v_Lighting = a_Lighting;
    v_Specular = a_Specular;
    v_RimEdge = a_RimEdge;
    v_Outline = a_Outline;
    v_BorderFilter = a_BorderFilter;
}
