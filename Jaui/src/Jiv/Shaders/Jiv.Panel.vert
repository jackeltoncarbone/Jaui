#version 300 es
precision highp float;

layout(location = 0) in vec2 a_Position;   // unit quad [0,1]

// Per-instance
layout(location = 1) in vec4 a_Rect;          // AABB of the (possibly rotated) panel — or NATURAL box when 3D
layout(location = 2) in vec4 a_PanelGeom;     // cosθ, sinθ, halfW, halfH — or (2.0 sentinel, xformIndex, halfW, halfH) when 3D
layout(location = 3) in vec4 a_Radii;
layout(location = 4) in vec4 a_Tint;
layout(location = 5) in vec4 a_BorderColor;
layout(location = 6) in vec4 a_ShadowColor;
layout(location = 7) in vec4 a_ShadowParams;  // shadowOffX, shadowOffY, shadowBlur, borderWidth
layout(location = 8) in vec4 a_StyleParams;   // borderEdgeAa, smoothness, opacity, materialType
layout(location = 9) in vec4 a_Grading;       // brightness, saturation, contrast, frostLod
layout(location = 10) in vec4 a_Refraction;   // thickness, refraction band, free, refraction amount
layout(location = 11) in vec4 a_Lighting;     // lightAngle (rad), bodyTint (signed), lightIntensity, fresnelStrength
layout(location = 12) in vec4 a_Specular;     // specIntensity, specGlow, chromaticAberration, innerBlur + borderFade
layout(location = 13) in vec4 a_RimEdge;      // edgeLightTop, edgeLightBottom, rim lobe width, rim strength
layout(location = 14) in vec4 a_Outline;      // free, free, clipOffset, clipCount

uniform vec2 u_Resolution;
// Projection sub-window for retained-mode layer capture. Screen-space device
// pixels in [u_ViewOffset, u_ViewOffset + u_Resolution] map to NDC [-1,1] (the
// capture FBO viewport). (0,0) for the normal full-canvas pass → no change, so
// v_PixelPos stays true screen space and the screen-space clip stack matches
// without any coordinate remapping. Capture sets it to the subtree AABB origin.
uniform vec2 u_ViewOffset;
// Shared 3D-transform table (1-row RGBA32F, 3 texels per homography entry).
uniform sampler2D u_XformTex;
// Adaptive shadow. One row, one texel per measured surface: R is 0 over a flat light ground and 1 over text
// or busy content (Jiv.ShadowBackdrop.frag, eased across frames). u_ShadowBackdrop = (slot, adaptive);
// slot -1 means this draw was not measured and the shadow keeps its authored alpha.
uniform sampler2D u_ShadowState;
uniform vec2 u_ShadowBackdrop;

// ShadowColor's alpha is the shadow over busy content; the backdrop lowers it by up to `adaptive`.
float AdaptiveShadowAlpha(float authoredAlpha, float backdropFactor, float adaptive) {
    return authoredAlpha * mix(1.0, backdropFactor, adaptive);
}

// Adaptive glass (`?glass-adapt`). u_GlassAdapt = (slot, openFar): the surface's texel in the same state
// row (its B is the brightest local backdrop luma under the footprint) and its AdaptiveFar. Slot -1, or
// openFar 0, leaves the authored grade untouched.
uniform vec2 u_GlassAdapt;

// The authored grade is one affine ramp in luma: over black it lands at `ground`, over white at `far`,
// and `far` is where the ink sits exactly on its legibility floor (Jwift.Glass.jss, the far-end solve).
// Over a backdrop whose brightest part is `peak`, the body never gets past ground + (far - ground) * peak,
// so the ramp can OPEN until that point reaches `far` again -- and no further than openFar, Apple's own
// far end. Ground and the colour carried (c * s * (1 - t)) stay put; only the range and the tint move.
// Returns (brightness, saturation, contrast, signed tint). Past a tint of zero the body is lifted by a
// brightness above 1 instead, which is the same (1 - t) scale applyTint cannot write with a negative t.
// A ramp that does not open returns the authored numbers themselves, so nothing is re-derived.
vec4 GlassAdaptGrade(vec4 grading, float bodyTint, float peak, float openFar) {
    float t = -bodyTint;
    float contrast = grading.z;
    float ground = (1.0 - t) * (1.0 - contrast) * 0.5;
    float far = (1.0 - t) * (1.0 + contrast) * 0.5;
    float opened = min(openFar, ground + (far - ground) / max(peak, 1.0 / 1023.0));
    if (!(opened > far)) return vec4(grading.xyz, bodyTint);
    float range = opened - ground;
    float keep = ground + opened;
    float carry = contrast * grading.y * (1.0 - t);
    return vec4(max(keep, 1.0), carry / range, range / keep, -max(1.0 - keep, 0.0));
}

