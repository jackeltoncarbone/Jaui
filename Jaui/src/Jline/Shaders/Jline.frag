#version 300 es
precision highp float;

// Jline fragment — TRUE distance to the segment (round caps from the clamp) gives a smooth SDF edge
// with exact joins (no facets/beading). Style is keyframed along arc-length t (independent tracks:
// colour / width / alpha / blur). Blur = SDF edge-softness (true continuous progression, not a masked
// cross-fade). A `progress` uniform slides the visible trail window. All lengths are in device px.

in vec2  v_World;
flat in vec4 v_Seg;      // Ax,Ay,Bx,By (device px)
flat in vec2 v_Arc;      // t0, t1
flat in float v_Phase;
out vec4 frag;

uniform float u_Progress;     // head position along arc, 0..1
uniform float u_HalfW;        // line half-width (device px)
uniform float u_HeadR;        // head dot radius (device px)
uniform float u_Blur;         // max edge-softness at the dissolved tail (device px)
uniform float u_Ahead;        // trail window ahead of head (window-units)
uniform float u_Behind;       // trail window behind head (window-units)
uniform float u_WindowUnit;   // window-unit -> arc-fraction scale
uniform float u_HeadA;        // head alpha
uniform float u_FloorA;       // body/floor alpha
uniform float u_HeadFade;     // head-lobe arc width (fraction)
uniform float u_Spread;       // 1 = apply per-line phase offset, 0 = synced
uniform float u_ShowPrior;    // 1 = show prior (behind-head) ghost
uniform vec3  u_FwdA;         // forward ramp colour at head
uniform vec3  u_FwdB;         // forward ramp colour ahead
uniform vec3  u_Prior;        // prior ghost colour

void main() {
    vec2 ab = v_Seg.zw - v_Seg.xy;
    float l2 = max(dot(ab, ab), 1e-7);
    float f = clamp(dot(v_World - v_Seg.xy, ab) / l2, 0.0, 1.0);
    float dist = distance(v_World, v_Seg.xy + f * ab);     // true perpendicular/cap distance
    float t = mix(v_Arc.x, v_Arc.y, f);

    float head = u_Progress + v_Phase * u_Spread; head -= floor(head);
    float s = t - head;                                    // +ahead of head, -behind
    float ahead  = u_Ahead  * u_WindowUnit;
    float behind = u_Behind * u_WindowUnit;
    float inWin = step(-behind, s) * step(s, ahead);
    float ageBehind = behind > 0.0 ? clamp(-s / behind, 0.0, 1.0) : 0.0;
    float ageAhead  = ahead  > 0.0 ? clamp( s / ahead , 0.0, 1.0) : 0.0;

    // BLUR track: sharp at head, ramping to u_Blur at the dissolved tail.
    float blur = mix(0.6, u_Blur, ageBehind * ageBehind);   // 0.6px floor keeps the head crisp but AA'd
    // WIDTH track: line body swelling to the head dot near s=0.
    float headLobe = 1.0 - smoothstep(0.0, u_HeadFade, abs(s));
    float halfW = max(u_HalfW, mix(u_HalfW, u_HeadR, headLobe));
    // TRUE-distance SDF coverage.
    float cov = 1.0 - smoothstep(halfW - blur, halfW + blur, dist);
    // ALPHA track.
    float a = mix(u_FloorA, u_HeadA, headLobe) * mix(1.0, 0.0, ageBehind) * ((s > 0.0) ? (1.0 - ageAhead) : 1.0) * inWin;
    // COLOUR track: forward = now->future ramp; behind head = prior ghost.
    vec3 fwd = mix(u_FwdA, u_FwdB, clamp(ageAhead, 0.0, 1.0));
    vec3 col = (s >= 0.0) ? fwd : mix(u_FwdA, u_Prior, u_ShowPrior * clamp(ageBehind * 1.2, 0.0, 1.0));

    float oa = cov * a;
    if (oa < 0.002) discard;
#ifdef JLINE_PREMULTIPLIED
    frag = vec4(col * oa, oa);  // premultiplied — compositing into a premultiplied target (the turf RT)
#else
    frag = vec4(col, oa);       // straight alpha — Jaui's renderer blends src-alpha over the scene
#endif
}
