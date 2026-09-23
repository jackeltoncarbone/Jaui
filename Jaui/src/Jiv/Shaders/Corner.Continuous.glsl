// ── THE CONTINUOUS CORNER: the one corner model every rounded shape in Jaui draws with ───────────────
//
// Apple has one corner model, the continuous-corner rounded rectangle (UIKit's cornerCurve
// .continuous, SwiftUI's RoundedRectangle(style: .continuous)); a capsule is the same model at radius
// half the short side. This is it, as figma-squircle builds it: each corner is a circular arc of
// radius r, eased into each of its two edges by a cubic that starts (1 + s) r from the corner, s the
// corner smoothing. iOS is 0.6; the per-side model below fits the measured pill at 0.595 and Apple's
// Safari URL pill (native 3x) to a fifth of a pixel.
//
// When an edge is too short for the easing, the easing on THAT side gives way: its smoothing falls to
// what the side allows, (half its length / r) - 1, down to 0, a plain arc. So a capsule keeps its
// long-side easing and loses its short-side one, and a square at r = side / 2 is a circle. It is
// figma-squircle's limited-space rule applied per side rather than once per shape, because that is
// what Apple's measured capsule is. A radius never exceeds the short half side.
//
// Distance: the straight edges and the arc are exact; each easing cubic is walked as a polyline of
// CORNER_EASE_STEPS segments. The corner is convex, so the nearest feature's inward side is the sign.

const int CORNER_EASE_STEPS = 8;

// One side's easing into the arc, for radius r and that side's smoothing s, in the corner's inward
// frame measured along the side: it leaves the edge `extent` from the corner and meets the arc at
// angle `alpha`, through the control points `a` and `a + b` along the edge.
void CornerEase(float r, float s, float extent, out float alpha, out float a, out float b, out vec2 meet) {
    alpha = radians(45.0 * s);
    float c = r * tan(alpha * 0.5) * cos(alpha);
    float d = r * (1.0 - cos(alpha));
    b = (extent - r * (1.0 - sin(alpha)) - c) / 3.0;
    a = 2.0 * b;
    meet = vec2(r * (1.0 - sin(alpha)), d);
}

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

// Signed distance (negative inside, device px) from `p`, taken from the shape's centre, to the
// continuous-cornered box of half size `halfSize`, per-corner radii (tl, tr, br, bl) and smoothing
// `smoothing`; `outward` is the outward unit vector there.
float ContinuousCorner(vec2 p, vec2 halfSize, vec4 radii, float smoothing, out vec2 outward) {
    vec2 q = abs(p);
    vec2 facing = vec2(p.x < 0.0 ? -1.0 : 1.0, p.y < 0.0 ? -1.0 : 1.0);
    float r = p.x >= 0.0 ? (p.y <= 0.0 ? radii.y : radii.z) : (p.y <= 0.0 ? radii.x : radii.w);
    r = clamp(r, 0.0, min(halfSize.x, halfSize.y));
    // Inward from the side edge (x) and from the top or bottom edge (y).
    vec2 w = halfSize - q;
    if (r < 1e-3) {
        vec2 outside = max(-w, vec2(0.0));
        float d = length(outside) + min(max(-w.x, -w.y), 0.0);
        outward = (w.x < w.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0)) * facing;
        if (d > 0.0 && length(outside) > 0.0) outward = CornerUnit(outside) * facing;
        return d;
    }
    float s = clamp(smoothing, 0.0, 1.0);
    // Each side's easing, limited by its own half edge: the top edge's runs along x, the side's along y.
    vec2 extent = min(vec2((1.0 + s) * r), halfSize);
    vec2 sides = max(extent / r - 1.0, vec2(0.0));
    if (w.x >= extent.x && w.y >= extent.y) {
        outward = (w.x < w.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0)) * facing;
        return -min(w.x, w.y);
    }

    float best = 1e20;
    vec2 bestPoint = w;
    vec2 bestInward = vec2(0.0, 1.0);
    // The straight edges, from where each easing leaves them.
    CornerNearest(w, vec2(extent.x, 0.0), vec2(extent.x + 1e5, 0.0), vec2(0.0, 1.0), best, bestPoint, bestInward);
    CornerNearest(w, vec2(0.0, extent.y), vec2(0.0, extent.y + 1e5), vec2(1.0, 0.0), best, bestPoint, bestInward);

    float alphaX, aX, bX; vec2 meetX;
    CornerEase(r, sides.x, extent.x, alphaX, aX, bX, meetX);
    float alphaY, aY, bY; vec2 meetY;
    CornerEase(r, sides.y, extent.y, alphaY, aY, bY, meetY);

    // The arc between the two easings, exact.
    vec2 centre = vec2(r);
    vec2 fromCentre = w - centre;
    float reach = length(fromCentre);
    float angle = atan(-fromCentre.x, -fromCentre.y);
    if (reach > 1e-5 && angle >= alphaX && angle <= radians(90.0) - alphaY) {
        vec2 point = centre + fromCentre / reach * r;
        vec2 off = w - point;
        float d2 = dot(off, off);
        if (d2 < best) { best = d2; bestPoint = point; bestInward = -fromCentre / reach; }
    }

    // The top edge's easing: from (extent.x, 0) through the two control points on the edge to the arc.
    vec2 x0 = vec2(extent.x, 0.0), x1 = vec2(extent.x - aX, 0.0), x2 = vec2(extent.x - aX - bX, 0.0);
    vec2 x3 = meetX;
    // The side's easing, mirrored across the diagonal.
    vec2 y0 = vec2(0.0, extent.y), y1 = vec2(0.0, extent.y - aY), y2 = vec2(0.0, extent.y - aY - bY);
    vec2 y3 = meetY.yx;
    vec2 prevX = x0, prevY = y0;
    for (int i = 1; i <= CORNER_EASE_STEPS; i++) {
        float t = float(i) / float(CORNER_EASE_STEPS);
        float u = 1.0 - t;
        vec2 nextX = u * u * u * x0 + 3.0 * u * u * t * x1 + 3.0 * u * t * t * x2 + t * t * t * x3;
        vec2 nextY = u * u * u * y0 + 3.0 * u * u * t * y1 + 3.0 * u * t * t * y2 + t * t * t * y3;
        vec2 spanX = nextX - prevX, spanY = nextY - prevY;
        CornerNearest(w, prevX, nextX, CornerUnit(vec2(spanX.y, -spanX.x)), best, bestPoint, bestInward);
        CornerNearest(w, prevY, nextY, CornerUnit(vec2(-spanY.y, spanY.x)), best, bestPoint, bestInward);
        prevX = nextX; prevY = nextY;
    }

    float d = sqrt(best);
    bool inside = dot(w - bestPoint, bestInward) >= 0.0;
    // Outward in the shape's own frame: the inward side in `w` points out in `q`.
    outward = bestInward * facing;
    return inside ? -d : d;
}
