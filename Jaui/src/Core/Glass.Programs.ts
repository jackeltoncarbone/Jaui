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
import { GLASS_SKIP_STAGES, type GlassSkipStage } from './Glass.Skip';

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

// ── ?glass-gates ────────────────────────────────────────────────────────────────────────────────
//
// `?glass-reg=nogates` compiled all ten `?glass-skip` gates away and gave back +13.37 of the head
// cell's -13.73 ms (M4, dpr 3), pixel-identical: the ten uniform branches ARE the -43%. This arm
// takes them apart, and adds more:
//
//   - `<stage>` (one of the ten, comma-listed; `all` = the ten) compiles that gate away and nothing
//     else: GLASS_NO_GATE_<STAGE>. The inverse of `?glass-skip`, which switches the WORK off with
//     the gates present. `all` is `nogates` byte for byte in the preprocessed source.
//   - `+<barrier>` (one of GLASS_GATE_BARRIERS) puts a NEW uniform gate around a heavy statement
//     that runs unconditionally today: GLASS_GATE_<BARRIER>, condition `u_GlassGate & bit`, uploaded
//     as GLASS_GATE_OPEN on every glass draw - TRUE on the shipped path, so the statements run as
//     they do without it and the only effect is the control-flow boundary.
//
// Compiled when it arms, as its own batch: the glass family (full, border-only, no-light) cut with
// the arm's defines, bound in place of the boot family exactly as `?glass-reg`'s is. Every arm is
// pixel-identical by construction; the draws, their instances and the census never move.

/** The new gates' bits, as `Jiv.Panel.frag` declares them (`GLASS_BARRIER_<NAME>`). */
export const GLASS_GATE_BARRIERS = {
  bezel: 1,
  refract: 2,
  lod: 4,
  grad: 8,
  absorb: 16,
  ambient: 32,
} as const;
export type GlassGateBarrier = keyof typeof GLASS_GATE_BARRIERS;
/** `u_GlassGate` on every glass draw: every barrier bit set, so every new gate is TRUE. */
export const GLASS_GATE_OPEN = Object.values(GLASS_GATE_BARRIERS).reduce((a, b) => a | b, 0);

export interface GlassGatesArm {
  /** The `?glass-skip` gates compiled away, in `GLASS_SKIP_STAGES` order. */
  Removed: readonly GlassSkipStage[];
  /** The new gates compiled in, in `GLASS_GATE_BARRIERS` order. */
  Barriers: readonly GlassGateBarrier[];
  /** The canonical spelling: `all` for the ten, else the stages, then `+barrier`s. The mark's value
   *  and the key the renderer's family is cut for. */
  Key: string;
}

const SKIP_ORDER = Object.keys(GLASS_SKIP_STAGES) as GlassSkipStage[];
const BARRIER_ORDER = Object.keys(GLASS_GATE_BARRIERS) as GlassGateBarrier[];

/** The defines an armed `?glass-gates` cuts the glass family with, on top of each kind's own. */
export const GlassGatesDefines = (arm: GlassGatesArm): Record<string, boolean> => {
  const out: Record<string, boolean> = {};
  for (const s of arm.Removed) out[`GLASS_NO_GATE_${s.toUpperCase()}`] = true;
  for (const b of arm.Barriers) out[`GLASS_GATE_${b.toUpperCase()}`] = true;
  return out;
};

/**
 * `?glass-gates=<off|all|list>`: `null` is off (the default, and `off`). The list is comma-separated;
 * each item is one of the ten stages, `all`, or `+<barrier>`. A `+` in a query string decodes to a
 * space, so a leading space reads as the `+` it was typed as; `%2B` arrives as a real `+`. A barrier
 * written bare is accepted (the two name sets are disjoint), a stage written with `+` is not (it is
 * a gate removed, not a gate added), and anything else throws by name. The bare flag is `all`.
 */
export const ParseGlassGates = (raw: string | null): GlassGatesArm | null => {
  if (raw === null) return null;
  if (raw.trim() === 'off') return null;
  const removed = new Set<GlassSkipStage>();
  const barriers = new Set<GlassGateBarrier>();
  const items = raw.trim() === '' ? ['all'] : raw.split(',');
  for (const item of items) {
    const plus = /^[+\s]/.test(item);
    const name = item.replace(/^[+\s]+/, '').trim();
    if (name === 'all' && !plus) { for (const s of SKIP_ORDER) removed.add(s); continue; }
    if (name in GLASS_SKIP_STAGES) {
      if (plus) throw new Error(`[Jaui] ?glass-gates: '${name}' is one of the ten gates; write '${name}' to compile it away (a '+' adds a new gate)`);
      removed.add(name as GlassSkipStage);
      continue;
    }
    if (name in GLASS_GATE_BARRIERS) { barriers.add(name as GlassGateBarrier); continue; }
    throw new Error(`[Jaui] ?glass-gates takes off, all, the ten gates (${SKIP_ORDER.join(', ')})`
      + ` or +<new gate> (${BARRIER_ORDER.join(', ')}), comma-separated; got '${item}'`);
  }
  const r = SKIP_ORDER.filter((s) => removed.has(s));
  const b = BARRIER_ORDER.filter((x) => barriers.has(x));
  const head = r.length === SKIP_ORDER.length ? ['all'] : r;
  return { Removed: r, Barriers: b, Key: [...head, ...b.map((x) => `+${x}`)].join(',') };
};
