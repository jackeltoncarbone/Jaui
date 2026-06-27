#version 300 es
// SVG vector fill — transforms a tessellated triangle-soup vertex (viewBox space) through
// the element's model matrix into device pixels, then to clip space. Coverage (a_Vert.z)
// carries the AA-skirt feather: 1 in the interior, ramping to 0 across the ~1px skirt.
precision highp float;

layout(location = 0) in vec3 a_Vert; // x, y (viewBox units), coverage

uniform vec2 u_Resolution;   // device px
uniform vec3 u_Model0;       // (a, c, e): xDev = a*x + c*y + e
uniform vec3 u_Model1;       // (b, d, f): yDev = b*x + d*y + f

out float v_Cov;

void main() {
  vec3 h = vec3(a_Vert.xy, 1.0);
  float px = dot(u_Model0, h);
  float py = dot(u_Model1, h);
  v_Cov = a_Vert.z;
  vec2 clip = (vec2(px, py) / u_Resolution) * 2.0 - 1.0;
  clip.y = -clip.y;
  gl_Position = vec4(clip, 0.0, 1.0);
}
