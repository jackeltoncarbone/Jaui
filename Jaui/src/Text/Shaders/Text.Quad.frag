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
// VIBRANCY (Core/Vibrancy.ts): -1 for ordinary text; otherwise the ink is written premultiplied, over
// `u_VibrancyCover` of its coverage, for the blend `SetVibrancyBlend` sets.
uniform float u_VibrancyCover;

out vec4 fragColor;

#pragma ClipStack

void main() {
    float clipD = clipStackDistance(v_PixelPos, v_ClipOffset, v_ClipCount);
    if (clipD > 1.0) discard;
    float clipAlpha = 1.0 - smoothstep(-0.5, 0.5, clipD);
    vec4 texel = texture(u_Atlas, v_TexCoord);
    vec4 ink = texel * v_Tint * v_Opacity * clipAlpha;
    fragColor = u_VibrancyCover < 0.0 ? ink : vec4(ink.rgb * ink.a, ink.a * u_VibrancyCover);
}
