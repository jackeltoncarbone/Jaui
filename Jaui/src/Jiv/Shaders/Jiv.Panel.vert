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
layout(location = 10) in vec4 a_Refraction;   // thickness, glass span (pt), glass shadow mode, refraction
layout(location = 11) in vec4 a_Lighting;     // device px per pt, bodyTint (signed), dark scheme, clear glass
layout(location = 12) in vec4 a_Specular;     // rim amount, rim height (pt), chromaticAberration, borderFade
layout(location = 13) in vec4 a_RimEdge;      // free, free, lens (0 none, 1 pressed), lens ink (packed rgb + 1)
layout(location = 14) in vec4 a_Outline;      // dispersion amount + angle, height + inset (packed), clipOffset, clipCount

uniform vec2 u_Resolution;
// Projection sub-window for retained-mode layer capture. Screen-space device
// pixels in [u_ViewOffset, u_ViewOffset + u_Resolution] map to NDC [-1,1] (the
// capture FBO viewport). (0,0) for the normal full-canvas pass → no change, so
// v_PixelPos stays true screen space and the screen-space clip stack matches
// without any coordinate remapping. Capture sets it to the subtree AABB origin.
uniform vec2 u_ViewOffset;
// Shared 3D-transform table (1-row RGBA32F, 3 texels per homography entry).
uniform sampler2D u_XformTex;
// The probe state row: one texel per probed glass surface, its G the eased mean luma of the backdrop under it
// (Jiv.ShadowBackdrop.frag).
uniform sampler2D u_ShadowState;
// THE GLASS'S APPEARANCE (Core/Glass.md): this draw's texel in that row, or -1 for none. Apple's glass 56 pt and
// under tracks its backdrop: light over bright content, dark over dim, whatever the theme, the band keeping a
// mean at the threshold from flickering. Larger glass takes the theme's.
uniform float u_GlassAppearance;


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
    v_ShadowParams = a_ShadowParams;
    v_StyleParams = a_StyleParams;
    v_Grading = a_Grading;
    v_Refraction = a_Refraction;
    v_Lighting = a_Lighting;
    v_Specular = a_Specular;
    v_Outline = a_Outline;
    // Unprobed or larger glass takes the theme's appearance, at a mean that puts thin glass on the table's face.
    v_RimEdge = a_Lighting.z > 0.5 ? vec4(0.0, 0.45, a_RimEdge.zw) : vec4(1.0, 0.5, a_RimEdge.zw);
    if (u_GlassAppearance >= 0.0 && a_Refraction.y <= 56.0) {
        float mean = texelFetch(u_ShadowState, ivec2(int(u_GlassAppearance), 0), 0).g;
        v_RimEdge.xy = vec2(smoothstep(0.45, 0.55, mean), mean);
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
