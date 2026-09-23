#version 300 es
precision highp float;

// THE RIM. A light the edge catches, drawn as a thin strip along the panel's outline, twice, over what
// is already there: a GAIN (the destination times 1 + this), which keeps its hue and most of its
// saturation, then a small SCREEN toward white (WebGL2.Renderer `RimDraw`). No backdrop tap, no
// snapshot, no render target.
//
// Apple's measured rim: a core a constant 2 to 3 device px wide all the way round, its brightness set
// only by the angle to the light, easing into the body over about 3% of the panel's short side.

in vec2 v_PixelPos;
in float v_Distance;
in vec2 v_Normal;

uniform sampler2D u_ClipTex;
uniform ivec2 u_Clip;
// Core width and shoulder (device px), this pass's amount, opacity.
uniform vec4 u_Rim;
uniform vec2 u_LightDirection;

out vec4 fragColor;

#pragma ClipStack

void main() {
    float clipD = clipStackDistance(v_PixelPos, u_Clip.x, u_Clip.y);
    if (clipD > 1.0) discard;
    float coverage = (1.0 - smoothstep(-0.5, 0.5, v_Distance)) * (1.0 - smoothstep(-0.5, 0.5, clipD));
    float shoulder = 1.0 - clamp(max(-v_Distance - u_Rim.x, 0.0) / max(u_Rim.y, 1e-3), 0.0, 1.0);
    // The key light and its bounce from the opposite side, nearly as bright; 90 degrees off both, the
    // rim keeps 0.15 of its peak.
    float k = dot(normalize(v_Normal), u_LightDirection);
    float facing = max(k, -0.95 * k);
    float light = mix(0.15, 1.0, facing * facing);
    fragColor = vec4(vec3(u_Rim.z * u_Rim.w * light * coverage * shoulder * shoulder * shoulder), 1.0);
}
