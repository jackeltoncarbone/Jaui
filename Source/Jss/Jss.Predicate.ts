import type { PredicateExpr } from './Jss.Parser';

/**
 * Runtime evaluator for compound-pseudo predicates parsed by ParseJss.
 *
 * The parser produces a JSON-safe `PredicateExpr` AST (State / Not / And /
 * Or). At apply time the runtime walks each PredicateStyle entry attached
 * to a Jiv, evaluates the predicate against the Jiv's live state set, and
 * merges the entry's Style/TextStyle onto EffectiveStyle when the result
 * is true.
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

export const EvaluatePredicate = (expr: PredicateExpr, states: ReadonlySet<string>): boolean => {
  switch (expr.Kind) {
    case 'State': return states.has(expr.Name);
    case 'Not':   return !EvaluatePredicate(expr.Expr, states);
    case 'And': {
      for (const e of expr.Exprs) if (!EvaluatePredicate(e, states)) return false;
      return true;
    }
    case 'Or': {
      for (const e of expr.Exprs) if (EvaluatePredicate(e, states)) return true;
      return false;
    }
  }
};
