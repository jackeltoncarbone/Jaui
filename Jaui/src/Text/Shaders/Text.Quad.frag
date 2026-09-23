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
// THE FLIP (Jiv/Shaders/Glass.Flip.glsl): a label on flipping glass reads its surface's texel, and as the
// plate turns light its ink turns to u_InkFlipColor and covers. Slot -1 for every other label.
uniform sampler2D u_ShadowState;
uniform float u_InkFlipSlot;
uniform vec3 u_InkFlipColor;

#include "../../Jiv/Shaders/Glass.Flip.glsl"

out vec4 fragColor;

#pragma ClipStack

void main() {
    float clipD = clipStackDistance(v_PixelPos, v_ClipOffset, v_ClipCount);
    if (clipD > 1.0) discard;
    float clipAlpha = 1.0 - smoothstep(-0.5, 0.5, clipD);
    vec4 texel = texture(u_Atlas, v_TexCoord);
    vec4 ink = texel * v_Tint * v_Opacity * clipAlpha;
    float cover = u_VibrancyCover;
    if (u_InkFlipSlot >= 0.0) {
        float flip = GlassFlipFactor(texelFetch(u_ShadowState, ivec2(int(u_InkFlipSlot), 0), 0).g);
        ink.rgb = mix(ink.rgb, u_InkFlipColor * v_Opacity * clipAlpha, flip);
        if (cover >= 0.0) cover = mix(cover, 1.0, flip);
    }
    fragColor = cover < 0.0 ? ink : vec4(ink.rgb * ink.a, ink.a * cover);
}
