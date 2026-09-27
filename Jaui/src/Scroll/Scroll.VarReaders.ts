import type { Jiv } from '../Jiv/Jiv';
import { Element } from '../Element/Element';
import { VarRefsIn, CollectVarRefs } from '../Core/Var.Refs';

/** The vars a scroll container publishes to its subtree (`ScrollManager._publishVars`). */
export const SCROLL_VARS: ReadonlySet<string> = new Set([
  'ScrollY', 'ScrollX', 'ScrollMaxY', 'ScrollMaxX', 'ScrollFracY', 'ScrollFracX', 'ScrollProgress',
  'ViewportH', 'ViewportW', 'ContentH', 'ContentW', 'ScrollActive',
  'OverscrollTop', 'OverscrollBottom', 'OverscrollLeft', 'OverscrollRight',
]);

/** Identifiers a length resolves from its own context, never from a var table (`Core/Length.ts`).
 *  `Height`/`Width` are the node's OWN box (Core/Length.ts's per-node builtin, alongside Presence)
 *  and never depend on any scroller's state, so a reference to them alone never forces a layout
 *  re-solve or a render-only wake on a scroll tick. */
const BUILTINS: ReadonlySet<string> = new Set(['Presence', 'Entering', 'Exiting', 'Height', 'Width']);

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

/** Per-node classification of how a set of changed scroll vars reaches a subtree — the split
 *  `ScrollManager._publishVars` needs to skip a layout re-solve on a scroll frame. A node's authored
 *  bags split into two groups (mirrors `Jiv.AuthoredValues`):
 *    - LAYOUT bags (Layout, ChildLayout, TextStyle, PointScale) — a FontSize, a Padding, a Width
 *      keyed on a scroll var changes the box itself and needs a real layout re-solve.
 *    - STYLE bags (Style, PredicateStyles, TextSelectionStyle, Springs) — VisualScale, VisualTranslate,
 *      Opacity, Tint, colors: render-time only, no layout/hit-test impact.
 *  Only DIRECT `@Name` references are resolved through an indirection chain (same `defs`/`reaches`
 *  walk as `SubtreeReadsScrollVars`, generalized to the caller's own changed-var set instead of the
 *  fixed `SCROLL_VARS`); a node that reaches a changed var only through layout bags — anywhere in the
 *  chain — forces `NeedsLayout`, which the caller then treats as "fall back to MarkLayoutDirty for
 *  everything" rather than trying to salvage the nodes that were otherwise render-only. */
export interface ScrollVarUsage {
  /** True when the subtree needs a real layout re-solve (some node's Layout/ChildLayout/TextStyle/
   *  PointScale reaches a changed var). The caller should MarkLayoutDirty and ignore `RenderOnly`
   *  entirely — a solve re-resolves every node's style too, so there is nothing left to wake by hand. */
  NeedsLayout: boolean;
  /** Nodes whose STYLE (and only style) reaches a changed var, when `NeedsLayout` is false — waking
   *  each one's StyleAnimator directly re-resolves its render props without touching layout. */
  RenderOnly: Jiv[];
}

