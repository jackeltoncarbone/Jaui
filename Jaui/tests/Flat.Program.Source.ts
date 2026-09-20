/**
 * Reads the panel shader and the renderer's program routing straight out of the REAL sources.
 *
 * Same discipline as `Border.Hairline.Source` and `Scene.Restarts.test`: `WebGL2.Renderer.ts`
 * imports `.gen.ts` shader wrappers that only exist after a build, so it cannot be instantiated
 * here — what CAN be done, and is the whole point of this lane, is to run the preprocessor over
 * `Jiv.Panel.frag` exactly as `ShaderBatch.Add` does and compare the variants to each other.
 *
 * The claim the lane rests on is bit-identity BY CONSTRUCTION: the flat program is a strict
 * DELETION from the same source, never a rewrite. That is a property of the text, and the text is
 * what this file measures.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (...p: string[]): string =>
  readFileSync(join(HERE, '..', 'src', ...p), 'utf8').replace(/\r\n/g, '\n');

export const readPanelFrag = (): string => src('Jiv', 'Shaders', 'Jiv.Panel.frag');
export const readRenderer = (): string => src('Core', 'WebGL2.Renderer.ts');
export const readJaui = (): string => src('Core', 'Jaui.ts');
export const readInstanceBuffer = (): string => src('Jiv', 'Jiv.InstanceBuffer.ts');

/** The three defines `_compilePanelShader` builds the panel program from. */
export const VARIANTS = ['MATERIAL_GLASS', 'MATERIAL_NONE', 'MATERIAL_FLAT'] as const;
export type Variant = (typeof VARIANTS)[number];

// ── A minimal C preprocessor, over exactly the constructs this shader uses ────────────────────
//
// `#if` / `#elif` / `#else` / `#endif` with expressions built from `defined(NAME)`, `!`, `&&`,
// `||` and parentheses. Anything else in the expression is a hard throw rather than a guess: a
// preprocessor that silently mis-evaluates would make every assertion below vacuous.

const evalDefined = (expr: string, defs: ReadonlySet<string>): boolean => {
  const js = expr
    .replace(/defined\s*\(\s*([A-Za-z_]\w*)\s*\)/g, (_m, name: string) => (defs.has(name) ? 'true' : 'false'))
    .replace(/defined\s+([A-Za-z_]\w*)/g, (_m, name: string) => (defs.has(name) ? 'true' : 'false'))
    .trim();
  if (!/^[\s!&|()truefals]+$/.test(js)) {
    throw new Error(`[Flat.Program] unsupported preprocessor expression: ${expr}`);
  }
  // eslint-disable-next-line no-new-func
  return Function(`"use strict"; return (${js});`)() as boolean;
};

/**
 * Run the conditionals for one set of defines and return the surviving lines, each tagged with
 * its 1-based line number in the ORIGINAL file. The numbers are what make "is flat a subsequence
 * of none" a statement about deletion rather than about text that merely happens to match.
 */
export const preprocess = (source: string, defines: readonly string[]): Array<{ N: number; Text: string }> => {
  const defs = new Set(defines);
  const out: Array<{ N: number; Text: string }> = [];
  // Each open `#if` pushes { Taken: has any arm been taken, Active: is THIS arm live }.
  const stack: Array<{ Taken: boolean; Active: boolean; Parent: boolean }> = [];
  const live = (): boolean => stack.every((f) => f.Active);
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const directive = /^\s*#\s*(if|ifdef|ifndef|elif|else|endif)\b(.*)$/.exec(line);
    if (directive) {
      const kind = directive[1];
      const rest = directive[2];
      if (kind === 'if' || kind === 'ifdef' || kind === 'ifndef') {
        const parent = live();
        const value =
          kind === 'ifdef' ? defs.has(rest.trim())
          : kind === 'ifndef' ? !defs.has(rest.trim())
          : evalDefined(rest, defs);
        stack.push({ Taken: value, Active: parent && value, Parent: parent });
      } else if (kind === 'elif') {
        const f = stack[stack.length - 1];
        if (!f) throw new Error(`[Flat.Program] #elif with no open #if at line ${i + 1}`);
        const value = !f.Taken && evalDefined(rest, defs);
        f.Active = f.Parent && value;
        f.Taken = f.Taken || value;
      } else if (kind === 'else') {
        const f = stack[stack.length - 1];
        if (!f) throw new Error(`[Flat.Program] #else with no open #if at line ${i + 1}`);
        f.Active = f.Parent && !f.Taken;
        f.Taken = true;
      } else {
        if (stack.pop() === undefined) throw new Error(`[Flat.Program] #endif with no open #if at line ${i + 1}`);
      }
      continue;
    }
    if (live()) out.push({ N: i + 1, Text: line });
  }
  if (stack.length !== 0) throw new Error('[Flat.Program] unterminated #if in Jiv.Panel.frag');
  return out;
};

/** Comments and blank lines carry no instructions; only these lines are evidence. */
export const codeLines = (lines: ReadonlyArray<{ N: number; Text: string }>): Array<{ N: number; Text: string }> => {
  const out: Array<{ N: number; Text: string }> = [];
  let inBlock = false;
  for (const l of lines) {
    let t = l.Text;
    if (inBlock) {
      const end = t.indexOf('*/');
      if (end < 0) continue;
      t = t.slice(end + 2);
      inBlock = false;
    }
    for (;;) {
      const open = t.indexOf('/*');
      if (open < 0) break;
      const close = t.indexOf('*/', open + 2);
      if (close < 0) { t = t.slice(0, open); inBlock = true; break; }
      t = t.slice(0, open) + t.slice(close + 2);
    }
    const slash = t.indexOf('//');
    if (slash >= 0) t = t.slice(0, slash);
    t = t.trim();
    if (t.length !== 0) out.push({ N: l.N, Text: t });
  }
  return out;
};

/** Every `{`/`}` balances, and the net is zero — a variant that does not is a build break. */
export const braceBalance = (lines: ReadonlyArray<{ N: number; Text: string }>): number => {
  let depth = 0;
  let min = 0;
  for (const l of lines) {
    for (const ch of l.Text) {
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth < min) min = depth; }
    }
  }
  if (min < 0) throw new Error(`[Flat.Program] brace went negative (depth ${min})`);
  return depth;
};

/** The compiled text of one variant, comments and blanks removed. */
export const variantCode = (variant: Variant): Array<{ N: number; Text: string }> =>
  codeLines(preprocess(readPanelFrag(), [variant]));

/**
 * Every line of `sub` that is NOT in `sup` at the same original line number, in order.
 *
 * Empty means `sub` is reachable from `sup` by deleting lines and changing nothing — the exact
 * property that makes one variant's arithmetic identical to the other's. A non-empty result names
 * the lines that would have to be justified one by one.
 */
export const linesNotIn = (
  sub: ReadonlyArray<{ N: number; Text: string }>,
  sup: ReadonlyArray<{ N: number; Text: string }>,
): Array<{ N: number; Text: string }> => {
  const have = new Map<number, string>();
  for (const s of sup) have.set(s.N, s.Text);
  return sub.filter((s) => have.get(s.N) !== s.Text);
};

/** Executable TypeScript only — a comment can name anything. */
export const stripTsComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
