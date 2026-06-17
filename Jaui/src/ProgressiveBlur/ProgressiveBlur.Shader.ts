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
uniform vec4 u_Rot;                         // cosθ, sinθ, pivotX, pivotY (device px); (1,0)=none

out vec2 v_Local;                           // 0..1 across the Jiv; y=0 is top
out vec2 v_SampleUv;                        // UV into the blur pyramid / scene
out vec2 v_PixelPos;                        // device-pixel position (for clip SDF)

void main() {
    // v_Local (0..1) stays in the element's UNROTATED frame so the gradient
    // ramp + feather run along the element's own axes — which now follow its
    // rotation. The quad's screen position IS rotated about the pivot so the
    // blur region tracks the rotated card. (1,0) ⇒ identity (unrotated pblur).
    v_Local = a_Position;

    // Jiv's pixel-space corner, then rotated about the pivot.
    vec2 pixel = u_Rect.xy + a_Position * u_Rect.zw;
    vec2 rel = pixel - u_Rot.zw;
    pixel = vec2(rel.x * u_Rot.x - rel.y * u_Rot.y,
                 rel.x * u_Rot.y + rel.y * u_Rot.x) + u_Rot.zw;
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
uniform sampler2D u_Pyramid;                // mipmapped blur pyramid (LOD 0 = sharp scene, higher = more blur)
uniform float u_MaxLod;                     // max mipmap LOD to sample (maps to ramp = 1.0)
uniform int u_Direction;                    // 0 ToTop, 1 ToBottom, 2 ToLeft, 3 ToRight
uniform float u_Feather;                    // ramp length in device px (0 = span whole element)
uniform float u_Easing;                     // exponent applied to smoothstep'd ramp (1 = unchanged)
uniform float u_Opacity;
uniform vec4 u_Background;                  // tint mixed IN along the ramp (fades clear → authored alpha)
uniform vec3 u_Grading;                     // (Brightness, Saturation, Contrast) — all 1 = identity
uniform sampler2D u_ClipTex;                // per-frame clip-stack texture
uniform ivec2 u_ClipMeta;                   // (offset, count) into clip stack

// Gradient-driven blur spectrum. When u_HasStops == 1 the ramp is sampled from
// these stops along the element's axis (with per-segment easing) instead of the
// single linear feather, so blur + tint can cycle and follow a color gradient.
uniform int u_HasStops;
uniform int u_StopCount;                    // active stops (2..12)
uniform float u_StopPos[12];                // ascending positions along the axis (0 = top/left)
uniform float u_StopVal[12];                // frostedness at each stop (0 clear → 1 max blur)
uniform float u_StopEase[12];               // easing exponent for the segment FROM stop i to i+1

out vec4 fragColor;

// Interleaved Gradient Noise (Jimenez 2014). Unlike fract(sin(dot(...))),
// which decays into faint diagonal patterns at large pixel coordinates —
// exactly the full-screen high-blur region where banding shows — IGN stays
// well-distributed everywhere. Two offset samples form a triangular PDF;
// ±1 LSB at 8-bit dissolves the staircase contours a wide blur bakes into
// an RGBA8 gradient, invisibly.
float _ign(vec2 p) {
    return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}
float triDither(vec2 p) {
    return (_ign(p) + _ign(p + vec2(113.0, 71.0)) - 1.0) / 255.0;
}
// White-noise hash (Dave Hoskins). Decorrelated at ALL pixel coordinates, so
// unlike IGN it has no regular diagonal structure. Used for the large (±0.5)
// LOD jitter below, where IGN's structure reads as a Moiré weave on smooth
// blurred regions. IGN is kept for the ±1-LSB color dither (triDither), where
// its even distribution matters and its structure is sub-perceptual.
float _wn(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

// 4-tap cubic B-spline upsample. The progressive ramp's heavy end samples a
// tiny mip (LOD ~5 = 1/32 res); a plain bilinear textureLod magnifies that
// mip's texel grid into visible soft "blocks". A cubic B-spline
// reconstruction is smooth (no ringing) and dissolves the blocks for only 4
// bilinear fetches via the standard weight-folding trick — cheap enough for
// the (scissored) progressive pass. All B-spline pair-weights are positive
// and partition to 1, so the divisions below never hit zero.
vec4 cubicWeights(float v) {
    vec4 n = vec4(1.0, 2.0, 3.0, 4.0) - v;
    vec4 s = n * n * n;
    float x = s.x;
    float y = s.y - 4.0 * s.x;
    float z = s.z - 4.0 * s.y + 6.0 * s.x;
    float w = 6.0 - x - y - z;
    return vec4(x, y, z, w) * (1.0 / 6.0);
}

// texSize = the pyramid's effective resolution at this (fractional) LOD,
// i.e. u_Resolution / 2^lod. textureLod still does the trilinear mip blend;
// the B-spline reconstructs smoothly across that level's texel grid.
vec3 textureBicubicLod(sampler2D tex, vec2 uv, float lod, vec2 texSize) {
    vec2 invTexSize = 1.0 / texSize;
    vec2 coord = uv * texSize - 0.5;
    vec2 fxy = fract(coord);
    coord -= fxy;

    vec4 xcubic = cubicWeights(fxy.x);
    vec4 ycubic = cubicWeights(fxy.y);

    vec4 c = coord.xxyy + vec2(-0.5, 1.5).xyxy;
    vec4 s = vec4(xcubic.xz + xcubic.yw, ycubic.xz + ycubic.yw);
    vec4 offset = c + vec4(xcubic.yw, ycubic.yw) / s;
    offset *= invTexSize.xxyy;

    vec3 s0 = textureLod(tex, offset.xz, lod).rgb;
    vec3 s1 = textureLod(tex, offset.yz, lod).rgb;
    vec3 s2 = textureLod(tex, offset.xw, lod).rgb;
    vec3 s3 = textureLod(tex, offset.yw, lod).rgb;

    float sx = s.x / (s.x + s.y);
    float sy = s.z / (s.z + s.w);
    return mix(mix(s3, s2, sx), mix(s1, s0, sx), sy);
}

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
        // meta = (Smoothness, cosθ, sinθ, _). Un-rotate the sample about the clip's
        // center by R(-θ) so a ROTATED clip parent clips the blur along its rotated
        // edges — IDENTICAL to Jiv.Panel.frag's clipStackDistance (the card body uses
        // that path, which is why the card outline rotates). Without this the pblur was
        // masked by an AXIS-ALIGNED rounded rect, so the (correctly rotated) gradient got
        // cropped to a non-rotated box and read as "not rotated". cos=1/sin=0 ⇒ identity.
        vec2 cc = rect.xy + rect.zw * 0.5;
        vec2 rel = pixel - cc;
        vec2 local = vec2(rel.x * meta.y + rel.y * meta.z,
                          -rel.x * meta.z + rel.y * meta.y) + cc;
        d = max(d, clipShapeDistance(local, rect, radii, meta.x));
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
        vec4 meta = texelFetch(u_ClipTex, ivec2(base + 2, 0), 0); // (smoothness, cosθ, sinθ, _)
        vec2 pxMin = rect.xy;
        vec2 pxMax = rect.xy + rect.zw;
        // Under rotation (meta.y,meta.z != 1,0) the stored rect is the UNROTATED
        // box; the real clip occupies its rotated AABB, which is larger. Expand
        // the clamp to that rotated bounding box so the blur can sample the whole
        // rotated clip — otherwise the diagonal corners are clipped too tight
        // ("edge miss on the outside") and shift as the rotation animates.
        float aCos = abs(meta.y), aSin = abs(meta.z);
        if (aSin > 0.0001) {
            vec2 c = rect.xy + rect.zw * 0.5;
            vec2 halfExt = rect.zw * 0.5;
            vec2 rotHalf = vec2(aCos * halfExt.x + aSin * halfExt.y,
                                aSin * halfExt.x + aCos * halfExt.y);
            pxMin = c - rotHalf;
            pxMax = c + rotHalf;
        }
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
        // Ceiling the feather at the axis length — a feather longer than the
        // element can never complete the ramp, so the whole element would read
        // as a partial gradient that never reaches full blur.
        float fe = min(u_Feather, axisLen);
        t = clamp(t * axisLen / fe, 0.0, 1.0);
    }

    // The blur "ramp" (0 clear → 1 max blur). Two ways to get it:
    //   • gradient stops (u_HasStops) — sample a piecewise spectrum along the
    //     axis with per-segment easing, so blur cycles + follows a color gradient.
    //   • linear feather (default) — the smoothstep'd t computed above.
    float ramp;
    if (u_HasStops == 1) {
        // Axis position 0..1 (top→bottom for vertical dirs, left→right for horizontal).
        float ax = (u_Direction == 0 || u_Direction == 1) ? v_Local.y : v_Local.x;
        if (ax <= u_StopPos[0]) {
            ramp = u_StopVal[0];
        } else if (ax >= u_StopPos[u_StopCount - 1]) {
            ramp = u_StopVal[u_StopCount - 1];
        } else {
            ramp = u_StopVal[u_StopCount - 1];
            for (int i = 0; i < 12; i++) {
                if (i + 1 >= u_StopCount) break;
                float p0 = u_StopPos[i];
                float p1 = u_StopPos[i + 1];
                if (ax >= p0 && ax <= p1) {
                    float seg = (p1 > p0) ? (ax - p0) / (p1 - p0) : 0.0;
                    seg = pow(clamp(seg, 0.0, 1.0), max(u_StopEase[i], 0.001));
                    ramp = mix(u_StopVal[i], u_StopVal[i + 1], seg);
                    break;
                }
            }
        }
    } else {
        // Smoothstep the ramp — linear feels like a hard diagonal line over
        // uniform content; smoothstep is what the eye reads as "feathered".
        // u_Easing reshapes the curve: 1.0 = unchanged, <1 biases toward blur
        // (ramp climbs fast, sharp falloff to clear), >1 biases toward clear.
        ramp = pow(smoothstep(0.0, 1.0, t), u_Easing);
    }

    // Early-out: fully frosted AND the background is fully opaque → the final
    // color is just u_Background regardless of the scene. Skip the pyramid
    // sample + grading + mix entirely.
    if (ramp >= 0.999 && u_Background.a >= 0.999) {
        fragColor = vec4(u_Background.rgb, u_Opacity * clipAlpha);
        return;
    }

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
    // Dissolve mip-transition contours. As lod sweeps across the ramp, each
    // integer mip boundary is a trilinear crossover between two blur octaves
    // of (perceptually) different blur amount, which reads as a faint band.
    // This is BETWEEN mip levels, so precision / bicubic / output dither
    // can't touch it. A ±0.5-level per-pixel jitter spreads every crossover
    // into noise the blur + output dither absorb.
    // Triangular-PDF LOD jitter from two decorrelated IGN samples. Keeps the
    // ±0.5 peak span needed to cross a mip boundary, but its lower RMS and
    // decorrelated structure dissolve the crossover bands with far less
    // visible grain than a single uniform ±0.5 sample (which read as a
    // structured Moiré on smooth regions).
    float lodJitter = (_wn(v_PixelPos + 31.0) + _wn(v_PixelPos + 97.0) - 1.0) * 0.5;
    lod = max(0.0, lod + lodJitter);
    vec2 texelUv = exp2(lod) / u_Resolution;
    // Inset by ~2 texels (not ½) so the bicubic kernel's footprint stays
    // inside the clip AABB — no beyond-clip scene content bleeds into the
    // blurred edge.
    vec2 uvMin = clipUv.xy + texelUv * 2.0;
    vec2 uvMax = clipUv.zw - texelUv * 2.0;
    vec2 safeUv = clamp(v_SampleUv, min(uvMin, uvMax), max(uvMin, uvMax));

    // True single-continuum sample. The pyramid's mip 0 IS the sharp scene
    // (seeded raw — see BlurPass sharp-root), so one continuous LOD ramps from
    // crisp (lod 0) to heavy (u_MaxLod) with NO sharp/blurred crossfade and no
    // separate scene texture — true progression, not a mask. Trilinear at low
    // LOD keeps the clear edge pixel-crisp; the block-free cubic B-spline folds
    // in as LOD grows (the heavy end magnifies tiny mips, where plain bilinear
    // would show soft blocks). texSize = pyramid res at this LOD = res / 2^lod.
    vec3 sharpRgb  = textureLod(u_Pyramid, safeUv, lod).rgb;
    vec3 smoothRgb = textureBicubicLod(u_Pyramid, safeUv, lod, u_Resolution / exp2(lod));
    vec3 rgb = mix(sharpRgb, smoothRgb, smoothstep(1.0, 3.0, lod));

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

    // Dither the final RGB to break RGBA8 banding across the smooth ramp.
    rgb += triDither(v_PixelPos);

    // Alpha = u_Opacity (Jiv-level fade only). No ramp in alpha — the ramp
    // is already baked into rgb via the stage interpolation + grading above.
    // clipAlpha feathers the rounded-rect clip edge so the blur's visible
    // silhouette has proper AA instead of a hard boolean cut.
    fragColor = vec4(rgb, u_Opacity * clipAlpha);
}
`;
