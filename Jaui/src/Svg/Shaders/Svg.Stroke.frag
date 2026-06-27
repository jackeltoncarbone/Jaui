#version 300 es
// SVG vector stroke fragment — true perpendicular-distance SDF to the segment, gated to the
// stroke half-width with a ~1px feather. Straight (non-premultiplied) output to match the
// engine's SRC_ALPHA/ONE_MINUS_SRC_ALPHA blend.
precision highp float;

in vec2 v_PosDev;
in vec4 v_SegDev;

uniform vec4 u_Tint;          // straight rgba; a folds in element opacity
uniform float u_HalfWidthDev; // stroke half-width in device px

out vec4 fragColor;

float segDist(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}

void main() {
  float d = segDist(v_PosDev, v_SegDev.xy, v_SegDev.zw);
  float aa = fwidth(d) + 0.5;
  float cov = 1.0 - smoothstep(u_HalfWidthDev - aa, u_HalfWidthDev + aa, d);
  float a = u_Tint.a * cov;
  if (a <= 0.0) discard;
  fragColor = vec4(u_Tint.rgb, a);
}
