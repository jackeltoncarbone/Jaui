import type { Jiv } from '../Jiv/Jiv';
import type { Element } from '../Element/Element';
import { VarRefsIn } from '../Core/Var.Refs';

/** The vars a scroll container publishes to its subtree (`ScrollManager._publishVars`). */
export const SCROLL_VARS: ReadonlySet<string> = new Set([
  'ScrollY', 'ScrollX', 'ScrollMaxY', 'ScrollMaxX', 'ScrollFracY', 'ScrollFracX',
  'ViewportH', 'ViewportW', 'ContentH', 'ContentW', 'ScrollActive',
]);

/** Identifiers a length resolves from its own context, never from a var table (`Core/Length.ts`). */
const BUILTINS: ReadonlySet<string> = new Set(['Presence', 'Entering', 'Exiting']);

/**
 * Whether anything authored under `root` can read a var its scroll container publishes: by name, through a
 * var whose definition reaches one, or through a var whose definition it cannot see. A subtree that cannot
 * has nothing to re-resolve when the scroll moves, so the scroller need not re-solve its layout.
 */
export const SubtreeReadsScrollVars = (root: Jiv, globalVars: ReadonlyMap<string, string>): boolean => {
  const defs = new Map<string, Array<string | number | boolean>>();
  const addDefs = (node: Element): void => {
    const vars = (node as Partial<Jiv>).VarMap;
    if (vars === undefined || vars.size === 0) return;
    for (const [k, v] of vars) {
      const list = defs.get(k);
      if (list === undefined) defs.set(k, [v]); else list.push(v);
    }
  };
  for (let a = root.Parent; a !== null; a = a.Parent) addDefs(a);
  const refs = new Set<string>();
  const walk = (node: Element): void => {
    addDefs(node);
    const own = (node as Partial<Jiv>).AuthoredVarRefs?.();
    if (own !== undefined) for (const r of own) refs.add(r);
    for (const c of node.Children) walk(c);
  };
  walk(root);
  const reaches = (name: string, visiting: Set<string>): boolean => {
    if (SCROLL_VARS.has(name)) return true;
    if (BUILTINS.has(name) || visiting.has(name)) return false;
    const local = defs.get(name);
    const global = globalVars.get(name);
    if (local === undefined && global === undefined) return true;
    visiting.add(name);
    const inner = new Set<string>();
    if (local !== undefined) for (const v of local) if (typeof v === 'string') VarRefsIn(v, inner);
    if (global !== undefined) VarRefsIn(global, inner);
    for (const r of inner) if (reaches(r, visiting)) return true;
    return false;
  };
  for (const r of refs) if (reaches(r, new Set())) return true;
  return false;
};
