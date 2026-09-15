#version 300 es
precision highp float;

// Measures the backdrop under one glass surface into its texel of the shadow state row, once per frame.
// Apple's rule (WWDC25 "Meet Liquid Glass"): the shadow grows more opaque over text and busy content and
// less opaque over a solid light ground. Only the backdrop decides; nothing here knows the theme.
// The renderer blends each write into the previous value, so the result eases over a few frames.

// Sharp snapshot of what lies behind the surface.
uniform sampler2D u_Scene;
// The blur pyramid the surface itself samples.
uniform sampler2D u_Backdrop;
uniform vec2 u_Resolution;
// The surface's footprint in device px, y down.
uniform vec4 u_Rect;
// Pyramid LOD of the local mean each sharp tap is compared against.
uniform float u_DetailLod;

out vec4 fragColor;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// Taps follow the R2 low-discrepancy sequence: even cover of the footprint with no rows or columns, so a
// regular pattern (lines of text, a grid of cells) cannot fall between them.
const int SHADOW_TAPS = 96;
const vec2 SHADOW_R2 = vec2(0.7548776662, 0.5698402910);
// Detail is the mean distance of the sharp backdrop from its local blur: 0 for any smooth ground (a flat
// colour, a gradient, blurred art) and large over glyphs, edges and texture. Below LOW is a smooth ground;
// above HIGH is text or busy imagery.
const float SHADOW_DETAIL_LOW = 0.01;
const float SHADOW_DETAIL_HIGH = 0.08;
// Mean luminance from which a flat ground reads as light, and as fully light.
const float SHADOW_LIGHT_LOW = 0.35;
const float SHADOW_LIGHT_HIGH = 0.85;
// The share a flat dark ground keeps. A shadow over black cannot show, so this only matters on dark greys.
const float SHADOW_FLAT_DARK = 0.5;

// 0 over a flat light ground, 1 over text or busy content.
float ShadowBackdropFactor(float meanLuma, float detail) {
    float busy = smoothstep(SHADOW_DETAIL_LOW, SHADOW_DETAIL_HIGH, detail);
    float light = smoothstep(SHADOW_LIGHT_LOW, SHADOW_LIGHT_HIGH, meanLuma);
    return max(busy, (1.0 - light) * SHADOW_FLAT_DARK);
}

void main() {
    float count = float(SHADOW_TAPS);
    float sum = 0.0;
    float detail = 0.0;
    for (int k = 0; k < SHADOW_TAPS; k++) {
        vec2 cell = fract(0.5 + float(k + 1) * SHADOW_R2);
        vec2 pixel = u_Rect.xy + cell * u_Rect.zw;
        vec2 uv = pixel / u_Resolution;
        uv.y = 1.0 - uv.y;
        float sharp = dot(textureLod(u_Scene, uv, 0.0).rgb, LUMA);
        float local = dot(textureLod(u_Backdrop, uv, u_DetailLod).rgb, LUMA);
        sum += local;
        detail += abs(sharp - local);
    }
    fragColor = vec4(ShadowBackdropFactor(sum / count, detail / count), 0.0, 0.0, 1.0);
}
