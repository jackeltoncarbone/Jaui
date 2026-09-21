/**
 * `?glass-adapt` -- THE GLASS GRADE OPENS WITH WHAT IS BEHIND IT.
 *
 * Pure arithmetic, no GL, for the reason `Blur.Cache` and `Scene.Ledger` are their own modules: the
 * grade runs in `Jiv.Panel.vert` (`GlassAdaptGrade`), and this is its CPU mirror, which the census
 * uses to say what each surface resolved to and which `tests/Glass.Adapt.test.ts` holds to the GLSL
 * statement by statement.
 *
 * ── THE LAW IT EXTENDS ─────────────────────────────────────────────────────────────────────────────
 *
 * `Jwift.Glass.jss` grades a glass body as ONE affine ramp in luma: with contrast c, saturate s and a
 * tint t toward black, a backdrop of luma Y lands at (1 - t)((Y - 0.5)c + 0.5). Over black that is the
 * GROUND end, (1 - t)(1 - c)/2 (Apple's 26); over white the FAR end, (1 - t)(1 + c)/2, which the sheet
 * solved as the body value where the app's @Ink sits exactly on its legibility floor. A constant has one
 * far end for a black backdrop and a white one. Apple's does not ("the amount of tint and the dynamic
 * range shift", WWDC25 session 219): its dark glass over a mid-tone photo sits at or above the photo.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────────────────────────────
 *
 * Maximise what comes through, subject to the ink staying legible -- the sheet's own rule, solved per
 * surface instead of once. The ink is legible wherever the body is at or below the authored far end,
 * and over a backdrop whose brightest local luma is `peak` the body's brightest point is
 * ground + (F - ground) * peak. So the far end can open to
 *
 *     F = min(openFar, ground + (far - ground) / peak)
 *
 * and no further: past `openFar` (`AdaptiveFar`, Apple's own far end) there is nothing to gain, and past
 * the second term the ink would fall below the floor the static law held. Ground and the colour carried,
 * c s (1 - t), stay put; the range and the tint move. It is the static law exactly at both ends: over
 * black (peak 0) the body is `ground` whatever F is, and over white (peak 1) F = far.
 */

/** The grade a panel instance carries, as the vertex stage reads it: `a_Grading.xyz` and `a_Lighting.y`. */
export interface GlassGrade {
  Brightness: number;
  Saturation: number;
  Contrast: number;
  /** Signed: negative toward black. */
  Tint: number;
}

/** The smallest peak the grade divides by: one LSB of the 10-bit state texel. */
export const GLASS_ADAPT_PEAK_FLOOR = 1 / 1023;

/** Does the vertex stage open this instance at all? Only a body tinted toward black at brightness 1 is
 *  on the ramp the grade inverts; everything else keeps its authored numbers. Mirrors the `if` in
 *  `Jiv.Panel.vert`'s main. */
export const GlassAdaptEligible = (g: GlassGrade, openFar: number): boolean =>
  openFar > 0 && g.Tint < 0 && g.Brightness === 1;

/** The two ends of the authored ramp, and the far end this surface opens to. */
export const GlassAdaptFar = (g: GlassGrade, peak: number, openFar: number): { Ground: number; Far: number; Opened: number } => {
  const t = -g.Tint;
  const ground = (1 - t) * (1 - g.Contrast) * 0.5;
  const far = (1 - t) * (1 + g.Contrast) * 0.5;
  const opened = Math.min(openFar, ground + (far - ground) / Math.max(peak, GLASS_ADAPT_PEAK_FLOOR));
  return { Ground: ground, Far: far, Opened: opened };
};

/** `GlassAdaptGrade`, statement for statement. A ramp that does not open returns the authored grade
 *  itself, so an unopened surface is not re-derived (and cannot move by a rounding). */
export const GlassAdaptGrade = (g: GlassGrade, peak: number, openFar: number): GlassGrade => {
  const { Ground: ground, Far: far, Opened: opened } = GlassAdaptFar(g, peak, openFar);
  if (!(opened > far)) return g;
  const range = opened - ground;
  const keep = ground + opened;
  const carry = g.Contrast * g.Saturation * (1 + g.Tint);
  return {
    Brightness: Math.max(keep, 1),
    Saturation: carry / range,
    Contrast: range / keep,
    Tint: -Math.max(1 - keep, 0),
  };
};

