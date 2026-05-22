/**
 * Public API — Jaui.Angular.
 *
 * Re-exports the core Jaui library so consumers `import { ... } from
 * 'jaui-angular'` and get both Angular components and the underlying
 * types from one place.
 */

export * from './Jaui/Jaui';
export * from './Janvas/Janvas';
export * from './Jiv/Jiv';
export * from './Jimage/Jimage';
export * from './Jext/Jext';
export * from './Jyle/Jyle';
export * from './SvgJiv/SvgJiv';
export * from './Jinput/Jinput';
export * from './Jss/Jss.Registry';

// Re-export types from jaui core so consumers don't need a separate import
// for type-only references. The runtime `Jiv` class from core is shadowed by
// this lib's `<jiv>` component (same name, different shape) — consumers who
// need the core class can import from 'jaui' directly.
export type {
  JivStyle, LayoutConfig, ChildLayout, TextStyle,
  CornerShape, BlendMode, MaterialType, Color,
  ProgressiveBlurDirection,
  Stylesheet, Ruleset,
} from 'jaui';
export { LiquidGlass, ClearGlass, ParseJss, Canvas } from 'jaui';

// Worker bootstrap helpers — apps call `CheckBrowserSupport()` at boot
// to feature-detect OffscreenCanvas + Worker before kicking Angular.
export { CheckBrowserSupport, type BrowserSupportResult } from 'jaui';
