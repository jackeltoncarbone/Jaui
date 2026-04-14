#version 300 es
precision highp float;

layout(location = 0) in vec2 a_Position;  // unit quad [0,1]

uniform vec2 u_Resolution;
uniform vec4 u_Rect;  // x, y, width, height (device pixels)

out vec2 v_TexCoord;

void main() {
    vec2 pos = u_Rect.xy + a_Position * u_Rect.zw;
    v_TexCoord = a_Position;  // UV = quad position

    vec2 clip = (pos / u_Resolution) * 2.0 - 1.0;
    clip.y = -clip.y;

    gl_Position = vec4(clip, 0.0, 1.0);
}
