/**
 * `?glass-skip` -- THE GLASS CARD DRAW, PRICED STAGE BY STAGE.
 *
 * The 0.5-2 ms interval class on `glass-grid` (twenty per render, ~0.54 ms each, 12.8 of 14.1 ms of
 * union busy on the M4) is the twenty glass card draws, and no lever of the pyramid phase touched
 * them. This file is the arm that does: the stage table the shader's `u_GlassSkip` bits are named
 * from, the flag's parse, and the FRAGMENT CENSUS that gives the Mac's per-fragment reading a
 * denominator.
 *
 * Pure arithmetic, no GL, for the reason `Scene.Ledger` and `Border.Direct` are their own modules:
 * it can be unit-tested without the renderer's shader imports.
 */

/** The shader's bits, by name. `Jiv.Panel.frag` declares the same ten `GLASS_SKIP_*` constants and
 *  `tests/Glass.Skip.test.ts` reads that file and holds the two tables to each other. */
export const GLASS_SKIP_STAGES = {
  backdrop: 1,
  ca: 2,
  rim: 4,
  specular: 8,
  border: 16,
  sdf: 32,
  grade: 64,
  shadow: 128,
  skirt: 256,
  clip: 512,
} as const;
export type GlassSkipStage = keyof typeof GLASS_SKIP_STAGES;
export const GLASS_SKIP_ALL = Object.values(GLASS_SKIP_STAGES).reduce((a, b) => a | b, 0);

/** The stage names a mask carries, in table order. */
export const GlassSkipNames = (mask: number): GlassSkipStage[] =>
  (Object.keys(GLASS_SKIP_STAGES) as GlassSkipStage[]).filter((k) => (mask & GLASS_SKIP_STAGES[k]) !== 0);

/**
 * `?glass-skip=<stage>[,<stage>...] | all | none | off`, to a mask, or `null` for unarmed.
 *
 * `none` ARMS the flag with mask 0: the same program, the same uniform value and the same pixels as
 * the unflagged engine, with the census on. It is the one-binary CONTROL every stage arm is read
 * against, because it is the only arm that prints the denominator at zero cost to the GPU. `off`
 * (or the flag absent) is today's engine with no census. Anything else is a comma list of names,
 * and an unknown name throws BY NAME -- a typo that armed a partial mask would be priced as the
 * mask it was meant to be.
 */
export const ParseGlassSkip = (raw: string): number | null => {
  const v = raw.trim();
  if (v === 'off') return null;
  if (v === 'none') return 0;
  if (v === 'all' || v === '') return GLASS_SKIP_ALL;
  let mask = 0;
  for (const part of v.split(',')) {
    const name = part.trim();
    if (!(name in GLASS_SKIP_STAGES)) {
      throw new Error(`[Jaui] ?glass-skip: unknown stage '${name}' (stages: `
        + `${Object.keys(GLASS_SKIP_STAGES).join(', ')}, or all / none / off)`);
    }
    mask |= GLASS_SKIP_STAGES[name as GlassSkipStage];
  }
  return mask;
};

// ── THE FRAGMENT CENSUS ─────────────────────────────────────────────────────────────────────────

/**
 * Per glass fragment, what it pays, summed over every glass draw in a frame.
 *
 * Counted by walking EVERY pixel centre of the instance's quad through a CPU port of the shader's
 * own gates -- the corner field's distance and normal, the bezel hump, the rim band, the border
 * annulus, the rim-specular band -- so the numbers are the shader's branches evaluated, not an
 * area formula. Float64 where the GPU runs float32, so a pixel sitting on a gate's edge can land on
 * the other side; that moves a count by the perimeter's worth of pixels at most.
 */
