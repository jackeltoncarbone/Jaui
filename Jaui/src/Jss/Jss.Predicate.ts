import type { PredicateExpr } from './Jss.Parser';

/**
 * Runtime evaluator for predicates parsed by ParseJss — both compound
 * pseudo-selectors (`:(Hover && !Disabled)`) and `@If` responsive blocks
 * (`@If (Width >= 900)`).
 *
 * The parser produces a JSON-safe `PredicateExpr` AST (State / Compare /
 * Not / And / Or). At apply time the runtime walks each PredicateStyle
 * entry attached to a Jiv, evaluates the predicate against a context (the
 * Jiv's live state set + the current viewport size), and merges the entry's
 * Style/TextStyle/Layout/ChildLayout onto the effective style when true.
 *
 * The evaluator is intentionally tiny — no JIT, no caching, no short-
 * circuit beyond the boolean operators themselves. State sets are small
 * (typically ≤ 5 entries) and predicates are shallow trees, so a direct
 * recursive walk is faster than any caching scheme.
 *
 * Lives in its own file so the worker bundle can pull it in without
 * dragging the parser. ParseJss is build-time-only and is not in the
 * worker bundle.
 */

/** A node as the predicate evaluator sees it — resolved size, ancestry,
 *  classes, and live states. The runtime (Jiv) satisfies this directly; tests
 *  pass a literal. Only consulted for scoped (`Self`/`Parent`/`Ancestor`) and
 *  ancestor-context predicates; viewport/state predicates ignore it. */
export interface PredicateElement {
  readonly Width: number;
  readonly Height: number;
  readonly Parent: PredicateElement | null;
  readonly Classes: readonly string[];
  readonly States: ReadonlySet<string>;
  /** Author-set runtime style vars (`@Name`), read by `Var` predicates. */
  readonly Vars?: ReadonlyMap<string, string | number | boolean>;
}

/** Evaluation context: the element's live states + the current viewport
 *  (CSS px) for `Width`/`Height` comparisons, plus the element itself for
 *  scoped/ancestor queries. A bare `ReadonlySet<string>` is still accepted
 *  (states-only, module viewport, no element) so existing `:Hover` call sites
 *  work unchanged. */
export interface PredicateContext {
  States: ReadonlySet<string>;
  ViewportW: number;
  ViewportH: number;
  Element?: PredicateElement | null;
  /** Author-set runtime style vars (`@Name`), read by `Var` predicates. */
  Vars?: ReadonlyMap<string, string | number | boolean>;
}

/** Module-level current viewport (CSS px). The Canvas pushes this on resize
 *  via `SetPredicateViewport` so that style/text predicate reads — which pass
 *  only the element's state Set — still see the live viewport for `@If
 *  (Width …)` comparisons. Layout predicates are re-materialized explicitly
 *  (see Jiv.RecomputeResponsiveLayout) since the solver reads fields. */
let _vpW = 0;
let _vpH = 0;
export const SetPredicateViewport = (w: number, h: number): void => { _vpW = w; _vpH = h; };
export const PredicateViewportWidth = (): number => _vpW;
export const PredicateViewportHeight = (): number => _vpH;

const _normalize = (ctx: PredicateContext | ReadonlySet<string>): PredicateContext =>
  ctx instanceof Set ? { States: ctx, ViewportW: _vpW, ViewportH: _vpH } : ctx as PredicateContext;

export const EvaluatePredicate = (
  expr: PredicateExpr,
  ctx: PredicateContext | ReadonlySet<string>,
): boolean => _eval(expr, _normalize(ctx));

/** Resolve a size comparison's measured value (px), or null when the scope
 *  target doesn't exist (no element / no parent / no matching ancestor). */
const _scopeMetric = (
  scope: { Kind: 'Self' } | { Kind: 'Parent' } | { Kind: 'Ancestor'; Class: string } | undefined,
  metric: 'Width' | 'Height',
  ctx: PredicateContext,
): number | null => {
  if (!scope) return metric === 'Width' ? ctx.ViewportW : ctx.ViewportH;
  const el = ctx.Element;
  if (!el) return null;
  let target: PredicateElement | null = null;
  switch (scope.Kind) {
    case 'Self':   target = el; break;
    case 'Parent': target = el.Parent; break;
    case 'Ancestor': {
      let n = el.Parent;
      while (n && !n.Classes.includes(scope.Class)) n = n.Parent;
      target = n;
      break;
    }
  }
  if (!target) return null;
  return metric === 'Width' ? target.Width : target.Height;
};

const _eval = (expr: PredicateExpr, ctx: PredicateContext): boolean => {
  switch (expr.Kind) {
    case 'State': return ctx.States.has(expr.Name);
    case 'Var': {
      const v = ctx.Vars?.get(expr.Name);
      if (expr.Op === undefined) {
        // Bare `@Name` — truthy: present and not a falsy value.
        return v !== undefined && v !== false && v !== '' && v !== 0 && v !== 'false' && v !== '0';
      }
      // `@Name == value` / `!=` — compare as strings (vars ride the bridge as strings).
      const eq = String(v ?? '') === String(expr.Value);
      return expr.Op === '==' ? eq : !eq;
    }
    case 'Compare': {
      const v = _scopeMetric(expr.Scope, expr.Metric, ctx);
      if (v === null) return false;
      switch (expr.Op) {
        case '>':  return v >  expr.Value;
        case '>=': return v >= expr.Value;
        case '<':  return v <  expr.Value;
        case '<=': return v <= expr.Value;
        case '==': return v === expr.Value;
        case '!=': return v !== expr.Value;
      }
      return false;
    }
    case 'Ancestor': {
      let n = ctx.Element?.Parent ?? null;
      while (n) {
        if (n.Classes.includes(expr.Class) && (!expr.State || n.States.has(expr.State))) return true;
        if (expr.Direct) return false; // `Parent(X)` checks only the immediate parent
        n = n.Parent;
      }
      return false;
    }
    case 'Not':   return !_eval(expr.Expr, ctx);
    case 'And': {
      for (const e of expr.Exprs) if (!_eval(e, ctx)) return false;
      return true;
    }
    case 'Or': {
      for (const e of expr.Exprs) if (_eval(e, ctx)) return true;
      return false;
    }
  }
};
