#version 300 es
precision highp float;

// Measures the backdrop under one glass surface into its texel of the state row, once per frame: G is the
// mean luma under its footprint, which picks the glass's appearance (Core/Glass.md) and tracks thin glass's
// face. The renderer blends each write into the previous value, so the reading eases over time.

// Kept bound by the renderer beside the pyramid; the mean reads the pyramid alone.
uniform sampler2D u_Scene;
// The blur pyramid the surface itself samples. It is sized to that surface, so a screen UV maps into it as
// `uv * u_BackdropXf.xy + u_BackdropXf.zw` (identity for a full-canvas pyramid).
uniform sampler2D u_Backdrop;
uniform vec4 u_BackdropXf;
uniform vec2 u_Resolution;
// The surface's footprint in device px, y down.
uniform vec4 u_Rect;
// The pyramid LOD the mean is read at.
uniform float u_DetailLod;

out vec4 fragColor;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// Taps follow the R2 low-discrepancy sequence: even cover of the footprint with no rows or columns, so a
// regular pattern (lines of text, a grid of cells) cannot fall between them.
const int PROBE_TAPS = 96;
const vec2 PROBE_R2 = vec2(0.7548776662, 0.5698402910);

void main() {
    float sum = 0.0;
    for (int k = 0; k < PROBE_TAPS; k++) {
        vec2 cell = fract(0.5 + float(k + 1) * PROBE_R2);
        vec2 uv = (u_Rect.xy + cell * u_Rect.zw) / u_Resolution;
        uv.y = 1.0 - uv.y;
        sum += dot(textureLod(u_Backdrop, uv * u_BackdropXf.xy + u_BackdropXf.zw, u_DetailLod).rgb, LUMA);
    }
    fragColor = vec4(0.0, sum / float(PROBE_TAPS), 0.0, 1.0);
}
