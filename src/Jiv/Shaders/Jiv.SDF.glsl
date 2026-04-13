// Superellipse signed distance field.
// Negative = inside, positive = outside.
// Folds into first quadrant for seamless corners.

float SuperellipseSDF(vec2 p, vec2 halfSize, vec4 radii, float smoothness) {
    // Select corner radius based on quadrant
    //   radii: (topLeft, topRight, bottomRight, bottomLeft)
    float r = p.x >= 0.0
        ? (p.y <= 0.0 ? radii.y : radii.z)   // right: top-right or bottom-right
        : (p.y <= 0.0 ? radii.x : radii.w);   // left:  top-left or bottom-left

    r = min(r, min(halfSize.x, halfSize.y));

    float n = 2.0 + 3.0 * smoothness;

    vec2 q = abs(p) - halfSize + r;

    if (q.x <= 0.0 && q.y <= 0.0) {
        // Inside flat region — distance to nearest straight edge
        return -min(halfSize.x - abs(p.x), halfSize.y - abs(p.y));
    }

    float qxn = pow(max(q.x, 0.0), n);
    float qyn = pow(max(q.y, 0.0), n);
    float dist = pow(qxn + qyn, 1.0 / n);
    return dist - r;
}
