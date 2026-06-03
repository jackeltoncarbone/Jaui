// GLSL ES 3.00 chunk concatenated into the panel/glass fragment shaders.
// Mechanical port of the 2D shape SDF from Source/Core/Shaders/Panel.wgsl
// (smoothness_to_exponent, pick_rect_radius, shape_mode, ss_pill_sdf,
// shape_sdf_inner, shape_sdf). Provides the 2D cross-section shape
// (Rect superellipse / SS-Pill / Circle) consumed by both the 2D panel
// renderer and the 3D slab extrusion.

export const SHAPE_SDF_GLSL: string = `
const int SS_PILL_POINT_COUNT = 33;
const float SS_PILL_MAXEXTENT = 1.6236;

const vec2 SS_PILL_CURVE[33] = vec2[33](
  vec2(0.000000, 1.000000), vec2(0.071905, 0.999903), vec2(0.141683, 0.999227),
  vec2(0.209303, 0.997390), vec2(0.274729, 0.993813), vec2(0.337929, 0.987916),
  vec2(0.398867, 0.979119), vec2(0.457512, 0.966841), vec2(0.513828, 0.950503),
  vec2(0.567783, 0.929525), vec2(0.619341, 0.903327), vec2(0.668471, 0.871328),
  vec2(0.715137, 0.832948), vec2(0.759307, 0.787608), vec2(0.800946, 0.734728),
  vec2(0.840021, 0.673727), vec2(0.874726, 0.607726), vec2(0.889889, 0.574476),
  vec2(0.904073, 0.540309), vec2(0.917279, 0.505288), vec2(0.929507, 0.469473),
  vec2(0.940756, 0.432925), vec2(0.951027, 0.395705), vec2(0.960321, 0.357875),
  vec2(0.968635, 0.319495), vec2(0.975972, 0.280627), vec2(0.982330, 0.241331),
  vec2(0.987711, 0.201669), vec2(0.992113, 0.161702), vec2(0.995536, 0.121490),
  vec2(0.997982, 0.081095), vec2(0.999449, 0.040578), vec2(0.999938, 0.000000)
);

float smoothnessToExponent(float sIn) {
  float s = clamp(sIn, 0.0, 1.0);
  return 2.0 + 6.0 * s;
}

float pickRectRadius(vec2 p, vec4 radii) {
  // radii = (tl, tr, br, bl)
  if (p.x >= 0.0) {
    return (p.y <= 0.0) ? radii.y : radii.z;
  }
  return (p.y <= 0.0) ? radii.x : radii.w;
}

// Shape classification: 0=Rect (superellipse), 1=Pill (SS polyline), 2=Circle (ellipse).
int shapeMode(vec2 halfSize, vec4 radii) {
  float minHalf = min(halfSize.x, halfSize.y);
  float maxHalf = max(halfSize.x, halfSize.y);
  float aspect = maxHalf / max(minHalf, 0.0001);
  float minRadius = min(min(radii.x, radii.y), min(radii.z, radii.w));
  if (aspect < 1.43 && minRadius >= minHalf * 0.9) { return 2; }
  if (aspect >= 1.7 && minRadius >= minHalf - 1.0) { return 1; }
  return 0;
}

// SS Pill polyline SDF-only entry. Single-pass min-distance scan with
// bracketing segment to determine inside/outside sign.
float ssPillSdf(vec2 p, vec2 halfSize) {
  bool horiz = halfSize.x >= halfSize.y;
  vec2 q = horiz ? abs(p) : abs(p.yx);
  vec2 hs = horiz ? halfSize : halfSize.yx;
  float halfY = hs.y;
  float halfX = hs.x;
  float maxExtent = SS_PILL_MAXEXTENT * halfY;
  float flatStart = halfX - maxExtent;

  if (q.x <= flatStart) { return q.y - halfY; }

  vec2 qL = vec2(q.x - flatStart, q.y);
  float minDSq = 1e9;
  float uB = -1.0;
  bool bracketFound = false;

  for (int i = 0; i < SS_PILL_POINT_COUNT - 1; i++) {
    vec2 a = vec2(SS_PILL_CURVE[i].x * maxExtent, SS_PILL_CURVE[i].y * halfY);
    vec2 b = vec2(SS_PILL_CURVE[i + 1].x * maxExtent, SS_PILL_CURVE[i + 1].y * halfY);
    vec2 ab = b - a;
    vec2 ap = qL - a;
    float t = clamp(dot(ap, ab) / dot(ab, ab), 0.0, 1.0);
    vec2 closest = a + t * ab;
    vec2 d = qL - closest;
    minDSq = min(minDSq, dot(d, d));
    if (!bracketFound && qL.y <= a.y && qL.y >= b.y) {
      float dv = a.y - b.y;
      float tb = (dv > 0.0001) ? (a.y - qL.y) / dv : 0.0;
      uB = mix(a.x, b.x, tb);
      bracketFound = true;
    }
  }
  float uDist = sqrt(minDSq);
  bool inside = qL.y <= halfY && uB > 0.0 && qL.x <= uB;
  return inside ? -uDist : uDist;
}

// Master SDF inner (superellipse corner).
float shapeSdfInner(vec2 p, vec2 halfSize, vec2 rAxis, float n) {
  vec2 q = abs(p) - halfSize + rAxis;
  if (q.x <= 0.0 && q.y <= 0.0) {
    return -min(halfSize.x - abs(p.x), halfSize.y - abs(p.y));
  }
  vec2 qc = max(q, vec2(0.0));
  vec2 uv = qc / rAxis;
  vec2 uvE = max(uv, vec2(1e-5));
  float un = pow(uvE.x, n);
  float vn = pow(uvE.y, n);
  float bigL = pow(un + vn, 1.0 / n);
  float nm1 = n - 1.0;
  float gx = pow(uvE.x, nm1) / rAxis.x;
  float gy = pow(uvE.y, nm1) / rAxis.y;
  float lfactor = pow(bigL, 1.0 - n);
  float gradLen = lfactor * sqrt(gx * gx + gy * gy);
  return (bigL - 1.0) / max(gradLen, 1e-5);
}

// Unified SDF dispatch.
float shapeSdf(vec2 p, vec2 halfSize, vec4 radii, float smoothness, int mode) {
  if (mode == 1) { return ssPillSdf(p, halfSize); }
  vec2 rAxis;
  float n;
  if (mode == 2) {
    rAxis = halfSize;
    n = 2.0;
  } else {
    float r = min(pickRectRadius(p, radii), min(halfSize.x, halfSize.y));
    rAxis = vec2(r);
    n = smoothnessToExponent(smoothness);
  }
  return shapeSdfInner(p, halfSize, rAxis, n);
}

// Convenience: auto-select the shape mode, then evaluate the 2D cross-section.
float shapeSdf2D(vec2 p, vec2 halfSize, vec4 radii, float smoothness) {
  return shapeSdf(p, halfSize, radii, smoothness, shapeMode(halfSize, radii));
}

// == 3D slab ==================================================================
// Extrude the 2D cross-section through Z by halfDepth, rounding the four edge
// rings (where the face meets the side wall) by fillet. Canonical
// round-the-edges-of-an-extruded-2D-SDF construction:
//
//   d2   = cross-section SDF in the XY plane (negative inside, + outside)
//   dz   = abs(p.z) - halfDepth                (slab along Z)
//   With fillet f: shrink both fields by f, combine, then re-add f so the
//   join is a quarter-round of radius f instead of a hard corner.
//
// PARITY INVARIANT: halfDepth == 0 and fillet == 0  ->  returns exactly d2
// (the p.z term is 0 inside, the fillet math is identity), so 2D output is
// pixel-identical to shapeSdf2D. Depth/fillet only change pixels when nonzero.
//
// p is in the slab's local space, device-pixel units, origin at slab center,
// +z toward the viewer. halfSize/radii/smoothness define the XY cross-section.
float slabSdf(
  vec3 p, vec2 halfSize, float halfDepth, vec4 radii, float smoothness, float fillet
) {
  float d2 = shapeSdf2D(p.xy, halfSize, radii, smoothness);
  float dz = abs(p.z) - halfDepth;

  if (fillet <= 0.0) {
    // Sharp extrusion: standard 2D-SDF → 3D prism.
    vec2 w = vec2(d2, dz);
    return min(max(d2, dz), 0.0) + length(max(w, vec2(0.0)));
  }

  // CLAMP the fillet to what the geometry can hold: it can never exceed the
  // side-normal radius (halfDepth — the slab's half-thickness) or eat the
  // corner radius. An over-large fillet would over-inset the cross-section and
  // visibly shrink/distort the SILHOUETTE — which must stay invariant under
  // depth/fillet. So fillet is bounded; the 2D outline never moves.
  float minCornerR = min(min(radii.x, radii.y), min(radii.z, radii.w));
  float f = min(fillet, min(halfDepth, max(minCornerR, 0.0)));
  if (f <= 0.0) {
    vec2 w0 = vec2(d2, dz);
    return min(max(d2, dz), 0.0) + length(max(w0, vec2(0.0)));
  }

  // Filleted edges: inset both fields by fillet, round-combine, re-offset.
  vec2 w = vec2(d2 + f, dz + f);
  float outside = length(max(w, vec2(0.0)));
  float inside  = min(max(w.x, w.y), 0.0);
  return outside + inside - f;
}
`;

