#version 300 es
precision highp float;

layout(location = 0) in vec2 a_Position;  // unit quad [0,1]

uniform vec2 u_Resolution;     // canvas size in pixels
uniform vec4 u_Rect;           // panel rect: (x, y, width, height) in pixels

out vec2 v_PixelPos;           // pixel position in canvas space

void main() {
    // Scale unit quad to panel rect
    vec2 pos = u_Rect.xy + a_Position * u_Rect.zw;
    v_PixelPos = pos;

    // Convert pixel position to clip space [-1, 1]
    vec2 clip = (pos / u_Resolution) * 2.0 - 1.0;
    clip.y = -clip.y;  // flip Y (canvas 0,0 is top-left)

    gl_Position = vec4(clip, 0.0, 1.0);
}
