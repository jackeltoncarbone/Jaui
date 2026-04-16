#version 300 es
precision highp float;

layout(location = 0) in vec2 a_Position;    // unit quad [0,1]
layout(location = 1) in vec4 a_Rect;        // per-instance: screen x,y,w,h
layout(location = 2) in vec4 a_UvRect;      // per-instance: atlas u,v,uW,uH
layout(location = 3) in vec4 a_OpacityPad;  // per-instance: opacity, pad, pad, pad

uniform vec2 u_Resolution;

out vec2 v_TexCoord;
out float v_Opacity;

void main() {
    vec2 pos = a_Rect.xy + a_Position * a_Rect.zw;
    v_TexCoord = a_UvRect.xy + a_Position * a_UvRect.zw;
    v_Opacity = a_OpacityPad.x;

    vec2 clip = (pos / u_Resolution) * 2.0 - 1.0;
    clip.y = -clip.y;

    gl_Position = vec4(clip, 0.0, 1.0);
}
