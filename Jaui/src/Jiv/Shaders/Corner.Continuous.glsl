// ── THE CONTINUOUS CORNER: the one corner model every rounded shape in Jaui draws with ───────────────
//
// Apple's, exactly: the continuous corner as SwiftUI's renderer builds it (RenderBox
// `RB::Path::Mapper::add_rounded_rect`), which at full room is QuartzCore's and CoreGraphics' continuous
// corner (Jwift/Apple/LiquidGlass.md 10). Each corner is three cubics, in multiples of r from its vertex:
//   the lead-in along one edge: (lead, 0), (cp1, 0), (cp2, 0) to (0.631494, 0.0749114);
//   the fixed middle: (0.372824, 0.16906), (0.16906, 0.372824) to (0.0749114, 0.631494);
//   the lead-in along the other edge, mirrored.
// Each edge's lead-in follows that edge's room, t = sat((side - (ra + rb)) / ((ra + rb) 0.52866)), ra and rb
// its two corner radii: lead = 1 + 0.528665 t, cp1 = 0.96 + 0.12849 t, cp2 = 0.82 + 0.048407 t. With full
// room the curve leaves the edge 1.528665 r from the vertex; a capsule's short edge (t = 0) leaves at r.
// A radius never exceeds the short half side. Smoothing 0 is Apple's other curve, the circular corner.
//
// Distance: the straight edges are exact; each cubic is walked as a polyline of CORNER_EASE_STEPS segments.
// The corner is convex, so the nearest feature's inward side is the sign.

const int CORNER_EASE_STEPS = 12;

// A unit vector along `v`.
vec2 CornerUnit(vec2 v) {
    return v * inversesqrt(max(dot(v, v), 1e-18));
}

// Keep the nearer of the current best and the segment from `from` to `to`, with the side of it that
// faces into the shape.
void CornerNearest(vec2 w, vec2 from, vec2 to, vec2 inward, inout float best, inout vec2 bestPoint,
                   inout vec2 bestInward) {
    vec2 span = to - from;
    float t = clamp(dot(w - from, span) / max(dot(span, span), 1e-12), 0.0, 1.0);
    vec2 point = from + span * t;
    vec2 off = w - point;
    float d2 = dot(off, off);
    if (d2 < best) { best = d2; bestPoint = point; bestInward = inward; }
}

// One edge's room for the continuous lead-in (RenderBox): 0 at a capsule, 1 with the full 1.528665 r.
float CornerRoom(float side, float rSum) {
    return rSum > 1e-3 ? clamp((side - rSum) / (rSum * 0.52866), 0.0, 1.0) : 1.0;
}

// Walk one cubic, in the corner's inward frame, keeping the nearest segment.
void CornerCubic(vec2 w, vec2 a, vec2 b, vec2 c, vec2 d, inout float best, inout vec2 bestPoint, inout vec2 bestInward) {
    vec2 prev = a;
    for (int i = 1; i <= CORNER_EASE_STEPS; i++) {
        float t = float(i) / float(CORNER_EASE_STEPS);
        float u = 1.0 - t;
        vec2 next = u * u * u * a + 3.0 * u * u * t * b + 3.0 * u * t * t * c + t * t * t * d;
        vec2 span = next - prev;
        CornerNearest(w, prev, next, CornerUnit(vec2(span.y, -span.x)), best, bestPoint, bestInward);
        prev = next;
    }
}

// Signed distance (negative inside, device px) from `p`, taken from the shape's centre, to the
// continuous-cornered box of half size `halfSize` and per-corner radii (tl, tr, br, bl); `outward` is the
// outward unit vector there. `smoothing` 0 draws Apple's circular corner instead.
float ContinuousCorner(vec2 p, vec2 halfSize, vec4 radii, float smoothing, out vec2 outward) {
    vec2 q = abs(p);
    vec2 facing = vec2(p.x < 0.0 ? -1.0 : 1.0, p.y < 0.0 ? -1.0 : 1.0);
    float cap = min(halfSize.x, halfSize.y);
    radii = clamp(radii, vec4(0.0), vec4(cap));
    float r = p.x >= 0.0 ? (p.y <= 0.0 ? radii.y : radii.z) : (p.y <= 0.0 ? radii.x : radii.w);
    // This corner's neighbours along its horizontal and its vertical edge.
    float rAcross = p.x >= 0.0 ? (p.y <= 0.0 ? radii.x : radii.w) : (p.y <= 0.0 ? radii.y : radii.z);
    float rDown = p.x >= 0.0 ? (p.y <= 0.0 ? radii.z : radii.y) : (p.y <= 0.0 ? radii.w : radii.x);
    // Inward from the side edge (x) and from the top or bottom edge (y).
    vec2 w = halfSize - q;
    if (r < 1e-3 || smoothing <= 0.0) {
        vec2 v = vec2(r) - w;
        vec2 outside = max(v, vec2(0.0));
        float d = length(outside) + min(max(v.x, v.y), 0.0) - r;
        outward = (w.x < w.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0)) * facing;
        if (length(outside) > 0.0) outward = CornerUnit(outside) * facing;
        return d;
    }
    // x runs along the top edge (its room from the width), y down the side (its room from the height).
    vec3 alongTop = vec3(1.0, 0.96, 0.82) + vec3(0.528665, 0.12849003, 0.048407) * CornerRoom(2.0 * halfSize.x, r + rAcross);
    vec3 alongSide = vec3(1.0, 0.96, 0.82) + vec3(0.528665, 0.12849003, 0.048407) * CornerRoom(2.0 * halfSize.y, r + rDown);
    vec2 extent = vec2(alongTop.x, alongSide.x) * r;
    if (w.x >= extent.x && w.y >= extent.y) {
        outward = (w.x < w.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0)) * facing;
        return -min(w.x, w.y);
    }

    float best = 1e20;
    vec2 bestPoint = w;
    vec2 bestInward = vec2(0.0, 1.0);
    // The straight edges, from where each lead-in leaves them.
    CornerNearest(w, vec2(extent.x, 0.0), vec2(extent.x + 1e5, 0.0), vec2(0.0, 1.0), best, bestPoint, bestInward);
    CornerNearest(w, vec2(0.0, extent.y), vec2(0.0, extent.y + 1e5), vec2(1.0, 0.0), best, bestPoint, bestInward);
    // From the top edge round to the side: lead-in, the fixed middle, lead-in.
    vec2 m0 = vec2(0.631493986, 0.0749114007) * r, m1 = vec2(0.372824013, 0.169060007) * r;
    vec2 m2 = vec2(0.169060007, 0.372824013) * r, m3 = vec2(0.0749114007, 0.631493986) * r;
    CornerCubic(w, vec2(extent.x, 0.0), vec2(alongTop.y * r, 0.0), vec2(alongTop.z * r, 0.0), m0, best, bestPoint, bestInward);
    CornerCubic(w, m0, m1, m2, m3, best, bestPoint, bestInward);
    CornerCubic(w, m3, vec2(0.0, alongSide.z * r), vec2(0.0, alongSide.y * r), vec2(0.0, extent.y), best, bestPoint, bestInward);

    float d = sqrt(best);
    bool inside = dot(w - bestPoint, bestInward) >= 0.0;
    // Outward in the shape's own frame: the inward side in `w` points out in `q`.
    outward = bestInward * facing;
    return inside ? -d : d;
}
