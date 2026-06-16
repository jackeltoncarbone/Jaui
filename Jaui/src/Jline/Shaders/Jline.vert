#version 300 es
precision highp float;

// Jline — GPU keyframed parametric stroke. Instanced PER SEGMENT: the unit quad
// expands to the segment's MITER quad (miter vectors are computed CPU-side per
// path-vertex so adjacent segments tile exactly — no overlap, no beading). The
// fragment computes the TRUE distance to the segment for a smooth SDF edge.

layout(location = 0) in vec2 a_Position;   // unit quad [0,1]

// Per-instance (one segment)
layout(location = 1) in vec4 a_Seg;        // Ax, Ay, Bx, By  (device px)
layout(location = 2) in vec4 a_Miter;      // miterA.xy, miterB.xy  (device px, half-extent offset)
layout(location = 3) in vec4 a_Arc;        // t0, t1, phase, collide  (t = arc fraction 0..1; collide 0..1)

uniform vec2 u_Resolution;

out vec2  v_World;       // device-px position of this fragment
flat out vec4 v_Seg;     // segment endpoints (device px) — for the fragment's true distance
flat out vec2 v_Arc;     // t0, t1 (arc fraction at A / B); fragment projects for the exact t
flat out float v_Phase;  // per-line progress offset
flat out float v_Collide; // per-segment collision factor (0..1) — tints the line red where a collision occurs

void main() {
    // x: 0 = A end, 1 = B end. y: 0 = -miter side, 1 = +miter side.
    vec2 endpoint = mix(a_Seg.xy, a_Seg.zw, a_Position.x);
    vec2 miter    = mix(a_Miter.xy, a_Miter.zw, a_Position.x);
    vec2 pos      = endpoint + (a_Position.y * 2.0 - 1.0) * miter;

    v_World = pos;
    v_Seg   = a_Seg;
    v_Arc   = a_Arc.xy;
    v_Phase = a_Arc.z;
    v_Collide = a_Arc.w;

    vec2 clip = (pos / u_Resolution) * 2.0 - 1.0;
    clip.y = -clip.y;
    gl_Position = vec4(clip, 0.0, 1.0);
}
