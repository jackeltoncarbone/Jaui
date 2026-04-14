/**
 * TypeScript module declaration for `*.jss` imports. The Vite plugin
 * transforms these at build time into JSON-literal modules whose default
 * export is a `Stylesheet` — a class-name-keyed map of pre-routed rulesets.
 *
 * To enable, include this file in your tsconfig's `include` list (or import
 * it once as a side-effect from an entry point).
 */
declare module '*.jss' {
  import type { Stylesheet } from './Jss.Parser';
  const sheet: Stylesheet;
  export default sheet;
}