export interface GlassFragCensus {
  /** Instances counted (one per quad); 3D instances are in `Projective` and not walked. */
  Instances: number;
  /** Fragments the quads rasterise: where the PROGRAM runs, discarded or not. */
  Frags: number;
  /** `fillAlpha > 0` (dist < 0.5): inside the face's silhouette. */
  Face: number;
  /** The wide rim glow's band on a FILL draw (`dist > -max(0.75*bezel, 6)`, inside the face). */
  Band: number;
  /** The border annulus (`borderBase > 0.001`), where the border zone's tap runs. */
  Border: number;
  /** `dist >= 0.5`: outside the face -- the shadow skirt. */
  Skirt: number;
  /** Skirt fragments the `skirt` arm discards (outside the face's padded BOX). The rest of the
   *  skirt is the corner pockets between the superellipse and the box, which still run. */
  Cut: number;
  /** Fragments taking the 3-tap chromatic fill path. */
  Ca3: number;
  /** Backdrop taps under the ARMED mask. */
  Taps: number;
  /** Backdrop taps with no stage skipped: the same frame's unflagged count. */
  TapsFull: number;
  /** Clip-stack texel fetches (three per clip per fragment, paid before the clip's discard). */
  ClipFetches: number;
  /** Instances on the corner field's pill or blend leg, counted with the superellipse leg's
   *  distance (the polyline pill is not ported). 0 on `glass-grid`. */
  PillApprox: number;
  /** 3D (projective) instances: their quad is a projected natural box and is not walked. */
  Projective: number;
}

export const EmptyGlassFragCensus = (): GlassFragCensus => ({
  Instances: 0, Frags: 0, Face: 0, Band: 0, Border: 0, Skirt: 0, Cut: 0, Ca3: 0,
  Taps: 0, TapsFull: 0, ClipFetches: 0, PillApprox: 0, Projective: 0,
});

export const AddGlassFragCensus = (into: GlassFragCensus, c: GlassFragCensus): void => {
  for (const k of Object.keys(into) as (keyof GlassFragCensus)[]) into[k] += c[k];
};

/** Offsets into one packed panel instance (`Jiv.InstanceBuffer.Push`). */
const O = {
  RectX: 0, RectY: 1, RectW: 2, RectH: 3, Cos: 4, Sin: 5, HalfW: 6, HalfH: 7, Radii: 8,
  BorderWidth: 27, EdgeAa: 28, Smooth: 29, Thickness: 36, Bezel: 37, BezelScale: 39,
  LightAngle: 40, SpecIntensity: 44, Ca: 46, SpecPacked: 47, BorderVariance: 50, ClipCount: 55,
} as const;

const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** `ShapeSDF_inner` and `ShapeGrad_inner`, the superellipse leg of the corner field. */
const superellipse = (px: number, py: number, hx: number, hy: number, r: number, n: number,
                      out: Float64Array): void => {
  const rr = Math.max(r, 1e-3);
  const qx = Math.abs(px) - hx + rr;
  const qy = Math.abs(py) - hy + rr;
  const ux = Math.max(Math.max(qx, 0) / rr, 1e-5);
  const uy = Math.max(Math.max(qy, 0) / rr, 1e-5);
  const nm1 = n - 1;
  const gx = Math.sign(px) * Math.pow(ux, nm1) / rr;
  const gy = Math.sign(py) * Math.pow(uy, nm1) / rr;
  const gLen = Math.hypot(gx, gy);
  if (gLen < 1e-4) {
    const dx = hx - Math.abs(px);
    const dy = hy - Math.abs(py);
    out[1] = dx < dy ? Math.sign(px) : 0;
    out[2] = dx < dy ? 0 : Math.sign(py);
  } else {
    out[1] = gx / gLen;
    out[2] = gy / gLen;
  }
  if (qx <= 0 && qy <= 0) {
    out[0] = -Math.min(hx - Math.abs(px), hy - Math.abs(py));
    return;
  }
  const L = Math.pow(Math.pow(ux, n) + Math.pow(uy, n), 1 / n);
  const gradLen = Math.pow(L, 1 - n) * Math.hypot(Math.pow(ux, nm1) / rr, Math.pow(uy, nm1) / rr);
  out[0] = (L - 1) / Math.max(gradLen, 1e-5);
};

