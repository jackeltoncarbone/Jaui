/**
 * Moves whenever an input of the render's cascades (opacity, filter grade, vibrancy) can change: a style
 * animator writes a RenderStyle, or a node joins or leaves a tree. Unmoved since the last cascade, every
 * cascaded value is still what that cascade wrote, so the render skips the three whole-tree walks.
 */
export const CascadeEpoch = { Value: 0 };
