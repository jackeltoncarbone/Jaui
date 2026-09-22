/**
 * The glass program's variants (lane glassreg), read out of the REAL `Jiv.Panel.frag` through the
 * same preprocessor `Flat.Program.Source` runs, plus the two things a lane with no GLSL compiler
 * can still check about a variant's `main`:
 *
 *   1. SCOPE. Every use of a local resolves to a declaration that is in scope at that point: in an
 *      enclosing block, and earlier. A `#if` that removed a declaration and left a reader, or a
 *      move that put a reader above its writer, fails here instead of at the first page load.
 *   2. LIVENESS. For every local, its declaration and its last use, in program order. A value is
 *      HELD across a statement when it was declared before it and is read after it; the scalar
 *      components held across each heavy statement of the program are the register map.
 *
 * Program order is text order: `main` has no loop, so the only approximation is that both arms of
 * a branch count, which is what an allocator that cannot see the branch outcome has to assume.
 */
import { preprocess, codeLines, readPanelFrag } from './Flat.Program.Source';

/** Every glass program the renderer can build, by define set. Boot builds the first three; an armed
 *  `?glass-reg` builds one of the other three rows' worth instead of none. */
export const GLASS_PROGRAMS = {
  GLASS: ['MATERIAL_GLASS'],
  BORDER_ONLY: ['MATERIAL_GLASS', 'GLASS_BORDER_ONLY'],
  NO_LIGHT: ['MATERIAL_GLASS', 'GLASS_NO_GLOW', 'GLASS_NO_SPEC'],
  NO_GLOW: ['MATERIAL_GLASS', 'GLASS_NO_GLOW'],
  NO_SPEC: ['MATERIAL_GLASS', 'GLASS_NO_SPEC'],
  REG: ['MATERIAL_GLASS', 'GLASS_REG'],
  REG_BORDER_ONLY: ['MATERIAL_GLASS', 'GLASS_REG', 'GLASS_BORDER_ONLY'],
  REG_NO_LIGHT: ['MATERIAL_GLASS', 'GLASS_REG', 'GLASS_NO_GLOW', 'GLASS_NO_SPEC'],
  REMAT: ['MATERIAL_GLASS', 'GLASS_REG', 'GLASS_REG_REMAT'],
  REMAT_BORDER_ONLY: ['MATERIAL_GLASS', 'GLASS_REG', 'GLASS_REG_REMAT', 'GLASS_BORDER_ONLY'],
  REMAT_NO_LIGHT: ['MATERIAL_GLASS', 'GLASS_REG', 'GLASS_REG_REMAT', 'GLASS_NO_GLOW', 'GLASS_NO_SPEC'],
  NOGATES: ['MATERIAL_GLASS', 'GLASS_NO_SKIP_GATES'],
  NOGATES_BORDER_ONLY: ['MATERIAL_GLASS', 'GLASS_NO_SKIP_GATES', 'GLASS_BORDER_ONLY'],
  NOGATES_NO_LIGHT: ['MATERIAL_GLASS', 'GLASS_NO_SKIP_GATES', 'GLASS_NO_GLOW', 'GLASS_NO_SPEC'],
} as const satisfies Record<string, readonly string[]>;
export type GlassProgramName = keyof typeof GLASS_PROGRAMS;

export type Line = { N: number; Text: string };

export const glassProgram = (name: GlassProgramName): Line[] =>
  codeLines(preprocess(readPanelFrag(), GLASS_PROGRAMS[name]));

/** The lines of `main`, from its signature to its closing brace. */
export const mainOf = (lines: readonly Line[]): Line[] => {
  const start = lines.findIndex((l) => l.Text === 'void main() {');
  if (start < 0) throw new Error('[Glass.Reg] no main');
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i].Text) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    if (depth === 0) return lines.slice(start, i + 1);
  }
  throw new Error('[Glass.Reg] main never closes');
};

