/**
 * `?glass-gates` (lane gatebisect), read out of the REAL `Jiv.Panel.frag` through the same
 * preprocessor and scope walker lane glassreg built (`Flat.Program.Source`, `Glass.Reg.Source`).
 *
 * What a lane with no GLSL compiler can say about a GATE is where it sits in the live set: the
 * components carried THROUGH the region it fences (declared before the region, read after it). A
 * uniform branch is a control-flow boundary; the values carried through it are the ones the region's
 * own work has to share registers with, and the ones a scheduler free to move work across the
 * boundary could pile up. So for every gate, old and new, this file finds the region and counts.
 */
import { preprocess, codeLines, readPanelFrag } from './Flat.Program.Source';
import { mainOf, walkScopes, foldGlassArms, FREE_ALIASES, rematLinesOf, type Line, type ScopeWalk } from './Glass.Reg.Source';
import { GLASS_SKIP_STAGES, type GlassSkipStage } from '@jaui/Core/Glass.Skip';
import { GLASS_GATE_BARRIERS, GLASS_VARIANT_DEFINES, type GlassGateBarrier, type GlassProgramKind } from '@jaui/Core/Glass.Programs';

export const STAGES = Object.keys(GLASS_SKIP_STAGES) as GlassSkipStage[];
export const BARRIERS = Object.keys(GLASS_GATE_BARRIERS) as GlassGateBarrier[];

/** The preprocessed lines of one glass program: `kind`'s variant defines plus `extra`. */
export const gateProgram = (kind: GlassProgramKind, extra: readonly string[] = []): Line[] =>
  codeLines(preprocess(readPanelFrag(), ['MATERIAL_GLASS', ...Object.keys(GLASS_VARIANT_DEFINES[kind]), ...extra]));

/** The same, comments kept: what "byte for byte in the preprocessed source" compares. */
export const gateProgramRaw = (defines: readonly string[]): Line[] => preprocess(readPanelFrag(), defines);

export const noGate = (s: GlassSkipStage): string => `GLASS_NO_GATE_${s.toUpperCase()}`;
export const barrierDefine = (b: GlassGateBarrier): string => `GLASS_GATE_${b.toUpperCase()}`;

/** The block that opens on line `i` (its last `{`), through the line that closes it. */
export const blockEnd = (lines: readonly Line[], i: number): number => {
  let depth = 0;
  for (let j = i; j < lines.length; j++) {
    const t = j === i ? lines[j].Text.slice(lines[j].Text.lastIndexOf('{')) : lines[j].Text;
    for (const ch of t) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    if (depth === 0) return j;
  }
  throw new Error('[Glass.Gates] unclosed block');
};

export interface GateSite {
  /** The gate: a `?glass-skip` stage, or a `+barrier`. */
  Gate: string;
  /** Indices into the folded `main` of the region the gate fences (inclusive). */
  From: number;
  To: number;
  /** Components carried through the region, and their names. */
  Carried: number;
  Names: string[];
}

/** The statement a function-level gate lives in, at each of its call sites in `main`. */
const CALL_SITES: Partial<Record<GlassSkipStage, RegExp>> = {
  backdrop: /\bsampleBackdrop\(/,
  sdf: /\b(ShapeEval|ShapeSDF|CornerDist)\(/,
  clip: /\bcornerQueries\(/,
};

/** A value a gated block HANDS ON is declared ahead of the gate with no initialiser and first
 *  written inside it: it is the region's output, not something carried through it. */
const isOutput = (main: readonly Line[], v: ScopeWalk['Locals'][number], from: number): boolean =>
  /^(float|int|bool|vec2|vec3|vec4)\s+\w+;$/.test(main[v.Decl].Text) && (v.Uses[0] ?? Infinity) >= from;

const carried = (main: readonly Line[], walk: ScopeWalk, from: number, to: number): { Carried: number; Names: string[] } => {
  const names: string[] = [];
  let n = 0;
  for (const v of walk.Locals) {
    if (FREE_ALIASES.has(v.Name)) continue;
    if (v.Decl >= from) continue;
    if (isOutput(main, v, from)) continue;
    const last = v.Uses.length === 0 ? v.Decl : v.Uses[v.Uses.length - 1];
    if (last <= to) continue;
    names.push(v.Name);
    n += v.Components;
  }
  return { Carried: n, Names: names.sort() };
};

/** The region a gate LINE fences in `main`: the gated block (`{} else` + the next statement's
 *  block, or the `{`-opening line's own block), or the line alone for a one-statement gate. */
const regionOf = (main: readonly Line[], at: number): [number, number] => {
  const t = main[at].Text;
  if (t.endsWith('{} else')) {
    const next = at + 1;
    return [at, main[next].Text.endsWith('{') ? blockEnd(main, next) : next];
  }
  if (t.endsWith('{')) return [at, blockEnd(main, at)];
  return [at, at];
};

/** Every gate site in one program's folded `main`, old and new, in program order. */
export const gateSites = (lines: readonly Line[], remat: ReadonlySet<number> = new Set()): GateSite[] => {
  const main = foldGlassArms(mainOf(lines));
  const walk = walkScopes(main, remat);
  const out: GateSite[] = [];
  main.forEach((l, i) => {
    const skip = /GlassSkips\(GLASS_SKIP_([A-Z]+)\)/.exec(l.Text);
    if (skip !== null) {
      const [from, to] = regionOf(main, i);
      out.push({ Gate: skip[1].toLowerCase(), From: from, To: to, ...carried(main, walk, from, to) });
    }
    const gate = /GlassGate\(GLASS_BARRIER_([A-Z]+)\)/.exec(l.Text);
    if (gate !== null) {
      const [from, to] = regionOf(main, i);
      out.push({ Gate: `+${gate[1].toLowerCase()}`, From: from, To: to, ...carried(main, walk, from, to) });
    }
    for (const [stage, re] of Object.entries(CALL_SITES) as Array<[GlassSkipStage, RegExp]>) {
      if (re.test(l.Text)) out.push({ Gate: stage, From: i, To: i, ...carried(main, walk, i, i) });
    }
  });
  // The one new gate that lives in a function: `+grad`, inside CornerEval, reached from the main
  // corner field's `ShapeEval` call.
  if (lines.some((l) => l.Text.includes('GlassGate(GLASS_BARRIER_GRAD)'))) {
    const i = main.findIndex((l) => l.Text.includes('ShapeEval('));
    out.push({ Gate: '+grad', From: i, To: i, ...carried(main, walk, i, i) });
  }
  return out.sort((a, b) => a.From - b.From);
};

/** Per gate, the LARGEST carried set among its sites (a function-level gate has several). */
export const gatePeaks = (sites: readonly GateSite[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const s of sites) out[s.Gate] = Math.max(out[s.Gate] ?? 0, s.Carried);
  return out;
};

export { rematLinesOf };
