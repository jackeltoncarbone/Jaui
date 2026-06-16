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
flat in float v_Collide; // per-segment collision factor (0..1)
out vec4 frag;

uniform float u_Progress;     // head position along arc, 0..1
uniform float u_HalfW;        // line half-width (device px)
uniform float u_HeadR;        // head dot radius (device px)
uniform float u_Blur;         // max edge-softness at the dissolved tail (device px)
uniform float u_BlurFloor;    // min edge-softness at the sharp head (device px) — AA floor
uniform float u_BlurSharp;    // fraction (0..1) of the visible trail kept sharp before the blur ramps in
uniform float u_Ahead;        // trail window ahead of head (window-units)
uniform float u_Behind;       // trail window behind head (window-units)
uniform float u_WindowUnit;   // window-unit -> arc-fraction scale
uniform float u_HeadA;        // head alpha
uniform float u_FloorA;       // body/floor alpha
uniform float u_HeadFade;     // head-lobe arc width (fraction)
uniform float u_TrailMinA;    // floor opacity — the trail never fades below this (visible start→end)
uniform float u_Spread;       // 1 = apply per-line phase offset, 0 = synced
uniform float u_ShowPrior;    // 1 = show prior (behind-head) ghost
uniform float u_PriorScale;   // opacity multiplier for the behind (history) trail
uniform vec3  u_FwdA;         // forward ramp colour at head
uniform vec3  u_FwdB;         // forward ramp colour ahead
uniform vec3  u_Prior;        // prior ghost colour
uniform vec3  u_CollisionColor; // colour the line takes where a collision occurs (per-segment v_Collide)

void main() {
    vec2 ab = v_Seg.zw - v_Seg.xy;
    float l2 = max(dot(ab, ab), 1e-7);
    float f = clamp(dot(v_World - v_Seg.xy, ab) / l2, 0.0, 1.0);
    float dist = distance(v_World, v_Seg.xy + f * ab);     // true perpendicular/cap distance
    float t = mix(v_Arc.x, v_Arc.y, f);

    float head = u_Progress + v_Phase * u_Spread; head -= floor(head);
    // GLSL `fract(1.0) == 0.0`: a head that has reached the very end (progress 1.0) would otherwise wrap
    // back to the path START, flashing the whole trail as if the move had just begun. A completed move
    // sits AT the destination, so pin the terminal frame to the end (phase shimmer yields there).
    if (u_Progress >= 1.0) head = 1.0;
    float s = t - head;                                    // +ahead of head, -behind
    // Cap the window to the VISIBLE path so blur/fade ramp fully across what's actually DRAWN. The default
    // window (e.g. 48 counts) is usually larger than a cue's path; uncapped, `age` never climbs out of the
    // sharp zone → no visible progressive blur. (The old comet normalised blur across the drawn trail, not
    // the raw window.) `1-head`/`head` are the arc distances from the head to the path's far/near ends.
    float ahead  = min(u_Ahead  * u_WindowUnit, 1.0 - head);
    float behind = min(u_Behind * u_WindowUnit, head);
    float inWin = step(-behind, s) * step(s, ahead);
    float ageBehind = behind > 0.0 ? clamp(-s / behind, 0.0, 1.0) : 0.0;
    float ageAhead  = ahead  > 0.0 ? clamp( s / ahead , 0.0, 1.0) : 0.0;

    // BLUR track: sharp at the head, ramping to u_Blur with DISTANCE from the head in EITHER direction —
    // the forward trail (toward the destination) blurs with distance too, matching the old comet where the
    // progressive blur encoded how far along the move you are. Sharp for the near ~third (smoothstep 0.35→1),
    // then ramps to u_Blur at the dissolve extent. 0.6px floor keeps the crisp part AA'd.
    float age = max(ageAhead, ageBehind);
    float blur = mix(u_BlurFloor, u_Blur, smoothstep(u_BlurSharp, 1.0, age));
    // WIDTH track: line body swelling to the head dot near s=0.
    float headLobe = 1.0 - smoothstep(0.0, u_HeadFade, abs(s));
    float halfW = max(u_HalfW, mix(u_HalfW, u_HeadR, headLobe));
    // TRUE-distance SDF coverage.
    float cov = 1.0 - smoothstep(halfW - blur, halfW + blur, dist);
    // ALPHA track. The line runs the WHOLE path (start→end): it's brightest at the head and fades toward
    // both ends, but is FLOORED at u_TrailMinA so it never fully dissolves — always visible end to end.
    // Behind the head (s<0) it's additionally dimmed by u_PriorScale (history reads fainter), still floored.
    float priorMul = (s < 0.0) ? u_PriorScale : 1.0;
    float fade = (s > 0.0) ? (1.0 - ageAhead) : (1.0 - ageBehind);   // 1 at head → 0 at the far ends
    float base = mix(u_FloorA, u_HeadA, headLobe) * fade * priorMul;
    // FORWARD trail (the route still to march) is floored at u_TrailMinA so it stays visible end-to-end —
    // translucent far ahead, never gone. BEHIND the head (already marched) is NOT floored: it dims away by
    // base (PriorScale × fade) so history reads as a faint, fading ghost.
    float a = inWin * (s >= 0.0 ? max(base, u_TrailMinA) : base);
    // COLOUR track: forward = now->future ramp; behind head = prior ghost.
    vec3 fwd = mix(u_FwdA, u_FwdB, clamp(ageAhead, 0.0, 1.0));
    vec3 col = (s >= 0.0) ? fwd : mix(u_FwdA, u_Prior, u_ShowPrior * clamp(ageBehind * 1.2, 0.0, 1.0));
    // COLLISION: tint the trail toward the collision colour where the marcher's avoided collision occurs
    // (per-segment factor baked CPU-side as a falloff around the collision beat — an inline red section in
    // time, replacing the separate bloom/fill overlay).
    col = mix(col, u_CollisionColor, clamp(v_Collide, 0.0, 1.0));

    float oa = cov * a;
    if (oa < 0.002) discard;
#ifdef JLINE_PREMULTIPLIED
    frag = vec4(col * oa, oa);  // premultiplied — compositing into a premultiplied target (the turf RT)
#else
    frag = vec4(col, oa);       // straight alpha — Jaui's renderer blends src-alpha over the scene
#endif
}