/** The block that opens on line `i` (its last `{`), through the line that closes it. */
const blockEnd = (lines: readonly Line[], i: number): number => {
  let depth = 0;
  for (let j = i; j < lines.length; j++) {
    const t = j === i ? lines[j].Text.slice(lines[j].Text.lastIndexOf('{')) : lines[j].Text;
    for (const ch of t) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    if (depth === 0) return j;
  }
  throw new Error('[Glass.Reg] unclosed block');
};

/**
 * `main` as the GLASS compiler sees it once `materialType` is the constant 1.0: the two non-glass
 * arms (the flat panel's filtered sample, and the plain stroke behind the dangling `else`) are
 * dead code, and a read inside them holds nothing. Both are located by their own text and removed
 * with their braces; a program in which either is missing throws rather than being counted as-is.
 */
export const foldGlassArms = (main: readonly Line[]): Line[] => {
  const out = [...main];
  const flat = out.findIndex((l) => l.Text === '} else if (hasBackdropFilter && borderOnly == 0.0) {');
  if (flat < 0) throw new Error('[Glass.Reg] no flat-sample arm to fold');
  const flatEnd = blockEnd(out, flat);
  out.splice(flat, flatEnd - flat + 1, { N: out[flat].N, Text: '}' });
  const stroke = out.findIndex((l, i) => l.Text === '} else' && out[i + 1]?.Text === '{');
  if (stroke < 0) throw new Error('[Glass.Reg] no plain-stroke arm to fold');
  const strokeEnd = blockEnd(out, stroke + 1);
  out.splice(stroke, strokeEnd - stroke + 1, { N: out[stroke].N, Text: '}' });
  return out;
};

/** A line's multiset key: the text alone, so a moved line still matches itself. */
export const multiset = (lines: readonly Line[]): Map<string, number> => {
  const m = new Map<string, number>();
  for (const l of lines) m.set(l.Text, (m.get(l.Text) ?? 0) + 1);
  return m;
};

/** `a - b` as a multiset, in `a`'s order: the lines `a` has more copies of than `b`. */
export const multisetMinus = (a: readonly Line[], b: readonly Line[]): string[] => {
  const have = multiset(b);
  const out: string[] = [];
  for (const l of a) {
    const n = have.get(l.Text) ?? 0;
    if (n > 0) have.set(l.Text, n - 1);
    else out.push(l.Text);
  }
  return out;
};

// ── Scope and liveness ─────────────────────────────────────────────────────────────────────────

const TYPES: Record<string, number> = { float: 1, int: 1, bool: 1, vec2: 2, vec3: 3, vec4: 4 };

export interface Local {
  Name: string;
  Components: number;
  /** Index into `main`'s lines of the declaration. */
  Decl: number;
  /** Indices of every line that reads or writes it after the declaration. */
  Uses: number[];
  Depth: number;
}

export interface ScopeWalk {
  Locals: Local[];
  /** Uses of a name `main` declares somewhere, at a point where no declaration of it is visible. */
  Dangling: Array<{ Name: string; Line: string }>;
  /** Same-scope redeclarations - a compile error in GLSL. */
  Redeclared: Array<{ Name: string; Line: string }>;
}

/**
 * Walk `main` with a scope stack. Declarations are `[const] <type> <name>` followed by `=`, `;` or
 * `,` (main has no comma lists, and the walk refuses one rather than miscounting). Identifiers after
 * a `.` are members and swizzles, never locals.
 */
