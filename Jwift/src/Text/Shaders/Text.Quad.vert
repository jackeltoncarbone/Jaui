#version 300 es
precision highp float;

layout(location = 0) in vec2 a_Position;    // unit quad [0,1]
layout(location = 1) in vec4 a_Rect;        // per-instance: screen x,y,w,h
layout(location = 2) in vec4 a_UvRect;      // per-instance: atlas u,v,uW,uH
layout(location = 3) in vec4 a_OpacityClip; // per-instance: opacity, clipOffset, clipCount, _pad
// location 4 is padding (reserved for vec4 alignment with the WebGPU buffer
// layout). The VAO still binds it but the shader never reads from it.

uniform vec2 u_Resolution;

out vec2 v_TexCoord;
out float v_Opacity;
out vec2 v_PixelPos;
flat out int v_ClipOffset;
flat out int v_ClipCount;

void main() {
    vec2 pos = a_Rect.xy + a_Position * a_Rect.zw;
    v_TexCoord = a_UvRect.xy + a_Position * a_UvRect.zw;
    v_Opacity = a_OpacityClip.x;
    v_PixelPos = pos;
    v_ClipOffset = int(a_OpacityClip.y);
    v_ClipCount = int(a_OpacityClip.z);

    vec2 clip = (pos / u_Resolution) * 2.0 - 1.0;
    clip.y = -clip.y;

    gl_Position = vec4(clip, 0.0, 1.0);
}