out vec2 v_PixelPos;
flat out vec4 v_PanelGeom;
flat out vec4 v_Rot;        // cosθ, sinθ, centerX, centerY (device px)
out vec2 v_Local;           // 3D: undeformed panel-local coord for the SDF (perspective-correct)
flat out float v_Is3D;
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

void main() {
    // Style varyings — identical for 2D and 3D.
    v_Radii = a_Radii;
    v_Tint = a_Tint;
    v_BorderColor = a_BorderColor;
    v_ShadowColor = a_ShadowColor;
    if (u_ShadowBackdrop.x >= 0.0) {
        float backdropFactor = texelFetch(u_ShadowState, ivec2(int(u_ShadowBackdrop.x), 0), 0).r;
        v_ShadowColor.a = AdaptiveShadowAlpha(a_ShadowColor.a, backdropFactor, u_ShadowBackdrop.y);
    }
    v_ShadowParams = a_ShadowParams;
    v_StyleParams = a_StyleParams;
    v_Grading = a_Grading;
    v_Refraction = a_Refraction;
    v_Lighting = a_Lighting;
    v_Specular = a_Specular;
    v_RimEdge = a_RimEdge;
    v_Outline = a_Outline;
    // Only a body tinted toward black, at brightness 1, is on the ramp GlassAdaptGrade inverts.
    if (u_GlassAdapt.x >= 0.0 && u_GlassAdapt.y > 0.0 && a_Lighting.y < 0.0 && a_Grading.x == 1.0) {
        float peak = texelFetch(u_ShadowState, ivec2(int(u_GlassAdapt.x), 0), 0).b;
        vec4 adapted = GlassAdaptGrade(a_Grading, a_Lighting.y, peak, u_GlassAdapt.y);
        v_Grading.xyz = adapted.xyz;
        v_Lighting.y = adapted.w;
    }

    // cos can only be in [-1, 1]; the CPU stores 2.0 to flag a projective panel.
    if (a_PanelGeom.x > 1.5) {
        // 3D: a_Rect is the panel's NATURAL box; fetch its homography from the
        // shared table and project the corner (keeping homogeneous W so the SDF
        // varying stays perspective-correct). The SDF runs in the UNDEFORMED
        // panel frame via v_Local; the projection only places it on screen.
        int xi = int(a_PanelGeom.y) * 3;
        vec3 h0 = texelFetch(u_XformTex, ivec2(xi + 0, 0), 0).xyz;
        vec3 h1 = texelFetch(u_XformTex, ivec2(xi + 1, 0), 0).xyz;
        vec3 h2 = texelFetch(u_XformTex, ivec2(xi + 2, 0), 0).xyz;
        vec3 p = vec3(a_Rect.xy + a_Position * a_Rect.zw, 1.0);
        float X = dot(h0, p), Y = dot(h1, p), W = dot(h2, p);
        vec2 screen = vec2(X, Y) / W;
        v_PixelPos = screen;
        vec2 halfSz = a_PanelGeom.zw;
        v_Local = (a_Position * 2.0 - 1.0) * halfSz; // [-half, +half], device px
        v_Is3D = 1.0;
        // center = 0 so the fragment's `pLocal - panelCenter` reduces to v_Local.
        v_PanelGeom = vec4(0.0, 0.0, halfSz);
        v_Rot = vec4(1.0, 0.0, 0.0, 0.0);
        vec2 clip = ((screen - u_ViewOffset) / u_Resolution) * 2.0 - 1.0;
        clip.y = -clip.y;
        gl_Position = vec4(clip * W, 0.0, W);
        return;
    }

    // 2D path — quad spans the expanded AABB; the fragment un-rotates v_PixelPos.
    vec2 pos = a_Rect.xy + a_Position * a_Rect.zw;
    v_PixelPos = pos;

    vec2 clip = ((pos - u_ViewOffset) / u_Resolution) * 2.0 - 1.0;
    clip.y = -clip.y;
    gl_Position = vec4(clip, 0.0, 1.0);

    vec2 center = a_Rect.xy + a_Rect.zw * 0.5;
    v_PanelGeom = vec4(center, a_PanelGeom.zw);
    v_Rot = vec4(a_PanelGeom.xy, center);
    v_Local = vec2(0.0);
    v_Is3D = 0.0;
}
