/**
 * `?glass-programs` -- THE GLASS PROGRAM IS REGISTER-BOUND, SO CUT IT SMALLER.
 *
 * The glass fragment program's cost on `glass-grid` tracks fragments times what each fragment
 * holds in registers, not the work it does (Perf/README, "THE HEAD CELL"). A uniform branch cannot
 * give registers back; only a program that does not CONTAIN the code can. So `?glass-programs`
 * (default `on`) routes a glass batch to GLASS_NO_GLOW + GLASS_NO_SPEC when every instance in it
 * has FresnelStrength and SpecularIntensity/Glow all exactly +0. A batch that fails falls back to
 * the full program and is COUNTED. The variant is in the boot batch on both arms, so `off` changes
 * routing and nothing else.
 *
 * Pure: no GL, so the predicates run in a unit test over the instances the real walk packs.
 */
import type { GlassSkipStage } from './Glass.Skip';

export type GlassProgramKind = 'full' | 'noLight';
export type GlassProgramsArm = 'on' | 'off';

/** Offsets into one packed panel instance (`Jiv.InstanceBuffer.Push`): 43 is `FresnelStrength`
 *  (`v_Lighting.w`), 44 `SpecularIntensity` and 45 `SpecularGlow` (`v_Specular.xy`). */
export const GLASS_OFF_FRESNEL_STRENGTH = 43;
export const GLASS_OFF_SPECULAR_INTENSITY = 44;
export const GLASS_OFF_SPECULAR_GLOW = 45;

export interface GlassBatchFacts {
  /** Every instance has FresnelStrength exactly +0. */
  NoGlow: boolean;
  /** Every instance has SpecularIntensity AND SpecularGlow exactly +0. */
  NoSpec: boolean;
}

/**
 * The two whole-batch questions, off the same floats the fragment's varyings are fed from.
 *
 * `+0` and not `== 0`: at +0 every product the excluded block forms with non-negative finite
 * factors is +0, and the composite it feeds is `r*1 + (+0)` whether the block ran or not.
 */
export const GlassBatchPredicates = (d: Float32Array, count: number, floatsPerInstance: number): GlassBatchFacts => {
  let noGlow = count > 0;
  let noSpec = count > 0;
  for (let i = 0; i < count; i++) {
    const b = i * floatsPerInstance;
    if (!Object.is(d[b + GLASS_OFF_FRESNEL_STRENGTH], 0)) noGlow = false;
    if (!Object.is(d[b + GLASS_OFF_SPECULAR_INTENSITY], 0) || !Object.is(d[b + GLASS_OFF_SPECULAR_GLOW], 0)) noSpec = false;
  }
  return { NoGlow: noGlow, NoSpec: noSpec };
};

/** Which glass program a batch takes under an arm. The pair program needs BOTH predicates; one
 *  alone is a fallback, because the boot compiles the pair and not the singles. */
export const GlassProgramFor = (f: GlassBatchFacts, arm: GlassProgramsArm): GlassProgramKind =>
  arm !== 'off' && f.NoGlow && f.NoSpec ? 'noLight' : 'full';

/** The `?glass-skip` stages the variant compiles away from under their bit, so the bit would price
 *  nothing on the batches it takes: the rim glow and the catchlight, which a fill batch at Fresnel /
 *  Specular 0 would otherwise run and composite as nothing. */
export const GLASS_PROGRAMS_PREEMPT: Record<GlassProgramsArm, readonly GlassSkipStage[]> = {
  on: ['rim', 'specular'],
  off: [],
};

/** `?glass-programs=<on|off>`; the bare flag is `on`. Anything else throws by name - a typo that
 *  quietly kept the default would be read as the arm it was meant to be. */
export const ParseGlassPrograms = (raw: string | null): GlassProgramsArm => {
  if (raw === null) return 'on';
  const v = raw.trim();
  if (v === '' || v === 'on') return 'on';
  if (v === 'off') return v;
  throw new Error(`[Jaui] ?glass-programs takes on or off, got '${v}'`);
};
