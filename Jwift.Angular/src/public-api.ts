/**
 * Public API — Jwift.Angular.
 *
 * Re-exports the core Jwift library so consumers `import { ... } from
 * 'jwift-angular'` and get both Angular components and the underlying
 * types from one place.
 */

export * from './Canvas/JwiftCanvas';
export * from './Jiv/Jiv';
export * from './Jiv/Parent.Jiv.Token';
export * from './Jext/Jext';
export * from './Jyle/Jyle';
export * from './Jss/Jss.Registry';

// Re-export types from jwift core so consumers don't need a separate import
// for type-only references. The runtime `Jiv` class from core is shadowed by
// this lib's `<jiv>` component (same name, different shape) — consumers who
// need the core class can import from 'jwift' directly.
export type {
  JivStyle, LayoutConfig, ChildLayout, TextStyle,
  CornerShape, BlendMode, MaterialType, Color,
  Stylesheet, Ruleset,
} from 'jwift';
export { LiquidGlass, SolidGlass, ClearGlass, ParseJss, Canvas } from 'jwift';
