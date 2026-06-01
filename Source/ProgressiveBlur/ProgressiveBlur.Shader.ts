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
out vec2 v_PixelPos;                        // device-pixel position (for clip SDF)

void main() {
    v_Local = a_Position;

    // Jiv's pixel-space corner. y is top-anchored in our convention.
    vec2 pixel = u_Rect.xy + a_Position * u_Rect.zw;
    v_PixelPos = pixel;

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
in vec2 v_PixelPos;

uniform vec2 u_Resolution;                  // canvas w/h, device px
uniform vec4 u_Rect;                        // x, y, w, h of this pblur element (device px)
uniform sampler2D u_Scene;                  // unblurred scene (level -1)
uniform sampler2D u_Pyramid;                // mipmapped blur pyramid (LOD 0 = base blur, higher = more)
uniform float u_MaxLod;                     // max mipmap LOD to sample (maps to ramp = 1.0)
uniform int u_Direction;                    // 0 ToTop, 1 ToBottom, 2 ToLeft, 3 ToRight
uniform float u_Feather;                    // ramp length in device px (0 = span whole element)
uniform float u_Easing;                     // exponent applied to smoothstep'd ramp (1 = unchanged)
uniform float u_Opacity;
uniform vec4 u_Background;                  // tint mixed IN along the ramp (fades clear → authored alpha)
uniform vec3 u_Grading;                     // (Brightness, Saturation, Contrast) — all 1 = identity
uniform sampler2D u_ClipTex;                // per-frame clip-stack texture
uniform ivec2 u_ClipMeta;                   // (offset, count) into clip stack

out vec4 fragColor;

float pickClipRadius(vec2 p, vec4 radii) {
    if (p.x >= 0.0) {
        return p.y <= 0.0 ? radii.y : radii.z;
    }
    return p.y <= 0.0 ? radii.x : radii.w;
}

// Signed distance to the rounded-rect clip boundary. Negative inside,
// positive outside, in device pixels. Enables a 1-pixel smoothstep at the
// clip edge instead of a hard discard.
float clipShapeDistance(vec2 pixel, vec4 rect, vec4 radii, float smoothness) {
    vec2 center = rect.xy + rect.zw * 0.5;
    vec2 halfSize = rect.zw * 0.5;
    vec2 qSigned = pixel - center;
    vec2 qAbs = abs(qSigned);
    float r = pickClipRadius(qSigned, radii);
    vec2 cornerP = qAbs - (halfSize - vec2(r));
    if (r <= 0.0 || cornerP.x <= 0.0 || cornerP.y <= 0.0) {
        return max(qAbs.x - halfSize.x, qAbs.y - halfSize.y);
    }
    float n = 2.0 + 6.0 * clamp(smoothness, 0.0, 1.0);
    float L = pow(cornerP.x / r, n) + pow(cornerP.y / r, n);
    return r * (pow(max(L, 0.0), 1.0 / n) - 1.0);
}

const int MAX_CLIP_DEPTH = 16;

float clipStackDistance(vec2 pixel, int offset, int count) {
    float d = -1e20;
    for (int i = 0; i < MAX_CLIP_DEPTH; i++) {
        if (i >= count) break;
        int base = (offset + i) * 3;
        vec4 rect = texelFetch(u_ClipTex, ivec2(base, 0), 0);
        vec4 radii = texelFetch(u_ClipTex, ivec2(base + 1, 0), 0);
        vec4 meta = texelFetch(u_ClipTex, ivec2(base + 2, 0), 0);
        d = max(d, clipShapeDistance(pixel, rect, radii, meta.x));
    }
    return d;
}

// Intersection of all active clip AABBs in sample_uv space (scene UV has
// y flipped vs device px). Used to clamp pyramid lookups so the mip's
// spatial neighborhood never reaches past the parent's clip — prevents
// beyond-clip content from leaking into blurred pixels along the edges.
vec4 clipStackUvAabb(int offset, int count, vec2 resolution) {
    vec2 uvMin = vec2(0.0);
    vec2 uvMax = vec2(1.0);
    for (int i = 0; i < MAX_CLIP_DEPTH; i++) {
        if (i >= count) break;
        int base = (offset + i) * 3;
        vec4 rect = texelFetch(u_ClipTex, ivec2(base, 0), 0);
        vec2 pxMin = rect.xy;
        vec2 pxMax = rect.xy + rect.zw;
        vec2 cUvMin = vec2(pxMin.x / resolution.x, 1.0 - pxMax.y / resolution.y);
        vec2 cUvMax = vec2(pxMax.x / resolution.x, 1.0 - pxMin.y / resolution.y);
        uvMin = max(uvMin, cUvMin);
        uvMax = min(uvMax, cUvMax);
    }
    return vec4(uvMin, uvMax);
}

void main() {
    float clipD = clipStackDistance(v_PixelPos, u_ClipMeta.x, u_ClipMeta.y);
    if (clipD > 1.0) discard;
    float clipAlpha = 1.0 - smoothstep(-0.5, 0.5, clipD);
    // t = 0 at the clear end → 1 at the blurred end
    float t;
    if (u_Direction == 0)       t = 1.0 - v_Local.y;    // ToTop
    else if (u_Direction == 1)  t = v_Local.y;          // ToBottom
    else if (u_Direction == 2)  t = 1.0 - v_Local.x;    // ToLeft
    else                        t = v_Local.x;          // ToRight

    // u_Feather lets authors cap the ramp distance — past it, stay fully
    // blurred + fully tinted. Rescale t so the ramp hits 1 at exactly
    // u_Feather device px from the clear edge. 0 = original behaviour
    // (ramp spans the whole element on the gradient axis).
    if (u_Feather > 0.0) {
        float axisLen = (u_Direction == 0 || u_Direction == 1) ? u_Rect.w : u_Rect.z;
        t = clamp(t * axisLen / u_Feather, 0.0, 1.0);
    }

    // Early-out: past the feather AND the background is fully opaque, the
    // fragment's final color is just u_Background regardless of what's
    // behind. Skip the pyramid sample + grading + mix entirely — saves a
    // textureLod + a texture + an apply_grading chain on every solid-zone
    // fragment. The caller should ALSO scissor the blur pyramid build to
    // the feather zone in this case (no pyramid content is read here).
    if (t >= 1.0 && u_Background.a >= 0.999) {
        fragColor = vec4(u_Background.rgb, u_Opacity * clipAlpha);
        return;
    }

    // Smoothstep the ramp — linear feels like a hard diagonal line over
    // uniform content; smoothstep is what the eye reads as "feathered".
    // u_Easing reshapes the curve: 1.0 = unchanged, <1 biases toward blur
    // (ramp climbs fast, sharp falloff to clear), >1 biases toward clear.
    float ramp = pow(smoothstep(0.0, 1.0, t), u_Easing);

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
    // Clamp sample_uv so mipmap neighborhoods never reach past the parent's
    // clip AABB. Inset by half a texel at the current LOD so the bilinear
    // footprint at that level lands entirely inside the clip — no beyond-clip
    // pixels bleeding into blurred results along the clip edges.
    vec4 clipUv = clipStackUvAabb(u_ClipMeta.x, u_ClipMeta.y, u_Resolution);
    // Quadratic LOD curve — each mipmap LOD doubles sigma, so a linear LOD
    // ramp looks exponential to the eye. Squaring makes the perceived blur
    // increase feel linear (gentle near clear end, steeper near blurred end).
    float lod = ramp * ramp * u_MaxLod;
    vec2 texelUv = exp2(lod) / u_Resolution;
    vec2 uvMin = clipUv.xy + texelUv * 0.5;
    vec2 uvMax = clipUv.zw - texelUv * 0.5;
    vec2 safeUv = clamp(v_SampleUv, min(uvMin, uvMax), max(uvMin, uvMax));

    vec3 sceneRgb = texture(u_Scene, safeUv).rgb;
    vec3 blurRgb = textureLod(u_Pyramid, safeUv, lod).rgb;
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
    // clipAlpha feathers the rounded-rect clip edge so the blur's visible
    // silhouette has proper AA instead of a hard boolean cut.
    fragColor = vec4(rgb, u_Opacity * clipAlpha);
}
`;