export const walkScopes = (main: readonly Line[], remat: ReadonlySet<number> = new Set()): ScopeWalk => {
  const declared = new Set<string>();
  const declRe = /\b(?:const\s+)?(float|int|bool|vec2|vec3|vec4)\s+([A-Za-z_]\w*)\s*([=;,])/g;
  for (const l of main) for (const m of l.Text.matchAll(declRe)) declared.add(m[2]);

  const locals: Local[] = [];
  const dangling: ScopeWalk['Dangling'] = [];
  const redeclared: ScopeWalk['Redeclared'] = [];
  const stack: Array<Map<string, number>> = [new Map()];
  const resolve = (name: string): number | undefined => {
    for (let s = stack.length - 1; s >= 0; s--) {
      const id = stack[s].get(name);
      if (id !== undefined) return id;
    }
    return undefined;
  };

  // A RECOMPUTE (a line only GLASS_REG_REMAT has, assigning a local afresh) starts a new VALUE of
  // that local: the old one dies at its last read before it. One new value per local per contiguous
  // run of recompute lines, so both arms of a recomputing `if`/`else` write the same value.
  let rematRun = -1;
  let prevRemat = false;
  const rematValue = new Map<string, number>();
  main.forEach((line, idx) => {
    const text = line.Text;
    const isRemat = remat.has(line.N);
    if (isRemat && !prevRemat) { rematRun++; rematValue.clear(); }
    prevRemat = isRemat;
    const assign = isRemat ? /^([A-Za-z_]\w*)\s*=(?!=)/.exec(text) : null;
    if (assign !== null && declared.has(assign[1])) {
      const name = assign[1];
      for (let s = stack.length - 1; s >= 0; s--) {
        const old = stack[s].get(name);
        if (old === undefined) continue;
        let id = rematValue.get(name);
        if (id === undefined) {
          id = locals.length;
          locals.push({ Name: name, Components: locals[old].Components, Decl: idx, Uses: [], Depth: s });
          rematValue.set(name, id);
        }
        stack[s].set(name, id);
        break;
      }
    }
    // Declarations on this line, by the character offset of their name.
    const decls = new Map<number, { Name: string; Components: number }>();
    for (const m of text.matchAll(declRe)) {
      if (m[3] === ',') throw new Error(`[Glass.Reg] comma declaration in main: ${text}`);
      const at = (m.index ?? 0) + m[0].indexOf(m[2], m[1].length);
      decls.set(at, { Name: m[2], Components: TYPES[m[1]] });
    }
    const tokRe = /[{}]|\.?[A-Za-z_]\w*/g;
    for (const m of text.matchAll(tokRe)) {
      const tok = m[0];
      if (tok === '{') { stack.push(new Map()); continue; }
      if (tok === '}') { stack.pop(); continue; }
      if (tok.startsWith('.')) continue;
      const d = decls.get(m.index ?? -1);
      if (d !== undefined) {
        const top = stack[stack.length - 1];
        if (top.has(d.Name)) redeclared.push({ Name: d.Name, Line: text });
        // The initialiser reads OUTER bindings of the same name, never the new one; GLSL puts the
        // new name in scope at the end of its declarator, which is after every use on this line
        // that this shader has.
        top.set(d.Name, locals.length);
        locals.push({ Name: d.Name, Components: d.Components, Decl: idx, Uses: [], Depth: stack.length - 1 });
        continue;
      }
      if (!declared.has(tok)) continue;
      const id = resolve(tok);
      if (id === undefined) { dangling.push({ Name: tok, Line: text }); continue; }
      const uses = locals[id].Uses;
      if (uses[uses.length - 1] !== idx) uses.push(idx);
    }
  });
  return { Locals: locals, Dangling: dangling, Redeclared: redeclared };
};

/**
 * Values that are NOT counted as held registers: each is a flat varying read (or one `max` / `abs`
 * of one) that the compiler can re-read at no cost, or a constant. Named rather than inferred, so a
 * change to the list is a visible decision. Everything else declared in `main` counts.
 */