/** The body's luma over a backdrop of luma `y` under a grade (brightness, contrast, tint; saturate
 *  preserves luma). For the tests and the census, never the shader. */
export const GlassBodyLuma = (g: GlassGrade, y: number): number => {
  const graded = ((y - 0.5) * g.Contrast + 0.5) * g.Brightness;
  const a = Math.abs(g.Tint);
  return graded * (1 - a) + (g.Tint > 0 ? a : 0);
};

// ── The census ─────────────────────────────────────────────────────────────────────────────────────

/** One adapted glass draw of a frame: its state slot, its `AdaptiveFar`, and the grade it carried. */
export interface GlassAdaptDraw {
  Slot: number;
  OpenFar: number;
  Grade: GlassGrade;
}

/** What one surface resolved to, from the state texel read back after its frame. Lumas are 0..1. */
export interface GlassAdaptSurface {
  Slot: number;
  /** The mean local backdrop luma under the footprint (the texel's G). */
  Mean: number;
  /** The brightest local backdrop luma (the texel's B): what the ink cap is solved against. */
  Peak: number;
  /** The authored far end, and the one the surface resolved to. */
  Far: number;
  Opened: number;
  /** The resolved signed tint and brightness, and the range (opened - ground) the body lets through. */
  Tint: number;
  Brightness: number;
  Range: number;
  /** Opened past the authored far end at all. */
  Lifted: boolean;
  /** Lifted, but held short of `AdaptiveFar` by the ink: the legibility cap is what decided it. */
  Capped: boolean;
}

export interface GlassAdaptCensus {
  Arm: 'on' | 'off';
  Refused: string;
  /** Rendered frame the texel was read on, and how many reads have landed. */
  Frame: number;
  Reads: number;
  /** Glass draws with an `AdaptiveFar` and a probe slot, whose texel was read. */
  Surfaces: number;
  /** Glass draws with an `AdaptiveFar` and NO probe: nothing to read, so they keep the authored grade. */
  Unprobed: number;
  /** Surfaces off the ramp the grade inverts (tint toward white, or brightness not 1): authored grade. */
  Ineligible: number;
  MeanMin: number;
  MeanMax: number;
  MeanAvg: number;
  PeakMax: number;
  Lifted: number;
  Capped: number;
  /** Reached `AdaptiveFar` itself, the ink leaving room to spare. */
  Open: number;
  /** Resolved to exactly the static law. */
  Static: number;
  /** Labels whose ink flipped. Always 0: this lane caps and does not flip (see the report). */
  Flipped: number;
  TintMin: number;
  TintMax: number;
  RangeMin: number;
  RangeMax: number;
  /** Named when the arm is doing nothing: '' when some surface lifted. */
  Vacuous: string;
  Per: GlassAdaptSurface[];
}

export const EmptyGlassAdaptCensus = (arm: 'on' | 'off', refused: string): GlassAdaptCensus => ({
  Arm: arm, Refused: refused, Frame: -1, Reads: 0, Surfaces: 0, Unprobed: 0, Ineligible: 0,
  MeanMin: 0, MeanMax: 0, MeanAvg: 0, PeakMax: 0, Lifted: 0, Capped: 0, Open: 0, Static: 0, Flipped: 0,
  TintMin: 0, TintMax: 0, RangeMin: 0, RangeMax: 0, Vacuous: 'no-read-yet', Per: [],
});

/** Unpacks one RGBA8 readback of the state row: slot i's G and B, as 0..1. */
export const ReadStateTexel = (row: Uint8Array, slot: number): { Mean: number; Peak: number } => ({
  Mean: row[slot * 4 + 1] / 255,
  Peak: row[slot * 4 + 2] / 255,
});

/** The census of one frame's adapted draws against the state row read back after it. The readback is
 *  8-bit where the texel is 10-bit, so the numbers here are the GPU's to within 1/255; the classification
 *  (lifted / capped / open / static) can differ from the GPU's only for a peak within that of 1. */
