#!/usr/bin/env node
/**
 * Pre-build step: wrap every .vert/.frag/.glsl file under src/ in a
 * sibling `.gen.ts` module that exports the source as a string literal.
 *
 * Why: the Renderer files used to import shaders via Vite's `?raw` query,
 * which esbuild (Angular's prod bundler) doesn't recognize. Wrapping them
 * in plain TS modules makes the imports portable across both bundlers
 * AND keeps the .vert/.frag files editable with shader-aware tooling.
 *
 * Generated `.gen.ts` files are gitignored — they're rebuilt on every
 * `npm run build` (and once before `tsc` reads the source tree).
 */

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');

const SHADER_EXTS = new Set(['.vert', '.frag', '.glsl', '.wgsl']);

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else {
      const dot = entry.lastIndexOf('.');
      if (dot > 0 && SHADER_EXTS.has(entry.slice(dot))) out.push(full);
    }
  }
  return out;
};

const escape = (s) => s
  .replace(/\\/g, '\\\\')
  .replace(/`/g, '\\`')
  .replace(/\$\{/g, '\\${');

let count = 0;
for (const path of walk(SRC)) {
  const content = readFileSync(path, 'utf8');
  const ts = `// AUTO-GENERATED — do not edit. Regenerate via \`npm run build:shaders\`.\nexport default \`${escape(content)}\`;\n`;
  writeFileSync(`${path}.gen.ts`, ts);
  count++;
}
console.log(`[shaders] wrapped ${count} file(s) into .gen.ts`);
