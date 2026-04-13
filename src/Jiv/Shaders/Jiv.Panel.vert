#version 300 es
precision highp float;

// Per-vertex (the unit quad)
layout(location = 0) in vec2 a_Position;

// Per-instance (divisor = 1)
layout(location = 1) in vec4 a_Rect;          // expanded draw rect: x, y, w, h
layout(location = 2) in vec4 a_PanelGeom;     // centerX, centerY, halfW, halfH
layout(location = 3) in vec4 a_Radii;         // tl, tr, br, bl
layout(location = 4) in vec4 a_Background;    // RGBA
layout(location = 5) in vec4 a_BorderColor;   // RGBA
layout(location = 6) in vec4 a_ShadowColor;   // RGBA
layout(location = 7) in vec4 a_ShadowParams;  // offsetX, offsetY, blur, borderWidth
layout(location = 8) in vec4 a_StyleParams;   // borderBlur, smoothness, opacity, _pad

// Frame-level uniform (same for all instances)
uniform vec2 u_Resolution;

// Varyings to fragment shader
out vec2 v_PixelPos;
flat out vec4 v_PanelGeom;
flat out vec4 v_Radii;
flat out vec4 v_Background;
flat out vec4 v_BorderColor;
flat out vec4 v_ShadowColor;
flat out vec4 v_ShadowParams;
flat out vec4 v_StyleParams;

void main() {
    // Scale unit quad to this instance's expanded rect
    vec2 pos = a_Rect.xy + a_Position * a_Rect.zw;
    v_PixelPos = pos;

    // Convert pixel position to clip space [-1, 1]
    vec2 clip = (pos / u_Resolution) * 2.0 - 1.0;
    clip.y = -clip.y;  // flip Y (canvas 0,0 is top-left)

    gl_Position = vec4(clip, 0.0, 1.0);

    // Pass instance data through to fragment shader
    v_PanelGeom   = a_PanelGeom;
    v_Radii       = a_Radii;
    v_Background  = a_Background;
    v_BorderColor = a_BorderColor;
    v_ShadowColor = a_ShadowColor;
    v_ShadowParams = a_ShadowParams;
    v_StyleParams = a_StyleParams;
}