// Clip-stack test — separate chunk because it needs a clip-buffer sampler that
// only the panel/text fragment shaders declare. Concatenate AFTER SHAPE_SDF_GLSL.
// Mirrors Panel.wgsl inside_clip_shape / inside_clip_stack: each clip is 3 texels
// (rect.xyzw, radii.xyzw, (smoothness,_,_,_)) fetched from u_ClipBuf by entry index.
//
// Requires the shader to declare:  uniform sampler2D u_ClipBuf; uniform int u_ClipBufW;
export const CLIP_STACK_GLSL: string = `
vec4 fetchClip(int entry, int comp, sampler2D buf, int bufW) {
  int texel = entry * 3 + comp;   // 3 texels per clip entry
  int x = texel % bufW;
  int y = texel / bufW;
  return texelFetch(buf, ivec2(x, y), 0);
}

bool insideClipShape(vec2 pixel, vec4 rect, vec4 radii, float smoothness) {
  vec2 center = rect.xy + rect.zw * 0.5;
  vec2 halfSize = rect.zw * 0.5;
  vec2 q = pixel - center;
  vec2 qa = abs(q);
  if (qa.x > halfSize.x || qa.y > halfSize.y) return false;
  float r = pickRectRadius(q, radii);
  vec2 cp = qa - (halfSize - vec2(r));
  if (r <= 0.0 || cp.x <= 0.0 || cp.y <= 0.0) return true;
  float n = smoothnessToExponent(smoothness);
  float L = pow(cp.x / r, n) + pow(cp.y / r, n);
  return L <= 1.0;
}

// Returns coverage in [0,1] — 1 inside all clips, 0 outside any. Hard test
// (matches the panel's WGSL hard discard); AA at clip edges is left to the
// shape's own fill AA which already feathers the painted edge.
float clipCoverage(vec2 pixel, int offset, int count, sampler2D buf, int bufW) {
  for (int i = 0; i < count; i++) {
    vec4 rect  = fetchClip(offset + i, 0, buf, bufW);
    vec4 radii = fetchClip(offset + i, 1, buf, bufW);
    vec4 meta  = fetchClip(offset + i, 2, buf, bufW);
    if (!insideClipShape(pixel, rect, radii, meta.x)) return 0.0;
  }
  return 1.0;
}
`;
