/**
 * `?glass-programs` and `?glass-reg` -- THE GLASS PROGRAM IS REGISTER-BOUND, SO CUT IT SMALLER.
 *
 * The glass fragment program's cost on `glass-grid` tracks fragments times what each fragment
 * holds in registers, not the work it does (Perf/README, "THE HEAD CELL": 62cfb35 changed no
 * arithmetic and took 43% off the render). A uniform branch cannot give registers back; only a
 * program that does not CONTAIN the code can. So:
 *
 *   - `?glass-programs` (default `on`) routes a glass batch to a program with whole stages
 *     compiled out when every instance in it makes those stages composite nothing:
 *     GLASS_BORDER_ONLY for a batch of rim overlays, GLASS_NO_GLOW + GLASS_NO_SPEC for a batch
 *     with FresnelStrength and SpecularIntensity both exactly +0. A batch that fails falls back to
 *     the full program and is COUNTED. Both variants are in the boot batch on both arms, so `off`
 *     changes routing and nothing else.
 *   - `?glass-reg` (default `off` while it is measured) swaps the whole glass family for the same
 *     three programs cut with a lifetime arm: `scope` (GLASS_REG, the same statements reordered so
 *     fewer values are held across the heavy ones), `all` (plus GLASS_REG_REMAT, three cheap values
 *     recomputed rather than held), or `nogates` (GLASS_NO_SKIP_GATES, `?glass-skip`'s ten uniform
 *     branches folded away: the discriminator for what 62cfb35 actually changed).
 *
 * Pure: no GL, so the predicates run in a unit test over the instances the real walk packs.
 */
import type { GlassSkipStage } from './Glass.Skip';

export type GlassProgramKind = 'full' | 'borderOnly' | 'noLight';
export type GlassProgramsArm = 'on' | 'off' | 'border-only' | 'no-light';
export type GlassRegArm = 'off' | 'scope' | 'all' | 'nogates';

/** The defines each variant adds to `MATERIAL_GLASS`. `full` adds none. */
export const GLASS_VARIANT_DEFINES: Record<GlassProgramKind, Record<string, boolean>> = {
  full: {},
  borderOnly: { GLASS_BORDER_ONLY: true },
  noLight: { GLASS_NO_GLOW: true, GLASS_NO_SPEC: true },
};

/** The defines each armed `?glass-reg` value cuts the glass family with. */
export const GLASS_REG_DEFINES: Record<Exclude<GlassRegArm, 'off'>, Record<string, boolean>> = {
  scope: { GLASS_REG: true },
  all: { GLASS_REG: true, GLASS_REG_REMAT: true },
  nogates: { GLASS_NO_SKIP_GATES: true },
};

export const GLASS_PROGRAM_KINDS: readonly GlassProgramKind[] = ['full', 'borderOnly', 'noLight'];

/** Offsets into one packed panel instance (`Jiv.InstanceBuffer.Push`). 28 is `borderEdgeAa`, which
 *  a 'GlassBorderOnly' instance carries NEGATED (the shader's `borderOnly = v_StyleParams.x < 0.0`);
 *  43 is `FresnelStrength` (`v_Lighting.w`); 44 is `SpecularIntensity` (`v_Specular.x`). */
export const GLASS_OFF_BORDER_EDGE_AA = 28;
export const GLASS_OFF_FRESNEL_STRENGTH = 43;
export const GLASS_OFF_SPECULAR_INTENSITY = 44;

export interface GlassBatchFacts {
  /** Every instance is a rim overlay: `borderEdgeAa < 0`, the fragment's own test in float32. */
  BorderOnly: boolean;
  /** Every instance has FresnelStrength exactly +0. */
  NoGlow: boolean;
  /** Every instance has SpecularIntensity exactly +0. */
  NoSpec: boolean;
}

/**
 * The three whole-batch questions, off the same floats the fragment's varyings are fed from.
 *
 * `+0` and not `== 0`: at +0 every product the excluded block forms with non-negative finite
 * factors is +0, and the composite it feeds is `r*1 + (+0)` whether the block ran or not. A -0
 * would still composite a zero, but that argument needs the sign of a zero to be unobservable
 * downstream, and the packer never writes one, so the predicate does not lean on it.
 */
export const GlassBatchPredicates = (d: Float32Array, count: number, floatsPerInstance: number): GlassBatchFacts => {
  let borderOnly = count > 0;
  let noGlow = count > 0;
  let noSpec = count > 0;
  for (let i = 0; i < count; i++) {
    const b = i * floatsPerInstance;
    if (!(d[b + GLASS_OFF_BORDER_EDGE_AA] < 0)) borderOnly = false;
    if (!Object.is(d[b + GLASS_OFF_FRESNEL_STRENGTH], 0)) noGlow = false;
    if (!Object.is(d[b + GLASS_OFF_SPECULAR_INTENSITY], 0)) noSpec = false;
  }
  return { BorderOnly: borderOnly, NoGlow: noGlow, NoSpec: noSpec };
};

/**
 * Which glass program a batch takes under an arm. BORDER_ONLY first: it excludes the rim glow and
 * the catchlight too (both composite nothing at `fillAlpha` 0), so a rim batch needs neither
 * lighting predicate. The pair program needs BOTH lighting predicates; one alone is a fallback,
 * because the boot compiles the pair and not the singles.
 */
export const GlassProgramFor = (f: GlassBatchFacts, arm: GlassProgramsArm): GlassProgramKind => {
  if (arm === 'off') return 'full';
  if (arm !== 'no-light' && f.BorderOnly) return 'borderOnly';
  if (arm !== 'border-only' && f.NoGlow && f.NoSpec) return 'noLight';
  return 'full';
};

/**
 * The `?glass-skip` stages an arm's variants compile away from under their bit, so the bit would
 * price nothing on the batches those variants take. The rim glow and the catchlight run on a fill
 * batch at Fresnel / Specular 0 and composite nothing - that executed work is exactly what the
 * `rim` and `specular` arms price, and NO_GLOW / NO_SPEC remove it. BORDER_ONLY removes the
 * catchlight from every rim (its ALU runs there today); the body stages it also removes (`ca`,
 * `grade`, `shadow`, the rim glow) never executed on a rim, so their bits keep their meaning on
 * the fills and are not refused.
 */
export const GLASS_PROGRAMS_PREEMPT: Record<GlassProgramsArm, readonly GlassSkipStage[]> = {
  on: ['rim', 'specular'],
  off: [],
  'border-only': ['specular'],
  'no-light': ['rim', 'specular'],
};

/** `?glass-programs=<on|off|border-only|no-light>`; the bare flag is `on`. Anything else throws by
 *  name - a typo that quietly kept the default would be read as the arm it was meant to be. */
export const ParseGlassPrograms = (raw: string | null): GlassProgramsArm => {
  if (raw === null) return 'on';
  const v = raw.trim();
  if (v === '' || v === 'on') return 'on';
  if (v === 'off' || v === 'border-only' || v === 'no-light') return v;
  throw new Error(`[Jaui] ?glass-programs takes on, off, border-only or no-light, got '${v}'`);
};

/** `?glass-reg=<off|scope|all|nogates>`; the bare flag is `scope`. Anything else throws by name. */
export const ParseGlassReg = (raw: string | null): GlassRegArm => {
  if (raw === null) return 'off';
  const v = raw.trim();
  if (v === '' || v === 'scope') return 'scope';
  if (v === 'off' || v === 'all' || v === 'nogates') return v;
  throw new Error(`[Jaui] ?glass-reg takes off, scope, all or nogates, got '${v}'`);
};
