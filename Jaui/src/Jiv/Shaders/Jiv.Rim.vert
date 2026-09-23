#version 300 es
precision highp float;

// One vertex of the rim strip (Jiv.Outline.ts): a point on the panel's edge in device px from its
// center, the edge's outward normal, which side of the strip it is, and the edge's local radius of
// curvature, which caps how far inward the strip reaches so a tight corner never folds over itself.
layout(location = 0) in vec2 a_Point;
layout(location = 1) in vec2 a_Normal;
layout(location = 2) in float a_Side;
layout(location = 3) in float a_CurvatureRadius;

uniform vec2 u_Resolution;
uniform vec2 u_ViewOffset;
uniform sampler2D u_XformTex;
// 2D: the panel's center in device px and its rotation (cos, sin).
uniform vec4 u_Placement;
// Projective: the panel's row in the homography table (-1 for 2D) and its natural box, which that
// homography maps to the screen.
uniform float u_XformIndex;
uniform vec4 u_NaturalRect;
uniform vec2 u_HalfSize;
// How far the strip reaches past the edge (x) and into the panel (y), device px.
uniform vec2 u_Reach;

out vec2 v_PixelPos;
out float v_Distance;
out vec2 v_Normal;

void main() {
    float offset = a_Side < 0.5 ? u_Reach.x : -min(u_Reach.y, a_CurvatureRadius);
    vec2 local = a_Point + a_Normal * offset;
    v_Distance = offset;
    v_Normal = a_Normal;

    if (u_XformIndex >= 0.0) {
        int xi = int(u_XformIndex) * 3;
        vec3 h0 = texelFetch(u_XformTex, ivec2(xi + 0, 0), 0).xyz;
        vec3 h1 = texelFetch(u_XformTex, ivec2(xi + 1, 0), 0).xyz;
        vec3 h2 = texelFetch(u_XformTex, ivec2(xi + 2, 0), 0).xyz;
        vec2 natural = u_NaturalRect.xy + (local / max(u_HalfSize, vec2(1e-3)) * 0.5 + 0.5) * u_NaturalRect.zw;
        vec3 p = vec3(natural, 1.0);
        float W = dot(h2, p);
        vec2 screen = vec2(dot(h0, p), dot(h1, p)) / W;
        v_PixelPos = screen;
        vec2 clip = ((screen - u_ViewOffset) / u_Resolution) * 2.0 - 1.0;
        clip.y = -clip.y;
        gl_Position = vec4(clip * W, 0.0, W);
        return;
    }

    vec2 screen = u_Placement.xy + vec2(
        u_Placement.z * local.x - u_Placement.w * local.y,
        u_Placement.w * local.x + u_Placement.z * local.y);
    v_PixelPos = screen;
    vec2 clip = ((screen - u_ViewOffset) / u_Resolution) * 2.0 - 1.0;
    clip.y = -clip.y;
    gl_Position = vec4(clip, 0.0, 1.0);
}
