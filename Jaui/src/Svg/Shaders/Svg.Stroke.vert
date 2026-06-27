#version 300 es
// SVG vector stroke — instanced miter-quad segments. The unit quad (loc 0) expands each
// segment between its two endpoints, offset by the per-vertex miter vectors; the fragment
// computes the true perpendicular distance to the segment for smooth SDF anti-aliasing.
precision highp float;

layout(location = 0) in vec2 a_Corner;  // unit quad [0,1]^2
layout(location = 1) in vec4 a_Seg;     // Ax, Ay, Bx, By (viewBox units)
layout(location = 2) in vec4 a_Miter;   // miterA.xy, miterB.xy (viewBox units, incl. feather)

uniform vec2 u_Resolution;   // device px
uniform vec3 u_Model0;       // (a, c, e): xDev = a*x + c*y + e
uniform vec3 u_Model1;       // (b, d, f): yDev = b*x + d*y + f

out vec2 v_PosDev;           // this fragment's device-px position
out vec4 v_SegDev;           // segment endpoints in device px (Adev.xy, Bdev.xy)

vec2 toDev(vec2 p) { vec3 h = vec3(p, 1.0); return vec2(dot(u_Model0, h), dot(u_Model1, h)); }

void main() {
  vec2 A = a_Seg.xy, B = a_Seg.zw;
  vec2 base  = mix(A, B, a_Corner.x);
  vec2 miter = mix(a_Miter.xy, a_Miter.zw, a_Corner.x);
  vec2 p = base + miter * (a_Corner.y * 2.0 - 1.0);

  vec2 dev = toDev(p);
  v_PosDev = dev;
  v_SegDev = vec4(toDev(A), toDev(B));

  vec2 clip = (dev / u_Resolution) * 2.0 - 1.0;
  clip.y = -clip.y;
  gl_Position = vec4(clip, 0.0, 1.0);
}
