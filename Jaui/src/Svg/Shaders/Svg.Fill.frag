#version 300 es
// SVG vector fill fragment — solid tint, alpha gated by the AA-skirt coverage. Straight
// (non-premultiplied) output to match the engine's SRC_ALPHA/ONE_MINUS_SRC_ALPHA blend
// (same convention as the text shader).
precision highp float;

in float v_Cov;
uniform vec4 u_Tint;   // straight rgba; a folds in element opacity

out vec4 fragColor;

void main() {
  float a = u_Tint.a * clamp(v_Cov, 0.0, 1.0);
  if (a <= 0.0) discard;
  fragColor = vec4(u_Tint.rgb, a);
}
