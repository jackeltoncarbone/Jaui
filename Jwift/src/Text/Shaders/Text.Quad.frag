#version 300 es
precision highp float;

in vec2 v_TexCoord;
in float v_Opacity;

uniform sampler2D u_Atlas;

out vec4 fragColor;

void main() {
    vec4 texel = texture(u_Atlas, v_TexCoord);
    fragColor = texel * v_Opacity;
}