export const FREE_ALIASES = new Set([
  'panelCenter', 'panelHalfSize', 'shadowOffset', 'shadowBlur', 'borderWidth', 'borderOnly',
  'borderEdgeAa', 'smoothness', 'opacity', 'materialType', 'brightness', 'saturation', 'contrast',
  'frostLod', 'thickness', 'bezelWidth', 'refractionStrength', 'bezelScale', 'bodyTint',
  'lightIntensity', 'fresnelStrength', 'specIntensity', 'specGlow', 'chromaticAberration',
  '_blurFadePacked', 'edgeLightTop', 'edgeLightBottom', 'borderVariance', 'curvature', 'effectiveSmooth',
  's', 'GROUND_BOUNCE', 'BORDER_MIN_DEVICE_PX',
  // Dead in every glass program: read only by the non-glass arms `materialType` folds away.
  'hasBackdropFilter',
]);

/** Where each heavy statement sits in a program's `main`: the index of the first line containing it. */
export const ANCHORS = {
  /** The main corner field: `ShapeEval`, 6-8 pow on 87% of fragments. */
  sdf: 'ShapeEval(p, panelHalfSize, v_Radii, effectiveSmooth, mode, dist, normal);',
  /** The drop shadow's corner field: a second 6 pow. */
  shadow: 'float shadowDist = ShapeSDF(sp, panelHalfSize, v_Radii, effectiveSmooth, mode);',
  /** The refraction footprint: the one derivative. */
  lod: 'float refractFp = length(fwidth(refractOffset));',
  /** The body's taps. */
  taps: 'vec3 sG = sampleBackdrop(uvG, lodBoost, frostLod);',
  /** The fill source: the gradient loop and the OKLab conversion, compiled in whatever the mode. */
  fill: 'vec4 fillSrc = resolveBgFill(panelLocal);',
  /** The wide rim glow's tap. */
  glow: 'vec3 rimSample = sampleBackdrop(rimUv, 0.0, frostLod);',
  /** The highlight (aave's): the adaptive composite, where it holds the most. */
  spec: 'float darken = smoothstep(0.3, 0.7, specLuma);',
  /** The border zone's tap. */
  zone: 'vec3 bSample = sampleBackdrop(bUv, bLod, frostLod);',
} as const;
export type Anchor = keyof typeof ANCHORS;

export interface Held { Components: number; Names: string[] }

/** The values held ACROSS the anchor statement: declared before it and read after it. `null` when
 *  the program does not contain the statement at all. */
export const heldAcross = (main: readonly Line[], walk: ScopeWalk, anchor: Anchor): Held | null => {
  const at = main.findIndex((l) => l.Text.includes(ANCHORS[anchor]));
  if (at < 0) return null;
  const names: string[] = [];
  let components = 0;
  for (const v of walk.Locals) {
    if (FREE_ALIASES.has(v.Name)) continue;
    if (v.Decl >= at) continue;
    const last = v.Uses.length === 0 ? v.Decl : v.Uses[v.Uses.length - 1];
    if (last <= at) continue;
    names.push(v.Name);
    components += v.Components;
  }
  return { Components: components, Names: names.sort() };
};

/** The original line numbers only a GLASS_REG_REMAT program has: its recomputes. Empty otherwise. */
export const rematLinesOf = (name: GlassProgramName): Set<number> => {
  const defines: readonly string[] = GLASS_PROGRAMS[name];
  if (!defines.includes('GLASS_REG_REMAT')) return new Set();
  const twin = codeLines(preprocess(readPanelFrag(), defines.filter((d) => d !== 'GLASS_REG_REMAT')));
  const inTwin = new Set(twin.map((l) => l.N));
  return new Set(glassProgram(name).filter((l) => !inTwin.has(l.N)).map((l) => l.N));
};

/** The whole map for one program: held components at every anchor it has, dead arms folded. */
export const registerMap = (name: GlassProgramName): Record<Anchor, Held | null> => {
  const main = foldGlassArms(mainOf(glassProgram(name)));
  const walk = walkScopes(main, rematLinesOf(name));
  const out = {} as Record<Anchor, Held | null>;
  for (const a of Object.keys(ANCHORS) as Anchor[]) out[a] = heldAcross(main, walk, a);
  return out;
};
