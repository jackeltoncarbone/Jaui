// Cross-fade stack. SvgJiv renders into two overlaid layers and fades the
// incoming render in over the outgoing one using the engine's native Opacity
// animation — so a bound-attribute change (e.g. fill) dissolves between states
// instead of snapping. Both layers fill the wrapper Jiv (which carries the
// consumer's class / size).
SvgJivLayer {
  Position: Placed
  Top: 0pt
  Left: 0pt
  Width: 100%
  Height: 100%
  @Transition Opacity { Duration: 240ms }
}
