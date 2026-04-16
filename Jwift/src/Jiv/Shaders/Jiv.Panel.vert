#version 300 es
precision highp float;

layout(location = 0) in vec2 a_Position;   // unit quad [0,1]

// Per-instance
layout(location = 1) in vec4 a_Rect;
layout(location = 2) in vec4 a_PanelGeom;     // cx, cy, halfW, halfH (device px)
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
layout(location = 14) in vec4 a_Outline;      // borderAlphaVariance, borderFresnelBrightness, _pad, _pad
layout(location = 15) in vec4 a_BorderFilter; // brightnessMul, saturationMul, contrastMul, lodOffset

uniform vec2 u_Resolution;

out vec2 v_PixelPos;
flat out vec4 v_PanelGeom;
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
    vec2 pos = a_Rect.xy + a_Position * a_Rect.zw;
    v_PixelPos = pos;

    vec2 clip = (pos / u_Resolution) * 2.0 - 1.0;
    clip.y = -clip.y;
    gl_Position = vec4(clip, 0.0, 1.0);

    v_PanelGeom = a_PanelGeom;
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
