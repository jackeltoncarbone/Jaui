#version 300 es
precision highp float;

in vec2 v_TexCoord;

uniform sampler2D u_Texture;
uniform float u_Opacity;

out vec4 fragColor;

void main() {
    vec4 texel = texture(u_Texture, v_TexCoord);
    fragColor = texel * u_Opacity;
}
