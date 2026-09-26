const VAR_REF = /@([A-Za-z_][A-Za-z0-9_]*)/g;

/** Every `@Name` a string references, into `out`. */
export const VarRefsIn = (s: string, out: Set<string>): void => {
  if (s.indexOf('@') < 0) return;
  for (const m of s.matchAll(VAR_REF)) out.add(m[1]);
};

/** A name no var can have (no @Name matches it), standing for values too deep to read. */
export const UNREADABLE_REF = '#deep';

/** Every var authored values reference: `@Name` in any string, and the name of a predicate's `@Name` test.
 *  `skip` stops the walk at objects that are not authored values (a node an attach points at). */
export const CollectVarRefs = (values: readonly unknown[], skip: (o: object) => boolean): Set<string> => {
  const out = new Set<string>();
  const walk = (v: unknown, depth: number): void => {
    if (typeof v === 'string') { VarRefsIn(v, out); return; }
    if (v === null || typeof v !== 'object' || skip(v)) return;
    // Deeper than any authored value nests: named as a var nothing defines, so a reader treats it as reaching.
    if (depth > 12) { out.add(UNREADABLE_REF); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    const o = v as Record<string, unknown>;
    if (o['Kind'] === 'Var' && typeof o['Name'] === 'string') out.add(o['Name']);
    for (const k in o) walk(o[k], depth + 1);
  };
  for (const v of values) walk(v, 0);
  return out;
};
