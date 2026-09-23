#version 300 es
precision highp float;

// THE RIM. A light the edge catches, drawn as a thin strip along the panel's outline, twice, over what
// is already there: a GAIN (the destination times 1 + this), which keeps its hue and most of its
// saturation, then a small SCREEN toward white (WebGL2.Renderer `RimDraw`). No backdrop tap, no
// snapshot, no render target.
//
// Apple's measured rim (the iPhone speaker button, every 10 degrees): a crisp core whose width and
// brightness both follow the angle to the light, about 2.9 device px at the lit lobes and 1.3 on the
// sides at DPR 3, with a short faint tail inside the lobes and no shoulder.

in vec2 v_PixelPos;
in float v_Distance;
in vec2 v_Normal;

uniform sampler2D u_ClipTex;
uniform ivec2 u_Clip;
// Core width at the lobes and on the sides (device px), this pass's amount, opacity.
uniform vec4 u_Rim;
uniform vec2 u_LightDirection;

out vec4 fragColor;

#pragma ClipStack

void main() {
    float clipD = clipStackDistance(v_PixelPos, u_Clip.x, u_Clip.y);
    if (clipD > 1.0) discard;
    float coverage = (1.0 - smoothstep(-0.5, 0.5, v_Distance)) * (1.0 - smoothstep(-0.5, 0.5, clipD));
    // The key light and its bounce from the opposite side, nearly as bright; 90 degrees off both, the
    // rim keeps 0.15 of its peak.
    float k = dot(normalize(v_Normal), u_LightDirection);
    float facing = max(k, -0.95 * k);
    float lobe = facing * facing;
    float light = mix(0.15, 1.0, lobe);
    // Never narrower than a device pixel: a thinner core draws at one pixel and carries the rest as gain.
    float width = mix(u_Rim.y, u_Rim.x, lobe);
    float drawn = max(width, 1.0);
    float inside = -v_Distance;
    float core = (1.0 - smoothstep(drawn - 0.5, drawn + 0.5, inside)) * (width / drawn);
    float tail = 0.15 * lobe * (1.0 - smoothstep(drawn, drawn + 0.75 * u_Rim.x, inside));
    fragColor = vec4(vec3(u_Rim.z * u_Rim.w * light * coverage * (core + tail)), 1.0);
}
