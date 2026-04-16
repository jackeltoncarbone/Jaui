/**
 * ProgressiveBlur shader — draws a quad over the composited scene and
 * outputs a per-pixel continuously-variable Gaussian blur by sampling a
 * single mipmapped blur pyramid at a ramp-driven LOD. The pyramid is the
 * same one built for glass panels (Dual Filter → generateMipmap), so the
 * progressive-blur pass has zero extra blur work — just one textureLod
 * per fragment.
 *
 * Ramp mapping:
 *   ramp = 0.0 → unblurred scene (clear end, dest shows through)
 *   ramp → 0+  → crossfade into pyramid LOD 0 (base Gaussian σ ≈ 2 px)
 *   ramp = 1.0 → pyramid at u_MaxLod (heaviest available blur)
 *
 * Direction semantics — "ToX" = blurred AT X, clear at the opposite edge.
 */

export const PROGRESSIVE_BLUR_VERT = `#version 300 es
precision highp float;

layout(location = 0) in vec2 a_Position;    // unit quad 0..1

uniform vec2 u_Resolution;                  // canvas w/h, device px
uniform vec4 u_Rect;                        // x, y, w, h in device px (y = top)

out vec2 v_Local;                           // 0..1 across the Jiv; y=0 is top
out vec2 v_SampleUv;                        // UV into the blur pyramid / scene

void main() {
    v_Local = a_Position;

    // Jiv's pixel-space corner. y is top-anchored in our convention.
    vec2 pixel = u_Rect.xy + a_Position * u_Rect.zw;

    // Sample UV into the sceneFbo-derived textures. sceneFbo was written by
    // shaders that flip clip.y, so its top-of-scene sits at high UV.y. We
    // convert a top-anchored pixel.y to a bottom-anchored UV by flipping.
    v_SampleUv = vec2(pixel.x / u_Resolution.x, 1.0 - pixel.y / u_Resolution.y);

    // Clip space — flip Y to stay consistent with the rest of the pipeline
    // (the sceneFbo pass uses clip.y = -clip.y, and we composite on top of
    // that same convention).
    vec2 clip = (pixel / u_Resolution) * 2.0 - 1.0;
    clip.y = -clip.y;
    gl_Position = vec4(clip, 0.0, 1.0);
}
`;

export const PROGRESSIVE_BLUR_FRAG = `#version 300 es
precision highp float;

in vec2 v_Local;
in vec2 v_SampleUv;

uniform sampler2D u_Scene;                  // unblurred scene (level -1)
uniform sampler2D u_Pyramid;                // mipmapped blur pyramid (LOD 0 = base blur, higher = more)
uniform float u_MaxLod;                     // max mipmap LOD to sample (maps to ramp = 1.0)
uniform int u_Direction;                    // 0 ToTop, 1 ToBottom, 2 ToLeft, 3 ToRight
uniform float u_Opacity;
uniform vec4 u_Background;                  // tint mixed IN along the ramp (fades clear → authored alpha)
uniform vec3 u_Grading;                     // (Brightness, Saturation, Contrast) — all 1 = identity

out vec4 fragColor;

void main() {
    // t = 0 at the clear end → 1 at the blurred end
    float t;
    if (u_Direction == 0)       t = 1.0 - v_Local.y;    // ToTop
    else if (u_Direction == 1)  t = v_Local.y;          // ToBottom
    else if (u_Direction == 2)  t = 1.0 - v_Local.x;    // ToLeft
    else                        t = v_Local.x;          // ToRight

    // Smoothstep the ramp — linear feels like a hard diagonal line over
    // uniform content; smoothstep is what the eye reads as "feathered".
    float ramp = smoothstep(0.0, 1.0, t);

    // Sample the unblurred scene and a mipmap LOD from the blur pyramid.
    // At ramp = 0 show pure scene; quickly crossfade into the pyramid so
    // LOD 0 (already lightly blurred) kicks in almost immediately. At
    // ramp = 1 we sample at u_MaxLod — the heaviest available blur.
    //
    // CRITICAL: all blending lives in the RGB channel. If we leaned on the
    // alpha channel for the ramp, dest (the unblurred scene that Pass 3
    // just blitted) would bleed through at every intermediate t, producing
    // a visible double-exposure — the blurred plate masked over the raw
    // plate. By fully opaque-writing a pre-blended RGB, the output at t=0
    // equals the raw scene sample (matching what dest already holds) and
    // smoothly ramps to max blur at t=1. Zero haze, truly progressive.
    vec3 sceneRgb = texture(u_Scene, v_SampleUv).rgb;
    // Quadratic LOD curve — each mipmap LOD doubles sigma, so a linear LOD
    // ramp looks exponential to the eye. Squaring makes the perceived blur
    // increase feel linear (gentle near clear end, steeper near blurred end).
    float lod = ramp * ramp * u_MaxLod;
    vec3 blurRgb = textureLod(u_Pyramid, v_SampleUv, lod).rgb;
    // Gradual crossfade from the unblurred scene into the pyramid over the
    // first 20% of the gradient. Beyond 20%, fully in the pyramid.
    float blendT = smoothstep(0.0, 0.2, ramp);
    vec3 rgb = mix(sceneRgb, blurRgb, blendT);

    // Backdrop grading — each factor ramps from 1 (identity, clear end) to
    // its authored value (blurred end). Doing this per-pixel keeps the
    // transition smooth and matches how the blur itself ramps.
    float brightness = mix(1.0, u_Grading.x, ramp);
    float saturation = mix(1.0, u_Grading.y, ramp);
    float contrast   = mix(1.0, u_Grading.z, ramp);
    rgb *= brightness;
    float luma = dot(rgb, vec3(0.299, 0.587, 0.114));
    rgb = mix(vec3(luma), rgb, saturation);
    rgb = (rgb - 0.5) * contrast + 0.5;

    // Background tint — mixed in with alpha = authored alpha × ramp so the
    // clear end shows none of the background and the blurred end shows the
    // authored amount. Lets authors e.g. darken scroll content as it feathers
    // into the TabBar without touching the clear top edge.
    float bgMix = u_Background.a * ramp;
    rgb = mix(rgb, u_Background.rgb, bgMix);

    // Alpha = u_Opacity (Jiv-level fade only). No ramp in alpha — the ramp
    // is already baked into rgb via the stage interpolation + grading above.
    fragColor = vec4(rgb, u_Opacity);
}
`;
