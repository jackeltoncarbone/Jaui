// Typed corpus scene registry. The single source of truth for which scenes
// exist and how they load. Keys are the `?scene=` ids; values lazily import the
// scene module (whose default export is its setup function). No stringly-typed
// whitelist, no path interpolation — adding a scene means adding one typed line.

export type SceneSetup = (canvas: HTMLCanvasElement) => void | Promise<void>;

export const Scenes = {
  FlatPanels: () => import('./FlatPanels'),
  Shadows:    () => import('./Shadows'),
  Text:       () => import('./Text'),
  Glass:      () => import('./Glass'),
  Mixed:      () => import('./Mixed'),
  Pblur:      () => import('./Pblur'),
  Janvas:     () => import('./Janvas'),
  Slab:       () => import('./Slab'),
  Depth:      () => import('./Depth'),
  Light:      () => import('./Light'),
  Home:       () => import('./Home'),
  FrostTest:  () => import('./FrostTest'),
  DepthLayer: () => import('./DepthLayer'),
  ClickTest:  () => import('./ClickTest'),
  ModelTest:  () => import('./ModelTest'),
} as const satisfies Record<string, () => Promise<{ default: SceneSetup }>>;

export type SceneId = keyof typeof Scenes;

export const DefaultScene: SceneId = 'FlatPanels';
