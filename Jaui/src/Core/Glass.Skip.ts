/**
 * `?glass-skip` -- THE GLASS CARD DRAW, PRICED STAGE BY STAGE.
 *
 * The 0.5-2 ms interval class on `glass-grid` (twenty per render, ~0.54 ms each, 12.8 of 14.1 ms of
 * union busy on the M4) is the twenty glass card draws, and no lever of the pyramid phase touched
 * them. This file is the arm that does: the stage table the shader's `u_GlassSkip` bits are named
 * from, the flag's parse, and the FRAGMENT CENSUS that gives the Mac's per-fragment reading a
 * denominator.
 *
 * Pure arithmetic, no GL, for the reason `Scene.Ledger` is its own module: it can be unit-tested
 * without the renderer's shader imports.
 */
import { ContinuousCorner } from '../Jiv/Corner.Continuous';

/** The shader's bits, by name. `Jiv.Panel.frag` declares the same nine `GLASS_SKIP_*` constants and
 *  `tests/Glass.Skip.test.ts` reads that file and holds the two tables to each other. */
export const GLASS_SKIP_STAGES = {
  backdrop: 1,
  ca: 2,
  rim: 4,
  specular: 8,
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
 * own gates -- the corner field's distance and normal, the refraction band, the rim glow's band,
 * the specular band -- so the numbers are the shader's branches evaluated, not an
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
  /** `dist >= 0.5`: outside the face -- the shadow skirt. */
  Skirt: number;
  /** Skirt fragments the `skirt` arm discards (outside the face's padded BOX). The rest of the
   *  skirt is the corner pockets between the rounded corner and the box, which still run. */
  Cut: number;
  /** Fragments taking the 3-tap chromatic fill path. */
  Ca3: number;
  /** Backdrop taps under the ARMED mask. */
  Taps: number;
  /** Backdrop taps with no stage skipped: the same frame's unflagged count. */
  TapsFull: number;
  /** Clip-stack texel fetches (three per clip per fragment, paid before the clip's discard). */
  ClipFetches: number;
  /** 3D (projective) instances: their quad is a projected natural box and is not walked. */
  Projective: number;
}

export const EmptyGlassFragCensus = (): GlassFragCensus => ({
  Instances: 0, Frags: 0, Face: 0, Band: 0, Skirt: 0, Cut: 0, Ca3: 0,
  Taps: 0, TapsFull: 0, ClipFetches: 0, Projective: 0,
});

export const AddGlassFragCensus = (into: GlassFragCensus, c: GlassFragCensus): void => {
  for (const k of Object.keys(into) as (keyof GlassFragCensus)[]) into[k] += c[k];
};

/** Offsets into one packed panel instance (`Jiv.InstanceBuffer.Push`). */
const O = {
  RectX: 0, RectY: 1, RectW: 2, RectH: 3, Cos: 4, Sin: 5, HalfW: 6, HalfH: 7, Radii: 8,
  EdgeAa: 28, Smooth: 29, Thickness: 36, Refraction: 38,
  LightAngle: 40, SpecIntensity: 44, Ca: 46, ClipCount: 55,
} as const;

/** Every instance float `GlassInstanceCensus` reads other than the rect origin (which enters the key
 *  as its fractional part). Exported so a test can assert it against the reads in the source. */
export const GLASS_CENSUS_KEY_OFFSETS: readonly number[] = [
  O.RectW, O.RectH, O.Cos, O.Sin, O.HalfW, O.HalfH, O.Radii, O.Radii + 1, O.Radii + 2, O.Radii + 3,
  O.EdgeAa, O.Smooth, O.Thickness, O.Refraction, O.LightAngle, O.SpecIntensity,
  O.Ca, O.ClipCount,
];
const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
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
  // THE CACHE KEY IS THE GEOMETRY THE CENSUS READS, NOT THE WHOLE INSTANCE. A miss costs ~53 ms of
  // CPU per instance (measured 2026-09-20 on the lane's own fixtures), and a key over all 60 floats
  // missed on EVERY frame of glass-grid while the adaptive shadow eased - 40 misses x 53 ms inside
  // the draw batch, a two-second frame and a black canvas under `?glass-skip=none`. The counts are
  // translation-invariant up to the pixel-centre PHASE of the rect origin, so the origin enters
  // as its fractional part and a grid scrolling by whole pixels hits too. Offsets listed once, in
  // the order `O` declares them; any new read in `fragment` must be added here or the cache lies.
  const fx = d[b + O.RectX] - Math.floor(d[b + O.RectX]);
  const fy = d[b + O.RectY] - Math.floor(d[b + O.RectY]);
  let key = String(mask) + ',' + fx + ',' + fy;
  for (const o of GLASS_CENSUS_KEY_OFFSETS) key += ',' + d[b + o];
  const hit = _cache.get(key);
  if (hit !== undefined) return hit;

  const x0 = d[b + O.RectX], y0 = d[b + O.RectY], w = d[b + O.RectW], h = d[b + O.RectH];
  const cos = d[b + O.Cos], sin = d[b + O.Sin];
  const hx = d[b + O.HalfW], hy = d[b + O.HalfH];
  const cxr = x0 + w * 0.5, cyr = y0 + h * 0.5;
  const radii = [d[b + O.Radii], d[b + O.Radii + 1], d[b + O.Radii + 2], d[b + O.Radii + 3]];
  const edgeAa = d[b + O.EdgeAa];
  const aa = Math.max(Math.abs(edgeAa), 1e-4);
  const band = Math.max(0.09 * 2 * Math.min(hx, hy), 0.5);
  const refraction = d[b + O.Refraction];
  const ca = d[b + O.Ca];
  const thickness = d[b + O.Thickness];
  const specI = d[b + O.SpecIntensity];
  const clipCount = d[b + O.ClipCount];
  const lx = Math.cos(d[b + O.LightAngle]), ly = -Math.sin(d[b + O.LightAngle]);
  const rimBand = Math.max(band * 0.75, 6);
  const glassiness = smoothstep(0, 1, thickness);
  const rimSpecW = Math.max(thickness * 0.18, 0.75 * glassiness);
  const pad = 2 + Math.abs(edgeAa);

  const smooth = d[b + O.Smooth];
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
    else ContinuousCorner(px, py, hx, hy, radii, smooth, e);
    const dist = e[0], nx = e[1], ny = e[2];
    const fillPos = dist < 0.5;
    const edge = 1 - Math.min(1, Math.max(-dist, 0) / band);
    const offset = (band / 3) * edge * edge * edge * refraction * glassiness;
    const noTaps = skip('backdrop');
    let taps = 0;
    const three = 0.2 * ca * offset >= 0.5;
    if (three) c.Ca3++;
    taps += noTaps ? 0 : (three && !skip('ca') ? 3 : 1);
    const inBand = fillPos && dist > -rimBand;
    if (inBand) c.Band++;
    if (inBand && !skip('rim') && !noTaps) taps++;
    if (specI > 0 && fillPos && !skip('specular') && !noTaps) {
      const specBand = (1 - smoothstep(-aa, aa, dist)) * smoothstep(-rimSpecW - aa, -rimSpecW + aa, dist);
      const k = nx * lx + ny * ly;
      const align = Math.max(k, -k * 0.95);
      if (specBand > 0 && align > 0) taps++;
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
