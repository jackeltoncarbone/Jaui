// THE LIGHT/DARK FLIP of small glass, shared by the panel vertex stage (which picks the plate) and the
// text program (which picks the label's ink), so the two can never disagree. `mean` is the backdrop's
// mean luma under the surface, from the probe's eased state texel. Apple's small glass turns to its light
// plate with a dark label over light content; the band keeps a mean hovering at the threshold from
// flickering, and the eased texel makes the change a transition rather than a cut.
const float GLASS_FLIP_LOW = 0.45;
const float GLASS_FLIP_HIGH = 0.55;

float GlassFlipFactor(float mean) {
    return smoothstep(GLASS_FLIP_LOW, GLASS_FLIP_HIGH, mean);
}