export const AnalyzeScrollVarUsage = (
  root: Jiv,
  changedVars: ReadonlySet<string>,
  globalVars: ReadonlyMap<string, string>,
): ScrollVarUsage => {
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

  const reaches = (name: string, visiting: Set<string>): boolean => {
    if (changedVars.has(name)) return true;
    if (BUILTINS.has(name)) return false;
    if (visiting.has(name)) return false;
    const local = defs.get(name);
    const global = globalVars.get(name);
    // Same conservative default as `SubtreeReadsScrollVars`: a name this walk cannot resolve at all
    // might still resolve some other way at runtime, so treat it as reaching (safe direction on
    // both branches here — an extra layout solve is wasted work, an extra style Wake is a no-op).
    if (local === undefined && global === undefined) return true;
    visiting.add(name);
    const inner = new Set<string>();
    if (local !== undefined) for (const v of local) if (typeof v === 'string') VarRefsIn(v, inner);
    if (global !== undefined) VarRefsIn(global, inner);
    for (const r of inner) if (reaches(r, visiting)) return true;
    return false;
  };
  const anyReaches = (refs: ReadonlySet<string>): boolean => {
    for (const r of refs) if (reaches(r, new Set())) return true;
    return false;
  };

  const renderOnly: Jiv[] = [];
  let needsLayout = false;
  const walk = (node: Element): void => {
    addDefs(node);
    if ('Style' in node) {
      const jiv = node as unknown as Jiv;
      const split = _cachedSplit(jiv);
      if (anyReaches(split.LayoutRefs)) needsLayout = true;
      else if (anyReaches(split.StyleRefs)) renderOnly.push(jiv);
    }
    for (const c of node.Children) walk(c);
  };
  walk(root);
  return { NeedsLayout: needsLayout, RenderOnly: needsLayout ? [] : renderOnly };
};

interface _VarRefSplit {
  Version: number;
  LayoutRefs: ReadonlySet<string>;
  StyleRefs: ReadonlySet<string>;
}

/** Per-node layout-vs-style var-ref split, cached on `AuthoredVersion` exactly like
 *  `Element.AuthoredVarRefs` caches its own (unsplit) set — so a scroll frame that doesn't touch any
 *  authoring re-walks nothing here; only a class/style apply invalidates it. Kept in a WeakMap rather
 *  than on the Jiv itself so this stays a Scroll-only concern. */
const _splitCache = new WeakMap<Jiv, _VarRefSplit>();
const _skipElement = (o: object): boolean => o instanceof Element;

/** A `PredicateStyle` entry (a `:Foo`/`:(expr)` rule, or an `@If` responsive block) carries its OWN
 *  Layout/ChildLayout patch alongside Style/TextStyle — `@If (Width < 700) { Padding: ...; Color:
 *  ... }` sets both from ONE entry. Bucket each entry (predicate condition included, since a var the
 *  CONDITION reads governs whichever patch it applies) by what it can actually change: any
 *  Layout/ChildLayout/TextStyle patch present taints the whole entry as layout-affecting; a
 *  Style-or-TextStyle-only entry is render-only. */
const _predicateParts = (jiv: Jiv): { Layout: unknown[]; Style: unknown[] } => {
  const layout: unknown[] = [];
  const style: unknown[] = [];
  const list = jiv.PredicateStyles as unknown as ReadonlyArray<{
    Predicate?: unknown; Style?: unknown; TextStyle?: unknown; Layout?: unknown; ChildLayout?: unknown;
  }> | null;
  if (!list) return { Layout: layout, Style: style };
  for (const p of list) {
    const hasLayout = p.Layout !== undefined || p.ChildLayout !== undefined;
    if (hasLayout) layout.push(p.Predicate, p.Layout, p.ChildLayout, p.TextStyle, p.Style);
    else { style.push(p.Predicate, p.Style, p.TextStyle); }
  }
  return { Layout: layout, Style: style };
};

const _cachedSplit = (jiv: Jiv): _VarRefSplit => {
  const hit = _splitCache.get(jiv);
  if (hit !== undefined && hit.Version === jiv.AuthoredVersion) return hit;
  const predicateParts = _predicateParts(jiv);
  const split: _VarRefSplit = {
    Version: jiv.AuthoredVersion,
    LayoutRefs: CollectVarRefs(
      [jiv.Layout, jiv.ChildLayout, jiv.TextStyle, jiv.PointScale, ...predicateParts.Layout], _skipElement,
    ),
    StyleRefs: CollectVarRefs(
      [jiv.Style, jiv.TextSelectionStyle, jiv.Springs, ...predicateParts.Style], _skipElement,
    ),
  };
  _splitCache.set(jiv, split);
  return split;
};
