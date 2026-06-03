/**
 * Exact 2D Euclidean Signed Distance Transform (8SSEDT).
 *
 * 8SSEDT = "8-points Signed Sequential Euclidean Distance Transform"
 * (Danielsson 1980, Grevera). It computes, for every pixel, the offset
 * vector to the nearest pixel of the opposite region by propagating
 * candidate offsets across the grid in two sweeps. The transform is exact:
 * each cell ends up holding the true nearest-boundary offset.
 *
 * Pure TypeScript, no DOM, no deps.
 */

const _far = 9999;

interface Point {
  dx: number;
  dy: number;
}

interface Grid {
  pts: Point[];
  w: number;
  h: number;
}

const _get = (g: Grid, x: number, y: number): Point => {
  if (x < 0 || y < 0 || x >= g.w || y >= g.h) return { dx: _far, dy: _far };
  return g.pts[y * g.w + x];
};

const _put = (g: Grid, x: number, y: number, p: Point): void => {
  g.pts[y * g.w + x] = p;
};

const _sq = (p: Point): number => p.dx * p.dx + p.dy * p.dy;

// Compare an offset reached via a neighbor (its offset + the step taken to
// reach this cell) against the current best; keep the shorter.
const _compare = (g: Grid, cur: Point, x: number, y: number, ox: number, oy: number): Point => {
  const other = _get(g, x + ox, y + oy);
  const cand: Point = { dx: other.dx + ox, dy: other.dy + oy };
  return _sq(cand) < _sq(cur) ? cand : cur;
};

const _propagate = (g: Grid): void => {
  // Pass 1: top-left -> bottom-right.
  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      let p = _get(g, x, y);
      p = _compare(g, p, x, y, -1, 0);
      p = _compare(g, p, x, y, 0, -1);
      p = _compare(g, p, x, y, -1, -1);
      p = _compare(g, p, x, y, 1, -1);
      _put(g, x, y, p);
    }
    for (let x = g.w - 1; x >= 0; x--) {
      let p = _get(g, x, y);
      p = _compare(g, p, x, y, 1, 0);
      _put(g, x, y, p);
    }
  }
  // Pass 2: bottom-right -> top-left.
  for (let y = g.h - 1; y >= 0; y--) {
    for (let x = g.w - 1; x >= 0; x--) {
      let p = _get(g, x, y);
      p = _compare(g, p, x, y, 1, 0);
      p = _compare(g, p, x, y, 0, 1);
      p = _compare(g, p, x, y, 1, 1);
      p = _compare(g, p, x, y, -1, 1);
      _put(g, x, y, p);
    }
    for (let x = 0; x < g.w; x++) {
      let p = _get(g, x, y);
      p = _compare(g, p, x, y, -1, 0);
      _put(g, x, y, p);
    }
  }
};

/**
 * Convert an alpha-coverage bitmap into a single-channel signed distance field,
 * encoded to 0..255 bytes where 128 = the glyph edge (coverage 0.5 isovalue),
 * >128 = inside, <128 = outside. `spread` is the max distance (in source px)
 * mapped to the 0..255 range — distances beyond ±spread clamp. A larger spread
 * gives smoother scaling but coarser near-edge precision; ~ 8-16px is typical.
 *
 * @param alpha  Uint8ClampedArray|Uint8Array of length w*h, coverage 0..255
 *               (e.g. the alpha channel of a canvas ImageData).
 * @param w, h   bitmap dimensions
 * @param spread max signed distance (source px) encoded; default 8
 * @returns      Uint8Array length w*h, the SDF (128 = edge)
 */
export function ComputeSdf(
  alpha: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  spread = 8
): Uint8Array {
  const count = w * h;

  // Grid A tracks the nearest INSIDE pixel (seeded on inside cells),
  // Grid B tracks the nearest OUTSIDE pixel (seeded on outside cells).
  const inside: Grid = { pts: new Array<Point>(count), w, h };
  const outside: Grid = { pts: new Array<Point>(count), w, h };

  for (let i = 0; i < count; i++) {
    const isInside = alpha[i] >= 128;
    if (isInside) {
      inside.pts[i] = { dx: 0, dy: 0 };
      outside.pts[i] = { dx: _far, dy: _far };
    } else {
      inside.pts[i] = { dx: _far, dy: _far };
      outside.pts[i] = { dx: 0, dy: 0 };
    }
  }

  _propagate(inside);
  _propagate(outside);

  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    // Distance to nearest inside pixel and to nearest outside pixel.
    const dIn = Math.sqrt(_sq(inside.pts[i]));
    const dOut = Math.sqrt(_sq(outside.pts[i]));

    // Inside pixels: distance to the boundary is the distance to the nearest
    // OUTSIDE pixel (positive). Outside pixels: distance to the nearest INSIDE
    // pixel (negative). Subtracting yields the signed field, inside positive.
    const signedDist = alpha[i] >= 128 ? dOut : -dIn;

    const norm = (signedDist / spread) * 0.5 + 0.5;
    out[i] = Math.max(0, Math.min(255, Math.round(norm * 255)));
  }

  return out;
}

/** Decode an SDF byte back to signed distance in source px given spread. */
export function DecodeSdf(byte: number, spread: number): number {
  return (byte / 255 - 0.5) * 2 * spread;
}
