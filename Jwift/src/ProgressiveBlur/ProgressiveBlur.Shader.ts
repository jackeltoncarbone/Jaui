/**
 * ProgressiveBlur shader — draws a quad over the composited scene and
 * outputs a per-pixel continuously-variable Gaussian blur by lerping
 * between the levels of a ProgressiveBlurChain (each level is a real
 * full-resolution Gaussian at a geometrically-spaced sigma).
 *
 * No mipmap sampling, no box-filter downsample hints — every fragment
 * reads crisp Gaussian data and interpolates smoothly. This is the GPU
 * version of Show Studio's 7-div stacked-backdrop-filter technique.
 *
 * Layers (4) interpolated + unblurred scene at the clear end:
 *   position 0.00 in [0..1] → unblurred scene (dest shows through)
 *   position 0.25            → scene ↔ blur[0]    (σ ≈ 4)
 *   position 0.50            → blur[0] ↔ blur[1] (σ ≈ 16)
 *   position 0.75            → blur[1] ↔ blur[2] (σ ≈ 64)
 *   position 1.00            → blur[3]           (σ ≈ 256, heavy)
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
uniform sampler2D u_Blur0;                  // smallest sigma
uniform sampler2D u_Blur1;
uniform sampler2D u_Blur2;
uniform sampler2D u_Blur3;                  // largest sigma
uniform int u_Direction;                    // 0 ToTop, 1 ToBottom, 2 ToLeft, 3 ToRight
uniform float u_Opacity;

out vec4 fragColor;

/** Lerp between two stage samplers. */
vec3 lerpStage(vec3 a, vec3 b, float f) {
    return mix(a, b, clamp(f, 0.0, 1.0));
}

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

    // 5 slots along the ramp: scene, blur0, blur1, blur2, blur3 → 4 segments.
    // Each segment lerps between two adjacent slots based on the ramp's
    // position within [segStart .. segStart + 1/4].
    //
    // CRITICAL: all blending lives in the RGB channel. If we leaned on the
    // alpha channel for the ramp, dest (the unblurred scene that Pass 3
    // just blitted) would bleed through at every intermediate t, producing
    // a visible double-exposure — the blurred plate masked over the raw
    // plate. By fully opaque-writing a pre-blended RGB, the output at t=0
    // equals the raw scene sample (matching what dest already holds) and
    // smoothly ramps to blur3 at t=1. Zero haze, truly progressive.
    float seg = ramp * 4.0;
    int idx = int(floor(seg));
    float f = seg - float(idx);

    vec3 rgb;
    if (idx <= 0) {
        rgb = lerpStage(texture(u_Scene, v_SampleUv).rgb, texture(u_Blur0, v_SampleUv).rgb, f);
    } else if (idx == 1) {
        rgb = lerpStage(texture(u_Blur0, v_SampleUv).rgb, texture(u_Blur1, v_SampleUv).rgb, f);
    } else if (idx == 2) {
        rgb = lerpStage(texture(u_Blur1, v_SampleUv).rgb, texture(u_Blur2, v_SampleUv).rgb, f);
    } else if (idx == 3) {
        rgb = lerpStage(texture(u_Blur2, v_SampleUv).rgb, texture(u_Blur3, v_SampleUv).rgb, f);
    } else {
        rgb = texture(u_Blur3, v_SampleUv).rgb;
    }

    // Alpha = u_Opacity (Jiv-level fade only). No ramp in alpha — the ramp
    // is already baked into rgb via the stage interpolation above.
    fragColor = vec4(rgb, u_Opacity);
}
`;