export const GlassAdaptCensusOf = (
  census: GlassAdaptCensus, draws: readonly GlassAdaptDraw[], unprobed: number, row: Uint8Array,
): void => {
  census.Surfaces = 0; census.Ineligible = 0; census.Unprobed = unprobed;
  census.Lifted = 0; census.Capped = 0; census.Open = 0; census.Static = 0; census.Flipped = 0;
  census.Per = [];
  let meanSum = 0;
  census.MeanMin = Infinity; census.MeanMax = -Infinity; census.PeakMax = 0;
  census.TintMin = Infinity; census.TintMax = -Infinity; census.RangeMin = Infinity; census.RangeMax = -Infinity;
  for (const d of draws) {
    if (!GlassAdaptEligible(d.Grade, d.OpenFar)) { census.Ineligible++; continue; }
    const { Mean: mean, Peak: peak } = ReadStateTexel(row, d.Slot);
    const ends = GlassAdaptFar(d.Grade, peak, d.OpenFar);
    const g = GlassAdaptGrade(d.Grade, peak, d.OpenFar);
    const lifted = g !== d.Grade;
    const opened = lifted ? ends.Opened : ends.Far;
    const capped = lifted && ends.Opened < d.OpenFar;
    const range = opened - ends.Ground;
    census.Surfaces++;
    meanSum += mean;
    census.MeanMin = Math.min(census.MeanMin, mean);
    census.MeanMax = Math.max(census.MeanMax, mean);
    census.PeakMax = Math.max(census.PeakMax, peak);
    census.TintMin = Math.min(census.TintMin, g.Tint);
    census.TintMax = Math.max(census.TintMax, g.Tint);
    census.RangeMin = Math.min(census.RangeMin, range);
    census.RangeMax = Math.max(census.RangeMax, range);
    if (!lifted) census.Static++;
    else if (capped) { census.Lifted++; census.Capped++; }
    else { census.Lifted++; census.Open++; }
    census.Per.push({
      Slot: d.Slot, Mean: mean, Peak: peak, Far: ends.Far, Opened: opened,
      Tint: g.Tint, Brightness: g.Brightness, Range: range, Lifted: lifted, Capped: capped,
    });
  }
  if (census.Surfaces === 0) {
    census.MeanMin = 0; census.MeanMax = 0; census.PeakMax = 0;
    census.TintMin = 0; census.TintMax = 0; census.RangeMin = 0; census.RangeMax = 0;
  }
  census.MeanAvg = census.Surfaces > 0 ? meanSum / census.Surfaces : 0;
  census.Vacuous =
    census.Arm === 'off' ? ''
    : census.Surfaces === 0 ? (census.Unprobed > 0 ? 'no-adaptive-surface-was-probed' : 'no-adaptive-surface-drawn')
    : census.Lifted === 0 ? 'every-surface-resolved-to-the-static-law'
    : '';
};

/** The gate line: a SHAPE, so it prints when the frame's resolution changes rather than every frame. */
export const GlassAdaptLine = (c: GlassAdaptCensus): string => {
  const f = (v: number): string => (v * 255).toFixed(1);
  return `jaui:glass-adapt arm=${c.Arm} surfaces=${c.Surfaces} unprobed=${c.Unprobed} ineligible=${c.Ineligible}`
    + ` luma=${f(c.MeanMin)}/${f(c.MeanAvg)}/${f(c.MeanMax)} peak=${f(c.PeakMax)}`
    + ` lifted=${c.Lifted} capped=${c.Capped} open=${c.Open} static=${c.Static} flipped=${c.Flipped} ink=cap`
    + ` tint=${c.TintMin.toFixed(3)}..${c.TintMax.toFixed(3)} range=${f(c.RangeMin)}..${f(c.RangeMax)}`
    + ` reads=${c.Reads}`
    + (c.Vacuous !== '' ? ` vacuous=${c.Vacuous}` : '')
    + (c.Refused !== '' ? ` refused=${c.Refused}` : '')
    + ` pixels=${c.Arm === 'on' && c.Lifted > 0 ? 'DIFFERENT' : 'SAME'}`;
};
