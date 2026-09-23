#version 300 es
precision highp float;

in vec2 v_TexCoord;
in float v_Opacity;
in vec2 v_PixelPos;
in vec4 v_Tint;
flat in int v_ClipOffset;
flat in int v_ClipCount;

uniform sampler2D u_Atlas;
uniform sampler2D u_ClipTex;
// VIBRANT INK (Core/Lift.ts): 0 for ordinary text. Otherwise the ink is written premultiplied, its colour
// at its full coverage over `u_InkCover` of it, for the `ONE, ONE_MINUS_SRC_ALPHA` blend that state sets.
uniform float u_InkCover;

out vec4 fragColor;

#pragma ClipStack

void main() {
    float clipD = clipStackDistance(v_PixelPos, v_ClipOffset, v_ClipCount);
    if (clipD > 1.0) discard;
    float clipAlpha = 1.0 - smoothstep(-0.5, 0.5, clipD);
    vec4 texel = texture(u_Atlas, v_TexCoord);
    if (u_InkCover > 0.0) {
        vec4 ink = texel * v_Tint;
        float coverage = ink.a * v_Opacity * clipAlpha;
        fragColor = vec4(ink.rgb * coverage, coverage * u_InkCover);
        return;
    }
    fragColor = texel * v_Tint * v_Opacity * clipAlpha;
}