/** `GlassRectEval`: the `sdf` arm's sharp rectangle. */
const sharpRect = (px: number, py: number, hx: number, hy: number, out: Float64Array): void => {
  const qx = Math.abs(px) - hx;
  const qy = Math.abs(py) - hy;
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  const lo = Math.hypot(ox, oy);
  out[0] = lo + Math.min(Math.max(qx, qy), 0);
  const gx = lo > 0 ? ox / lo : (qx > qy ? 1 : 0);
  const gy = lo > 0 ? oy / lo : (qx > qy ? 0 : 1);
  out[1] = px < 0 ? -gx : gx;
  out[2] = py < 0 ? -gy : gy;
};

const _cache = new Map<string, GlassFragCensus>();
const CACHE_MAX = 256;

/**
 * One glass instance's census under `mask`. Cached on every float the walk reads plus the quad's
 * sub-pixel phase, so a static page pays the walk once per distinct surface shape.
 */
export const GlassInstanceCensus = (d: Float32Array, b: number, mask: number): GlassFragCensus => {
  const c = EmptyGlassFragCensus();
  if (d[b + O.Cos] > 1.5) { c.Projective = 1; return c; }
  let key = String(mask);
  for (let i = 0; i < 60; i++) key += ',' + d[b + i];
  const hit = _cache.get(key);
  if (hit !== undefined) return hit;

  const x0 = d[b + O.RectX], y0 = d[b + O.RectY], w = d[b + O.RectW], h = d[b + O.RectH];
  const cos = d[b + O.Cos], sin = d[b + O.Sin];
  const hx = d[b + O.HalfW], hy = d[b + O.HalfH];
  const cxr = x0 + w * 0.5, cyr = y0 + h * 0.5;
  const radii = [d[b + O.Radii], d[b + O.Radii + 1], d[b + O.Radii + 2], d[b + O.Radii + 3]];
  const edgeAa = d[b + O.EdgeAa];
  const borderOnly = edgeAa < 0;
  const aa = Math.max(Math.abs(edgeAa), 1e-4);
  const bw = d[b + O.BorderWidth];
  const bezel = Math.max(d[b + O.Bezel], 0.5);
  const s = Math.max(d[b + O.BezelScale], 0.05);
  const ca = d[b + O.Ca];
  const thickness = d[b + O.Thickness];
  const specI = d[b + O.SpecIntensity];
  const variance = d[b + O.BorderVariance];
  const borderFade = Math.floor(d[b + O.SpecPacked] / 1024) / 4;
  const clipCount = d[b + O.ClipCount];
  const lx = Math.cos(d[b + O.LightAngle]), ly = -Math.sin(d[b + O.LightAngle]);
  const rimBand = Math.max(bezel * 0.75, 6);
  const glassiness = smoothstep(0, 1, thickness);
  const rimSpecW = Math.max(thickness * 0.18, 0.75 * glassiness);
  const pad = 2 + Math.abs(edgeAa);

  // `CornerParams`, whose regime is a function of the instance alone (only rCorner is per pixel).
  const smooth = d[b + O.Smooth];
  const minHalf = Math.min(hx, hy), maxHalf = Math.max(hx, hy);
  const aspect = maxHalf / Math.max(minHalf, 1e-4);
  const authoredR = Math.floor(smooth * 0.5) / 16;
  const smoothAmt = smooth - 2 * Math.floor(smooth * 0.5);
  const satBand = Math.max(minHalf * 0.12, 1);
  const sat = smoothstep(minHalf - satBand, minHalf - 1, authoredR);
  const elong = smoothstep(1.02, 1.10, aspect);
  const n = (2 + 6 * Math.min(1, Math.max(0, smoothAmt))) * (1 - sat * (1 - elong)) + 2 * sat * (1 - elong);
  if (sat * elong > 0) c.PillApprox = 1;
  c.Instances = 1;

  const skip = (stage: GlassSkipStage): boolean => (mask & GLASS_SKIP_STAGES[stage]) !== 0;
  const ev = new Float64Array(3);
  const i0 = Math.ceil(x0 - 0.5), i1 = Math.ceil(x0 + w - 0.5);
  const j0 = Math.ceil(y0 - 0.5), j1 = Math.ceil(y0 + h - 0.5);

  /** Taps this fragment pays with the armed stages skipped, or -1 for a discarded one. */
  const fragment = (px: number, py: number, e: Float64Array): number => {
    if (skip('skirt') && (Math.abs(px) > hx + pad || Math.abs(py) > hy + pad)) {
      c.Cut++;
      return -1;
    }
    if (skip('sdf')) sharpRect(px, py, hx, hy, e);
    else {
      const r = Math.min(px >= 0 ? (py <= 0 ? radii[1] : radii[2]) : (py <= 0 ? radii[0] : radii[3]), minHalf);
      superellipse(px, py, hx, hy, r, n, e);
    }
    const dist = e[0], nx = e[1], ny = e[2];
    const fillPos = dist < 0.5;
    const edgeDist = Math.max(-dist, 0);
    const x = edgeDist / bezel;
    const outward = smoothstep(0, s * 0.4, x) * (1 - smoothstep(s * 0.4, s, x));
    const inward = smoothstep(s, (s + 1) * 0.5, x) * (1 - smoothstep((s + 1) * 0.5, 1, x));
    const hump = Math.max(inward, outward);
    const noTaps = skip('backdrop');
    let taps = 0;
    if (!borderOnly) {
      const three = ca * hump * 3 >= 0.5;
      if (three) c.Ca3++;
      taps += noTaps ? 0 : (three && !skip('ca') ? 3 : 1);
      const inBand = fillPos && dist > -rimBand;
      if (inBand) c.Band++;
      if (inBand && !skip('rim') && !noTaps) taps++;
      if (specI > 0 && fillPos && !skip('specular') && !noTaps) {
        const band = (1 - smoothstep(-aa, aa, dist)) * smoothstep(-rimSpecW - aa, -rimSpecW + aa, dist);
        const k = nx * lx + ny * ly;
        const align = Math.max(k, -k * 0.95);
        if (band > 0 && align > 0) taps++;
      }
    }
    const k = nx * lx + ny * ly;
    const widthScale = 1 + variance * (Math.max(k, -k * 0.95) * 2 - 1);
    const varied = Math.max(bw * widthScale, 0);
    const drawn = Math.max(varied, 1);
    const fadeIn = Math.max(borderFade * widthScale, aa);
    const base = (1 - smoothstep(-aa, aa, dist)) * smoothstep(-drawn - fadeIn, -drawn + aa, dist) * (varied / drawn);
    if (base > 0.001) {
      c.Border++;
      if (!skip('border') && !noTaps) taps++;
    }
    if (fillPos) c.Face++; else c.Skirt++;
    return taps;
  };

  for (let j = j0; j < j1; j++) {
    const ry = j + 0.5 - cyr;
    for (let i = i0; i < i1; i++) {
      const rx = i + 0.5 - cxr;
      const px = rx * cos + ry * sin;
      const py = -rx * sin + ry * cos;
      c.Frags++;
      const armed = fragment(px, py, ev);
      if (armed >= 0) {
        c.Taps += armed;
        if (!skip('clip')) c.ClipFetches += 3 * clipCount;
      }
    }
  }
  // The unmasked count is the mask-0 walk of the same instance, which is cached beside this one.
  c.TapsFull = mask === 0 ? c.Taps : GlassInstanceCensus(d, b, 0).TapsFull;
  if (_cache.size >= CACHE_MAX) _cache.clear();
  _cache.set(key, c);
  return c;
};
