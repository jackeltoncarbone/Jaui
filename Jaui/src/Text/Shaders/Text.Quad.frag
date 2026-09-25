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
// A LABEL ON GLASS follows the glass's appearance, not the theme (Core/Glass.md): 95% white on dark glass,
// black on light. u_GlassInk = (the glass's probe slot, 1 in a light theme); slot -1 for every other label.
// Where the glass's appearance matches the theme the authored ink stands; where it turns, the ink turns.
uniform sampler2D u_ShadowState;
uniform vec2 u_GlassInk;
out vec4 fragColor;

#pragma ClipStack

void main() {
    float clipD = clipStackDistance(v_PixelPos, v_ClipOffset, v_ClipCount);
    if (clipD > 1.0) discard;
    float clipAlpha = 1.0 - smoothstep(-0.5, 0.5, clipD);
    vec4 texel = texture(u_Atlas, v_TexCoord);
    // Opacity scales coverage only: the blend multiplies the colour by alpha, so opacity on rgb too would
    // square it (light ink at 0.1 read as 0.01 on a dark ground while dark ink read 0.1 on a light one).
    vec4 ink = texel * v_Tint * clipAlpha;
    ink.a *= v_Opacity;
    float cover = u_VibrancyCover;
    if (u_GlassInk.x >= 0.0) {
        float light = smoothstep(0.45, 0.55, texelFetch(u_ShadowState, ivec2(int(u_GlassInk.x), 0), 0).g);
        float turn = abs(light - u_GlassInk.y);
        vec4 label = light > 0.5 ? vec4(0.0, 0.0, 0.0, 1.0) : vec4(1.0, 1.0, 1.0, 0.95);
        ink = mix(ink, vec4(label.rgb * clipAlpha, texel.a * label.a * v_Opacity * clipAlpha), turn);
        if (cover >= 0.0) cover = mix(cover, 1.0, turn);
    }
    fragColor = cover < 0.0 ? ink : vec4(ink.rgb * ink.a, ink.a * cover);
}
