import { Injectable, InjectionToken, signal } from '@angular/core';
import { ParseJss, type Stylesheet, type Ruleset } from 'jwift';

/**
 * Holds the JSS rulesets in scope for a part of the component tree.
 *
 * `<jwift-canvas>` provides one at the root. `<jyle>` blocks inside any
 * subtree extend the registry with their parsed content, scoped to their
 * own descendants via DI hierarchy. `<jiv class="X">` walks up the DI tree,
 * finds the nearest registry, and resolves "X" against it.
 *
 * Registries are mutable bags — a `<jyle>` parses its text content once on
 * mount and merges into the local registry. Re-rendering a `<jyle>` with
 * new content replaces the rules under its own keys (last-wins).
 *
 * `Version()` is a signal bumped on every `Merge` / `MergeSource`. Consumers
 * (Jiv component) read it inside an `effect(() => ...)` so Angular's
 * reactivity re-runs class resolution when rules change — which is what
 * makes live `.jss` hot-edits apply without a page reload.
 */
@Injectable()
export class JssRegistry {
  /** Class name → routed Ruleset. Lookup is O(1). */
  private _rules = new Map<string, Ruleset>();

  private _version = signal(0);

  /** Monotonic version — increments on every merge. Angular effects that
   *  read this will re-run on changes; this is how live JSS edits flow
   *  through to already-mounted `<jiv>` instances. */
  readonly Version = this._version.asReadonly();

  /** Add (or replace) a parsed sheet's contents in this registry. */
  Merge = (sheet: Stylesheet): void => {
    for (const [name, ruleset] of Object.entries(sheet)) {
      this._rules.set(name, ruleset);
    }
    this._version.update((v) => v + 1);
  };

  /** Add raw JSS source — convenience for `<jyle>` projections. */
  MergeSource = (source: string): void => {
    if (!source.trim()) return;
    this.Merge(ParseJss(source));
  };

  /** Resolve one or more space-separated class names to a merged Ruleset.
   *  Later classes win on field conflicts (CSS-like). Returns null if no
   *  classes match. */
  Resolve = (classNames: string | null | undefined): Ruleset | null => {
    if (!classNames) return null;
    const out: Ruleset = {};
    let matched = false;
    for (const name of classNames.split(/\s+/).filter(Boolean)) {
      const r = this._rules.get(name);
      if (!r) continue;
      matched = true;
      if (r.Style)       out.Style       = { ...out.Style,       ...r.Style };
      if (r.Layout)      out.Layout      = { ...out.Layout,      ...r.Layout };
      if (r.ChildLayout) out.ChildLayout = { ...out.ChildLayout, ...r.ChildLayout };
      if (r.TextStyle)   out.TextStyle   = { ...out.TextStyle,   ...r.TextStyle };
    }
    return matched ? out : null;
  };
}

/** DI token for the nearest stylesheet registry. */
export const JSS_REGISTRY = new InjectionToken<JssRegistry>('JSS_REGISTRY');

/** Convenience helper for the `text` loader path:
 *
 *   import jssText from './Home.jss';
 *   const Styles = CompileJss(jssText);
 */
export const CompileJss = (source: string): Stylesheet => ParseJss(source);
