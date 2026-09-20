/**
 * Source and style readers for the scene read-after-write ledger.
 *
 * Same discipline as `Shadow.Adaptive.Source`: nothing here restates a number the engine owns. The
 * read and write sites are matched against the real bodies in `Core/WebGL2.Renderer.ts`, and the
 * glass geometry comes out of `Jwift.Glass.jss` and `Perf.jss` so a retuned class or a re-spaced
 * grid moves the prediction instead of silently invalidating it.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');
const REPO = join(HERE, '..', '..', '..', '..');

const read = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

export const readRenderer = (): string => read(join(SRC, 'Core', 'WebGL2.Renderer.ts'));
export const readJaui = (): string => read(join(SRC, 'Core', 'Jaui.ts'));
export const readJwiftGlass = (): string =>
  read(join(REPO, 'ShowStudio.Libraries', 'Jwift', 'Jwift.Angular', 'src', 'Glass', 'Jwift.Glass.jss'));
export const readPerfJss = (): string =>
  read(join(REPO, 'ShowStudio.App', 'src', 'Dev', 'Perf', 'Perf.jss'));
/** The app shell's own sheet. `Screen` is the rounded, clipping node every page in the app sits
 *  inside, so its radius is in every node's clip stack — see `Occlusion.GlassGrid.test.ts`. */
export const readAppJss = (): string =>
  read(join(REPO, 'ShowStudio.App', 'src', 'App.jss'));

/** The body of a top-level `Name = (args) => { ... }` class field, brace-matched. */
export const arrowBody = (source: string, name: string): string => {
  const header = new RegExp(`\\n\\s*(?:private\\s+)?${name}\\s*=\\s*\\(`).exec(source);
  if (!header) throw new Error(`could not find ${name}`);
  const open = source.indexOf('{', source.indexOf('=>', header.index));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) return source.slice(open + 1, i); }
  }
  throw new Error(`unbalanced braces in ${name}`);
};

/** The body of a `get Name(): T { ... }` accessor, brace-matched. */
export const getterBody = (source: string, name: string): string => {
  const header = new RegExp(`\\n\\s*get\\s+${name}\\s*\\(`).exec(source);
  if (!header) throw new Error(`could not find getter ${name}`);
  const open = source.indexOf('{', source.indexOf(')', header.index));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) return source.slice(open + 1, i); }
  }
  throw new Error(`unbalanced braces in getter ${name}`);
};

/** Every `gl.draw*(` line in the renderer, with the line above it. A draw entry point that can
 *  target the scene must be preceded by the ledger's write note. */
export const drawSites = (source: string): { Line: string; Before: string; Index: number }[] => {
  const lines = source.split('\n');
  const out: { Line: string; Before: string; Index: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/\bgl\.draw(Arrays|Elements)(Instanced)?\s*\(/.test(lines[i])) {
      out.push({ Line: lines[i].trim(), Before: (lines[i - 1] ?? '').trim(), Index: i + 1 });
    }
  }
  return out;
};

/** A JSS class body, by exact name at column 0 (`Name {` or `Name : Base {`). */
export const jssClass = (sheet: string, name: string): string => {
  const header = new RegExp(`\\n${name}\\s*(?::[^\\n{]*)?\\{`).exec(sheet);
  if (!header) throw new Error(`no JSS class ${name}`);
  const open = sheet.indexOf('{', header.index);
  const close = sheet.indexOf('\n}', open);
  return sheet.slice(open + 1, close);
};

/** One property out of a JSS class body, comments stripped. */
export const jssValue = (body: string, name: string): string => {
  const m = new RegExp(`\\n\\s*${name}:\\s*([^\\n]+)`).exec(body);
  if (!m) throw new Error(`no ${name}`);
  return m[1].replace(/\/\/.*$/, '').trim();
};

/** A leading numeric value, unit suffix ignored (`16pt` -> 16, `0.28` -> 0.28). */
export const jssNumber = (body: string, name: string): number => {
  const raw = jssValue(body, name);
  const m = /^-?[\d.]+/.exec(raw);
  if (!m) throw new Error(`${name} is not numeric: ${raw}`);
  return parseFloat(m[0]);
};

/** `BackdropFilter: Blur(4pt) ...` -> 4. This is the node's BackdropFrostBlur. */
export const jssBlurPt = (body: string, name: string): number => {
  const m = /Blur\(\s*(-?[\d.]+)/.exec(jssValue(body, name));
  if (!m) throw new Error(`${name} has no Blur()`);
  return parseFloat(m[1]);
};
