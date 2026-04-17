import { readFileSync } from 'node:fs';
import { ParseJss, type ParsedJss } from './Jss.Parser';

/**
 * Vite plugin: import `.jss` files as typed style modules.
 *
 * Usage in vite.config.ts:
 *
 *   import { JssPlugin } from 'jwift/Jss/Jss.VitePlugin';
 *   export default defineConfig({ plugins: [JssPlugin()] });
 *
 * In your code:
 *
 *   import Styles from './app.jss';
 *   new Jiv({ ...Styles.Toolbar, ... });
 *
 * The plugin parses each `.jss` file at build time and emits a small JS
 * module whose default export is the pre-routed stylesheet — no runtime
 * parse cost. Source maps aren't emitted; .jss debugging is easy enough
 * to do from the parsed output.
 */

interface VitePluginLike {
  name: string;
  enforce?: 'pre' | 'post';
  load?: (id: string) => string | null | undefined;
  transform?: (code: string, id: string) => string | null | undefined;
}

export const JssPlugin = (): VitePluginLike => ({
  name: 'jwift-jss',
  enforce: 'pre',
  load(id: string): string | null {
    // Vite resolvers pass absolute paths (possibly with `?query` suffixes);
    // strip any query and normalize extension check.
    const clean = id.split('?')[0];
    if (!clean.endsWith('.jss')) return null;
    const source = readFileSync(clean, 'utf8');
    const sheet = ParseJss(source);
    return _emit(sheet);
  },
});

/** Serialize a parsed stylesheet (sheet + vars) into a JS module string. */
const _emit = (parsed: ParsedJss): string => {
  // JSON.stringify is safe — every value is a string, enum literal, or plain
  // object of those. No functions, no dates, no cycles.
  const body = JSON.stringify(parsed, null, 2);
  return `export default ${body};\n`;
};
