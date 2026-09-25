/**
 * Switches for the per-frame savings that have no pixel of their own, so an A/B can flip each one
 * inside a single running session and diff the frames. All on by default; `__jauiLevers` in the
 * render worker is the same object.
 */
export const PerfLevers = {
  /** Build the `jaui:*` gate lines only while a trace sink listens. */
  TraceGates: true,
  /** Open whole-frame GPU timer queries only when something reads them. */
  FrameTimer: true,
  /** Reuse one live predicate view per element. */
  PredicateViews: true,
  /** Step only the animatables that can move; one at exact rest sleeps until something rouses it. */
  SleepingAnimators: true,
  /** Run text transitions over the subtrees whose inputs changed, not the whole tree. */
  ScopedTextTransitions: true,
  /** Rerun the opacity, grade and vibrancy cascades only after a RenderStyle write or a tree change. */
  CascadeOnChange: true,
};

(globalThis as unknown as { __jauiLevers?: typeof PerfLevers }).__jauiLevers = PerfLevers;
