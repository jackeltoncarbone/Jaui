/**
 * ThreeRenderer — Three.js backend for the `Renderer` interface.
 *
 * One Three.js world. UI elements and subsystem content (marchers, field) both live
 * in `_world` — no UI-vs-content split. JSS-authored nodes are instanced quads
 * positioned on the calibrated near-plane at z=0 (2D-parity mode); a JSS `Z`
 * property lifts them into real depth when Phase 5 lands. Subsystem authors call
 * `GetThree()` to mount their own Object3D subtrees directly.
 *
 * 2D parity: camera at z = height/(2·tan(fovY/2)), looking at origin, ortho-equivalent.
 * A quad at z=0 with size (w,h) in device pixels renders to exactly w×h screen pixels.
 *
 * Phase status:
 *   Phase 1 — flat panels: calibrated camera, instanced SDF panel mesh, scene composite. ✓
 *   Phase 2 — text/images/clips: TODO
 *   Phase 3 — glass/blur/pblur: TODO
 *   Phase 4 — worker bridge / Janvas native: TODO
 *   Phase 5 — depth, thickness, fillet, lighting: TODO
 */

import * as THREE from 'three';
import { SHAPE_SDF_GLSL, CLIP_STACK_GLSL } from './Three.ShapeSdf';
import { GLASS_VERT, GLASS_FRAG, PBLUR_VERT, PBLUR_FRAG } from './Three.Shaders';
import { ThreeBlurPass } from './Three.BlurPass';
import type {
  Renderer,
  GpuTextureHandle,
  ProgressiveBlurParams,
  BgPaint,
  SubsystemDrawItem,
} from './Renderer';

// ─── Texture handle ────────────────────────────────────────────────────────

interface ThreeTextureHandle extends GpuTextureHandle {
  readonly _texture: THREE.Texture | null;
}

const _mint = (t: THREE.Texture | null): ThreeTextureHandle =>
  ({ _brand: 'GpuTextureHandle', _texture: t });

// ─── Panel shader ──────────────────────────────────────────────────────────
// Instance layout: 60 floats / 15 vec4s matching JivInstanceBuffer exactly.
// Attribute locations mirror the buffer slots (loc 1..15; loc 0 is quad UV).
//
// Vertex shader: tile a unit quad [0,1]² to the panel's device-pixel rect,
// then convert device px → NDC using the canvas resolution uniform.
//
// Fragment shader: rounded-rect SDF + squircle superellipse (smoothness),
// drop shadow, border, tint, opacity, brightness. Glass/backdrop deferred to Phase 3.

// Instance data is fetched from a float data texture (60 floats = 15 vec4 per
// instance, one instance per texel-row of 15 texels), NOT vertex attributes —
// 15 vec4 attributes + position would hit the 16-slot WebGL2 ceiling with zero
// headroom, and Three reserves slots, which silently kills the draw. texelFetch
// by gl_InstanceID has no such limit and matches the WGSL storage-buffer design.

const PANEL_VERT = /* glsl */`
precision highp float;

in vec3 position;            // unit quad [0,1] (z unused)

uniform vec2 u_Resolution;
uniform sampler2D u_Instances;  // 15 texels (RGBA32F) per instance row
uniform int u_InstanceTexW;     // texture width in texels
uniform mat4 u_ViewProj;        // camera view-projection (world px -> clip)
uniform float u_CamDist;        // camera distance from the z=0 plane (device px)

out vec2 v_PixelPos;
out vec4 v_PanelGeom;
out vec4 v_Radii;
out vec4 v_Tint;
out vec4 v_BorderColor;
out vec4 v_ShadowColor;
out vec4 v_ShadowParams;
out vec4 v_StyleParams;
out vec4 v_Outline;       // .zw = clipOffset, clipCount
out vec4 v_Refraction;    // .x = Thickness (device px), .y bezel, ...
out vec4 v_RimEdge;       // .w = Fillet (device px)
out vec4 v_Lighting;      // lightDirX, lightDirY, lightIntensity, fresnelStrength
out vec4 v_SlabParams;    // .x = Elevation, .y = translateZ, .z = spaceWorld flag
out float v_FogDepth;     // view-space distance from camera (device px)

vec4 fetchSlot(int instance, int slot) {
  int texel = instance * 16 + slot;
  int x = texel % u_InstanceTexW;
  int y = texel / u_InstanceTexW;
  return texelFetch(u_Instances, ivec2(x, y), 0);
}

void main() {
  int id = gl_InstanceID;
  vec4 a_Rect        = fetchSlot(id, 0);
  v_PanelGeom        = fetchSlot(id, 1);
  v_Radii            = fetchSlot(id, 2);
  v_Tint             = fetchSlot(id, 3);
  v_BorderColor      = fetchSlot(id, 4);
  v_ShadowColor      = fetchSlot(id, 5);
  v_ShadowParams     = fetchSlot(id, 6);
  v_StyleParams      = fetchSlot(id, 7);
  v_Refraction       = fetchSlot(id, 9);
  v_Lighting         = fetchSlot(id, 10);
  v_RimEdge          = fetchSlot(id, 12);
  v_Outline          = fetchSlot(id, 13);
  v_SlabParams       = fetchSlot(id, 15);

  vec2 pos = a_Rect.xy + position.xy * a_Rect.zw;
  v_PixelPos  = pos;

  // Depth position. translateZ moves the quad toward the viewer (+Z); World
  // space uses the camera's perspective projection; Screen space stays on the
  // calibrated near-plane. INVARIANT: z=0 → the perspective projection of a
  // device-px world point on the z=0 plane equals the flat NDC mapping exactly
  // (that is how the camera is calibrated), so Screen/z=0 elements are
  // byte-identical to the 2D path.
  float translateZ = v_SlabParams.y;
  // World-space coords: x right, y down, z toward viewer (camera at +z·u_CamDist).
  vec3 worldPos = vec3(pos, translateZ);
  gl_Position = u_ViewProj * vec4(worldPos, 1.0);
  // View-space depth = how far the element is from the camera along its axis.
  // At z=0 this is u_CamDist (the near-plane), so fog at the plane is ~0 with a
  // start≈camDist; deeper (negative translateZ) is farther → more fog.
  v_FogDepth = u_CamDist - translateZ;
}
`;

const PANEL_FRAG = /* glsl */`
precision highp float;

in vec2 v_PixelPos;
in vec4 v_PanelGeom;     // cx, cy, halfW, halfH
in vec4 v_Radii;         // tl, tr, br, bl
in vec4 v_Tint;
in vec4 v_BorderColor;
in vec4 v_ShadowColor;
in vec4 v_ShadowParams;  // offsetX, offsetY, blur, borderWidth
in vec4 v_StyleParams;   // borderEdgeAa, smoothness, opacity, brightness
in vec4 v_Outline;       // .z = clipOffset, .w = clipCount
in vec4 v_Refraction;    // .x = Thickness (device px)
in vec4 v_RimEdge;       // .w = Fillet (device px)
in vec4 v_Lighting;      // lightDirX, lightDirY, lightIntensity, fresnelStrength
in vec4 v_SlabParams;    // .x = Elevation (device px)
in float v_FogDepth;     // view-space distance from camera (device px)

uniform sampler2D u_ClipBuf;
uniform int u_ClipBufW;

// Atmospheric fog (Phase 5). Off by default (u_FogDensity==0 → no change, so the
// z=0 board stays pixel-identical). When on, fragments fade toward u_FogColor as
// view-depth passes u_FogStart, over u_FogRange — makes the depth perspective
// read as real space. Linear ramp keeps it cheap + predictable.
uniform vec3  u_FogColor;
uniform float u_FogStart;    // device-px view-depth where fog begins
uniform float u_FogRange;    // px over which it ramps to full
uniform float u_FogDensity;  // 0 = off, 1 = full strength at/after start+range

// Scene light (Phase 5). A movable point light (cursor/gyro) the whole UI
// responds to: a soft diffuse sheen + a specular glint that sweep across panels
// and rake the beveled edges as the light moves. Off by default (Strength 0 =
// exact no-op → 2D board unchanged). Position is device-px (x,y) + height (z).
uniform vec3  u_LightPos;
uniform vec3  u_LightColor;
uniform float u_LightStrength;
uniform float u_LightRadius;

// Shared scene light (from <light> Jivs) that rakes the slab bevel + face. When
// u_SceneLightOn>0 the bevel/face shading uses this direction/color instead of
// the per-instance LightAngle, so one <light> lights every surface coherently.
uniform vec3  u_SceneLightDir;   // screen-space dir TOWARD the light (xy) + forward (z)
uniform vec3  u_SceneLightColor;
uniform float u_SceneLightInt;
uniform float u_SceneLightOn;

// Depth of field (Phase 5). Per-element approximation: an element defocuses
// (softens + fades) by how far its view-depth is from u_FocusDepth, beyond
// u_FocusRange, scaled by u_DofStrength. Off by default (Strength 0 = no-op).
// Cheap + reads convincingly for discrete UI cards at distinct depths; a true
// per-pixel CoC post-pass would need a scene depth texture (future).
uniform float u_FocusDepth;   // view-depth (px) that is sharp
uniform float u_FocusRange;   // px of full sharpness around focus
uniform float u_DofStrength;  // 0 = off

// ── Background fill mode ────────────────────────────────────────────────
// Per-draw uniforms selecting what paints inside the panel silhouette.
//   0 = Color          — v_Tint solid fill (default; pixel-identical to legacy)
//   1 = Image          — sample u_BgImage with the CPU-baked u_BgUv transform
//   2 = LinearGradient — u_GradDir = direction; t = dot(local-0.5, dir)+0.5
//   3 = RadialGradient — u_GradDir = center, u_GradRadius = radius; t = dist/r
// Stops: u_GradStopColor[i] (rgba) + u_GradStopPos[i] (0..1), u_GradStopCount.
#define MAX_BG_GRAD_STOPS 8
uniform int       u_BgMode;
uniform sampler2D u_BgImage;
uniform vec4      u_BgUv;            // scale.xy, offset.zw
uniform float     u_BgFade;          // [0..1] cross-fade v_Tint to image
uniform vec2      u_GradDir;         // linear: direction · radial: center
uniform float     u_GradRadius;      // radial radius
uniform int       u_GradStopCount;
uniform vec4      u_GradStopColor[MAX_BG_GRAD_STOPS];
uniform float     u_GradStopPos[MAX_BG_GRAD_STOPS];

out vec4 fragColor;

${SHAPE_SDF_GLSL}
${CLIP_STACK_GLSL}

vec4 sampleBgGradient(float t) {
  if (u_GradStopCount <= 0) return vec4(0.0);
  if (u_GradStopCount == 1) return u_GradStopColor[0];
  if (t <= u_GradStopPos[0]) return u_GradStopColor[0];
  int last = u_GradStopCount - 1;
  for (int i = 1; i < MAX_BG_GRAD_STOPS; i++) {
    if (i > last) break;
    float pNext = u_GradStopPos[i];
    if (t <= pNext) {
      float pPrev = u_GradStopPos[i - 1];
      float span = max(pNext - pPrev, 0.0001);
      float u = clamp((t - pPrev) / span, 0.0, 1.0);
      return mix(u_GradStopColor[i - 1], u_GradStopColor[i], u);
    }
  }
  return u_GradStopColor[last];
}

// Resolve the fill source color for a fragment. panelLocal is [0..1] across the
// panel bbox (origin at the top-left corner of the panel rect).
vec4 resolveBgFill(vec2 panelLocal) {
  if (u_BgMode == 1) {
    vec2 uv = panelLocal * u_BgUv.xy + u_BgUv.zw;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return v_Tint;
    vec4 img = texture(u_BgImage, uv);
    return mix(v_Tint, img, clamp(u_BgFade, 0.0, 1.0));
  } else if (u_BgMode == 2) {
    float t = dot(panelLocal - 0.5, u_GradDir) + 0.5;
    return sampleBgGradient(clamp(t, 0.0, 1.0));
  } else if (u_BgMode == 3) {
    float radius = max(u_GradRadius, 0.0001);
    float d = length(panelLocal - u_GradDir) / radius;
    return sampleBgGradient(clamp(d, 0.0, 1.0));
  }
  return v_Tint;
}

// Panel 2D distance via the full shape model (Rect superellipse / SS-Pill /
// Circle). At depth=0 the 3D slab collapses to this exact 2D cross-section, so
// flat panels use the cross-section directly. Phase 5 swaps this for slabSdf
// once Thickness/Fillet/z are nonzero.
float panelDist(vec2 pixelPos, vec4 geom, vec4 radii, float smoothness) {
  vec2 q = pixelPos - geom.xy;     // local, origin at panel center
  return shapeSdf2D(q, geom.zw, radii, smoothness);
}

// Gaussian shadow approximation (4-tap on the shape SDF sign).
float shadowAlpha(vec2 pixelPos, vec4 geom, vec4 radii, float smoothness,
                  vec2 offset, float blur) {
  if (blur < 0.5) {
    return panelDist(pixelPos - offset, geom, radii, smoothness) < 0.0 ? 1.0 : 0.0;
  }
  float w = blur * 0.5 * 0.7071;
  float sum = 0.0;
  sum += float(panelDist(pixelPos - offset + vec2( w,  w), geom, radii, smoothness) < 0.0);
  sum += float(panelDist(pixelPos - offset + vec2(-w,  w), geom, radii, smoothness) < 0.0);
  sum += float(panelDist(pixelPos - offset + vec2( w, -w), geom, radii, smoothness) < 0.0);
  sum += float(panelDist(pixelPos - offset + vec2(-w, -w), geom, radii, smoothness) < 0.0);
  return sum * 0.25;
}

void main() {
  float borderEdgeAa = v_StyleParams.x;
  float smoothness   = v_StyleParams.y;
  float opacity      = v_StyleParams.z;
  float brightness   = v_StyleParams.w;

  float shadowBlur   = v_ShadowParams.z;
  float borderWidth  = v_ShadowParams.w;

  // Overflow clipping — discard pixels outside any ancestor clip shape.
  int clipCount = int(v_Outline.w + 0.5);
  if (clipCount > 0) {
    if (clipCoverage(v_PixelPos, int(v_Outline.z + 0.5), clipCount, u_ClipBuf, u_ClipBufW) < 0.5) discard;
  }

  float dist = panelDist(v_PixelPos, v_PanelGeom, v_Radii, smoothness);

  // Depth-of-field defocus (0 sharp .. 1 max blur) from this element's view-depth
  // vs the focus plane. Off when u_DofStrength==0. Widens the silhouette feather
  // so out-of-focus cards get a soft edge — the DOF read for discrete UI depth.
  float defocus = 0.0;
  if (u_DofStrength > 0.0) {
    float dz = abs(v_FogDepth - u_FocusDepth) - u_FocusRange;
    defocus = clamp(dz / 200.0, 0.0, 1.0) * u_DofStrength;
  }

  // AA feather ~1px. fwidth(dist) spikes along the SDF medial axis (the center
  // cross where the distance gradient flips), which without a clamp paints a
  // full-width "slit" through the panel center. Clamp to a sane pixel feather.
  // DOF widens the feather (soft edge) when defocused.
  float aa   = clamp(fwidth(dist), 0.5, 1.5) + defocus * 14.0;
  float fill = 1.0 - smoothstep(-aa, aa, dist);
  if (fill <= 0.0 && shadowBlur < 0.5 && v_ShadowColor.a < 0.01) discard;

  float shadow = 0.0;
  if (v_ShadowColor.a > 0.0) {
    shadow = shadowAlpha(v_PixelPos, v_PanelGeom, v_Radii, smoothness,
                         v_ShadowParams.xy, shadowBlur) * v_ShadowColor.a;
  }

  // Border ring — inset the shape by borderWidth and stroke the gap.
  float innerDist = panelDist(v_PixelPos, vec4(v_PanelGeom.xy, v_PanelGeom.zw - borderWidth),
                              clamp(v_Radii - borderWidth, 0.0, 1e9), smoothness);
  float borderAa  = clamp(fwidth(innerDist), 0.5, 1.5);
  float borderFill = smoothstep(-borderAa - borderEdgeAa, borderAa, innerDist)
                   * (1.0 - smoothstep(-borderAa, borderAa, dist));

  // Background fill source — Color (v_Tint, identical to legacy), Image, or
  // gradient. panelLocal is [0..1] across the panel bbox (top-left origin).
  vec2 panelLocal = (v_PixelPos - (v_PanelGeom.xy - v_PanelGeom.zw)) / (2.0 * v_PanelGeom.zw);
  vec4 bg = resolveBgFill(panelLocal);

  // == Slab elevation + filleted edge (Phase 5, ADDITIVE) ==
  // elevation<=0: flat panel, this block is a no-op and the front face is
  // byte-identical to the 2D path. elevation>0: the panel is a SOLID slab
  // (no glass promotion); within a fillet-px band of the silhouette the front
  // face rolls over toward the side wall (a quarter-round bevel), so its normal
  // tilts outward and a directional light rakes that rim (the physical-edge
  // look). The interior (beyond the fillet) stays the flat front face, so the
  // matched center cannot change.
  vec3 surfaceN = vec3(0.0, 0.0, 1.0);   // front-face normal (bevel sets it below)
  float elevation = v_SlabParams.x;
  if (elevation > 0.0) {
    float fillet = max(v_RimEdge.w, 1.0);
    // SDF gradient. Under the superellipse, dist is NOT reliably Euclidean
    // distance (gradient-normalized, goes shallow over rounded corners), so
    // dividing by the gradient length recovers true pixel distance to the edge.
    // That makes the bevel a fixed-width RIM, not whole-panel shading. Guard the
    // near-zero-gradient interior so normalize() can't produce NaN.
    vec2  grad = vec2(dFdx(dist), dFdy(dist));
    float gradLen = length(grad);
    // edgePx: signed px distance to silhouette. dist isn't Euclidean under the
    // superellipse, so /clamp(|grad|) recovers it; floor avoids corner blow-up.
    float gl   = max(gradLen, 0.5);
    float edgePx = dist / gl;
    // Outward edge direction: derive ANALYTICALLY from the fragment's offset from
    // the panel center (stable, no per-pixel derivative noise) instead of the
    // SDF screen-space gradient — that derivative is singular at the rounded-
    // corner apex and produced a visible shading crease there. The center-offset
    // direction is smooth everywhere and points the right way for a rounded rect.
    vec2  fromCenter = v_PixelPos - v_PanelGeom.xy;
    vec2  edgeDir = (length(fromCenter) > 1e-4) ? normalize(fromCenter) : vec2(0.0);
    // Bevel param b: 0 at the inner edge of the fillet ring, 1 at the silhouette.
    // edgePx runs 0 (silhouette) to -fillet (ring inner edge). Clamp guards
    // outliers so the rim is exactly fillet-wide everywhere, corners included.
    float bRaw = clamp((edgePx + fillet) / fillet, 0.0, 1.0);
    // Ease the bevel so the roll-over is gentle near the flat interior and
    // steepens toward the silhouette — reads as a rounded surface, not a ramp.
    float b = smoothstep(0.0, 1.0, bRaw);
    // Normal: +Z (toward viewer) in the interior; over the bevel it tilts toward
    // edgeDir following a quarter-round (0..90deg). Using b (eased) for a smooth
    // curvature profile.
    float ang = b * 1.5707963;
    vec3  N = normalize(vec3(edgeDir * sin(ang), cos(ang)));
    surfaceN = N;   // expose the bevel normal for the scene-light pass

    // Light direction/intensity: the shared scene light when present (so a
    // <light> rakes this slab), else the per-instance LightAngle baseline.
    float intensity = u_SceneLightOn > 0.5 ? max(u_SceneLightInt, 0.0001) : max(v_Lighting.z, 0.0001);
    vec3  L = u_SceneLightOn > 0.5 ? normalize(u_SceneLightDir) : normalize(vec3(v_Lighting.xy, 1.3));
    vec3  V = vec3(0.0, 0.0, 1.0);            // viewer looks down +Z
    vec3  Hh = normalize(L + V);              // Blinn half-vector

    // Diffuse: half-lambert, lifted by a small ambient floor so the shaded side
    // of the bevel darkens but never crushes to flat black.
    float ndl  = dot(N, L);
    float diff = ndl * 0.5 + 0.5;             // 0..1
    float ambient = 0.55;
    float shade = mix(ambient, 1.15, diff);   // shaded rim → ambient; lit rim → bright

    // Contact-shadow at the inner edge of the bevel (where it meets the flat) for
    // a subtle "set-in" depth cue — only in the first ~25% of the bevel band.
    float ao = mix(0.92, 1.0, smoothstep(0.0, 0.25, bRaw));

    // Apply rim shading only over the bevel (b), leaving the interior untouched.
    // Floor the result so a corner where N anti-aligns with L can't darken into a
    // hard notch — the rim stays a soft shade, never a black gouge. Robustness
    // over a perfect corner normal (the SDF apex is genuinely singular there).
    float lit = max(mix(1.0, shade * ao, b), 0.6);
    bg.rgb *= lit;

    // Blinn specular glint riding the crest of the bevel, tightest at the top.
    float spec = pow(clamp(dot(N, Hh), 0.0, 1.0), 48.0) * b * intensity;
    bg.rgb += spec * 0.5;

    // Whole-FACE shade from the scene light: a thick sheet's flat front face
    // (normal +Z) still tints by how it faces the light, so the slab reads as a
    // lit surface, not flat paint. Subtle (the face is flat, so this is a gentle
    // uniform tint), and scaled by depth so a thin sheet barely shifts and a
    // thick one is clearly lit. Only when a scene light is present; at Depth 0
    // the whole block is skipped, so flat Jivs are untouched (continuity).
    if (u_SceneLightOn > 0.5) {
      float faceNdl = clamp(dot(vec3(0.0, 0.0, 1.0), L) * 0.5 + 0.5, 0.0, 1.0);
      float depthAmt = clamp(elevation / 24.0, 0.0, 1.0);   // ramps in over ~24px depth
      float faceShade = mix(1.0, mix(0.86, 1.08, faceNdl), depthAmt);
      bg.rgb *= faceShade;
    }
  }

  vec4 col = vec4(0.0);
  col = mix(col, v_ShadowColor, shadow * (1.0 - fill));      // shadow behind
  col = mix(col, vec4(bg.rgb * brightness, bg.a), fill);     // fill
  col = mix(col, v_BorderColor, borderFill * v_BorderColor.a);    // border

  col.a *= opacity;
  if (col.a <= 0.0) discard;

  // Scene light — a movable point light (cursor/gyro) the whole UI responds to.
  // Off (Strength 0) is an exact no-op. The fragment's world pos is (v_PixelPos,
  // translateZ); light vector L, half-vector with the +Z viewer give a soft
  // diffuse sheen (sweeps across the face) + a specular glint (sharper, and
  // raked along beveled edges via surfaceN). Distance falloff over u_LightRadius.
  if (u_LightStrength > 0.0) {
    vec3 fragPos = vec3(v_PixelPos, v_SlabParams.y);
    vec3 toLight = u_LightPos - fragPos;
    float dist3 = length(toLight);
    vec3 L = (dist3 > 1e-4) ? toLight / dist3 : vec3(0.0, 0.0, 1.0);
    vec3 Vv = vec3(0.0, 0.0, 1.0);
    vec3 Hh = normalize(L + Vv);
    float falloff = clamp(1.0 - dist3 / max(u_LightRadius, 1.0), 0.0, 1.0);
    falloff *= falloff;                                   // smooth quadratic
    float diffuse = max(dot(surfaceN, L), 0.0);
    float specular = pow(max(dot(surfaceN, Hh), 0.0), 40.0);
    // Sheen brightens the lit side; specular adds the glint. Scaled by coverage
    // (fill) so it only lights the panel, and by strength + falloff.
    float k = u_LightStrength * falloff * fill;
    col.rgb += u_LightColor * (diffuse * 0.18 + specular * 0.8) * k;
  }

  // Atmospheric fog — blend the fragment toward u_FogColor by view-depth. Off
  // (density 0) is an exact no-op. Premultiply-safe: fade rgb toward fog*alpha so
  // edges don't fringe. At z=0, v_FogDepth==u_CamDist; author u_FogStart≈camDist
  // so on-plane UI is fog-free and only depth-pushed elements haze out.
  if (u_FogDensity > 0.0) {
    float f = clamp((v_FogDepth - u_FogStart) / max(u_FogRange, 1.0), 0.0, 1.0) * u_FogDensity;
    col.rgb = mix(col.rgb, u_FogColor * col.a, f);
  }
  fragColor = col;
}
`;

// ─── Blit shader (scene target → default framebuffer) ─────────────────────
// NDC fullscreen quad — no camera transform needed; vertices are already in clip space.

const BLIT_VERT = /* glsl */`
in vec3 position;
out vec2 v_Uv;
void main() {
  v_Uv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const BLIT_FRAG = /* glsl */`
precision mediump float;
uniform sampler2D u_Tex;
in vec2 v_Uv;
out vec4 fragColor;
void main() {
  fragColor = texture(u_Tex, v_Uv);
}
`;

// ─── Text shader ─────────────────────────────────────────────────────────────
// Instanced glyph quads sampling the text atlas. 16 floats/instance:
//   slot 0 a_Rect   (x,y,w,h device px) · slot 1 a_UvRect (u,v,uW,uH atlas UV)
//   slot 2 a_OpClip (opacity, clipOffset, clipCount, _) · slot 3 a_Tint (RGBA)
// Atlas stores premultiplied-ish RGBA glyph coverage; tint multiplies it.

const TEXT_VERT = /* glsl */`
precision highp float;

in vec3 position;               // unit quad [0,1]

uniform vec2 u_Resolution;
uniform sampler2D u_Instances;  // 4 texels (RGBA32F) per instance row
uniform int u_InstanceTexW;

out vec2 v_Uv;
out vec4 v_Tint;
out vec4 v_OpClip;              // opacity, clipOffset, clipCount, _
out vec2 v_PixelPos;

vec4 fetchSlot(int instance, int slot) {
  int texel = instance * 4 + slot;
  int x = texel % u_InstanceTexW;
  int y = texel / u_InstanceTexW;
  return texelFetch(u_Instances, ivec2(x, y), 0);
}

void main() {
  int id = gl_InstanceID;
  vec4 rect   = fetchSlot(id, 0);
  vec4 uvRect = fetchSlot(id, 1);
  v_OpClip    = fetchSlot(id, 2);
  v_Tint      = fetchSlot(id, 3);

  vec2 pos = rect.xy + position.xy * rect.zw;
  vec2 ndc = (pos / u_Resolution) * 2.0 - 1.0;
  ndc.y = -ndc.y;
  gl_Position = vec4(ndc, 0.0, 1.0);
  v_Uv       = uvRect.xy + position.xy * uvRect.zw;
  v_PixelPos = pos;
}
`;

const TEXT_FRAG = /* glsl */`
precision highp float;

in vec2 v_Uv;
in vec4 v_Tint;
in vec4 v_OpClip;
in vec2 v_PixelPos;

uniform sampler2D u_Atlas;
uniform sampler2D u_ClipBuf;
uniform int u_ClipBufW;

out vec4 fragColor;

${SHAPE_SDF_GLSL}
${CLIP_STACK_GLSL}

void main() {
  int clipCount = int(v_OpClip.z + 0.5);
  if (clipCount > 0) {
    if (clipCoverage(v_PixelPos, int(v_OpClip.y + 0.5), clipCount, u_ClipBuf, u_ClipBufW) < 0.5) discard;
  }
  vec4 glyph = texture(u_Atlas, v_Uv);
  // HYBRID: small text (IsSdf=0) uses the raw coverage alpha EXACTLY as before
  // (pixel-identical, crisp at native size). Large text (IsSdf=1) stores an SDF
  // in alpha (128/255 = edge); reconstruct a scale-independent crisp edge with a
  // derivative-width smoothstep so it stays sharp when Z-pushed / scaled.
  float coverage;
  if (v_OpClip.w > 0.5) {
    float sd = glyph.a - (128.0 / 255.0);
    float aa = max(fwidth(sd), 0.0008);
    coverage = smoothstep(-aa, aa, sd);
  } else {
    coverage = glyph.a;
  }
  vec4 col = vec4(glyph.rgb, coverage) * v_Tint;
  col.a *= v_OpClip.x;             // opacity
  if (col.a <= 0.0) discard;
  fragColor = col;
}
`;

// ─── ThreeRenderer ─────────────────────────────────────────────────────────

export class ThreeRenderer implements Renderer {
  /** Per-instance data size. Mirrors JIV_FLOATS_PER_INSTANCE (64 floats = 16
   *  vec4 slots). Single source of truth — bump these (and the shader's slot
   *  fetches) to add per-instance data; there is NO vertex-attribute ceiling
   *  because instance data lives in a data texture, not attributes. */
  static readonly INSTANCE_VEC4S = 16;
  static readonly FLOATS_PER_INSTANCE = ThreeRenderer.INSTANCE_VEC4S * 4;

  private _renderer!: THREE.WebGLRenderer;

  /** One world — UI quads and subsystem Object3D subtrees both live here. */
  private _scene = new THREE.Scene();
  private _world = new THREE.Group();

  /** Real THREE lights mirroring the shared scene light set, so World/Janvas
   *  meshes (MeshStandardMaterial etc.) are lit by the same `<light>` Jivs as the
   *  UI surfaces. Pooled + reused across frames; the surface shader reads the
   *  same set via the light uniforms below. */
  private _sceneLights: THREE.Light[] = [];
  private _ambientLight = new THREE.AmbientLight(0xffffff, 0);

  /** Perspective camera calibrated so z=0 plane = exact device-pixel 1:1. */
  private _camera = new THREE.PerspectiveCamera(50, 1, 0.1, 10_000);

  /** Scene FBO — all draws go here; blitted to swap-chain at end of frame. */
  private _sceneTarget: THREE.WebGLRenderTarget | null = null;

  private _width  = 0;
  private _height = 0;
  private _dpr    = 1;
  private _camDist = 1;   // camera distance from z=0 plane (for fog view-depth)
  private _viewProj = new THREE.Matrix4();  // camera view-proj, recomputed per frame
  private _lastBlurDepth = 0;

  // ── Panel instanced mesh ──
  private _panelGeo!:  THREE.InstancedBufferGeometry;
  private _panelMat!:  THREE.RawShaderMaterial;   // flat / non-glass variant
  private _glassMat!:  THREE.RawShaderMaterial;   // glass variant (samples backdrop)
  private _panelMesh!: THREE.Mesh;

  // ── Glass / blur ──
  private _blur!: ThreeBlurPass;
  private _blurResult: THREE.Texture | null = null;  // last ComputeBlur output (pyramid L0)
  private _snapshotTarget: THREE.WebGLRenderTarget | null = null;

  // ── Progressive blur (single-quad pass) ──
  private _pblurMat!:   THREE.RawShaderMaterial;
  private _pblurMesh!:  THREE.Mesh;
  private _pblurScene!: THREE.Scene;

  // ── Janvas subsystems — keys of those already Attach()-ed (mounted into scene). ──
  private _attachedSubsystems = new WeakSet<object>();

  /** Accumulated instance data this batch (60 floats/instance). */
  private _instanceData = new Float32Array(64 * 60);
  private _instanceCount = 0;


  /** Instance data uploaded as an RGBA32F texture (15 texels/instance) and
   *  fetched in the vertex shader by gl_InstanceID — sidesteps the 16-slot
   *  vertex-attribute ceiling. */
  private _instanceTex!: THREE.DataTexture;
  private _instanceTexW = 0;   // texels per row
  private _instanceTexCap = 0; // instance capacity of current texture

  // ── Text instanced mesh ──
  private static readonly TEXT_VEC4S = 4; // 16 floats / instance
  private _textGeo!:   THREE.InstancedBufferGeometry;
  private _textMat!:   THREE.RawShaderMaterial;
  private _textMesh!:  THREE.Mesh;
  private _textScene!: THREE.Scene;
  private _textData = new Float32Array(128 * 16);
  private _textCount = 0;
  private _textTex!: THREE.DataTexture;
  private _textTexCap = 0;

  // ── Clip-stack buffer (uploaded as RGBA32F data texture, 3 texels/entry) ──
  private _clipTex!: THREE.DataTexture;
  private _clipTexW = 0;
  private _clipTexCap = 0;   // entry capacity

  // ── Texture registry — DataTextures the engine creates (atlas, images) ──
  // Keyed by handle so UploadSubTexture can resolve back to the live texture.

  // ── Blit fullscreen quad ──
  private _blitGeo!:   THREE.BufferGeometry;
  private _blitMat!:   THREE.RawShaderMaterial;
  private _blitMesh!:  THREE.Mesh;
  private _blitScene!: THREE.Scene;   // persistent — no per-frame alloc
  private _panelScene!: THREE.Scene;  // persistent panel draw scene

  /** Orthographic camera whose projection is identity (NDC = clip coords).
   *  Used for the blit fullscreen quad which already provides clip-space verts. */
  private _blitCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  async Init(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<void> {
    this._renderer = new THREE.WebGLRenderer({
      canvas: canvas as HTMLCanvasElement,
      antialias: false,
      alpha: false,
      premultipliedAlpha: false,
    });
    this._renderer.autoClear = false;
    this._scene.add(this._world);

    this._buildClipTexture(64);   // before panel/text meshes — they reference it
    this._buildPanelMesh();
    this._buildTextMesh();
    this._buildBlitMesh();
    this._buildPblurMesh();
    this._blur = new ThreeBlurPass(this._renderer);

    this._blitScene = new THREE.Scene();
    this._blitScene.add(this._blitMesh);
    this._panelScene = new THREE.Scene();
    this._panelScene.add(this._panelMesh);
    this._textScene = new THREE.Scene();
    this._textScene.add(this._textMesh);

    this._calibrateCamera();
  }

  Destroy(): void {
    this._sceneTarget?.dispose();
    this._panelGeo?.dispose();
    this._panelMat?.dispose();
    this._blitGeo?.dispose();
    this._blitMat?.dispose();
    this._renderer?.dispose();
  }

  Resize(width: number, height: number, dpr: number): void {
    if (width === this._width && height === this._height && dpr === this._dpr) return;
    this._width  = width;
    this._height = height;
    this._dpr    = dpr;
    this._renderer.setPixelRatio(1);
    this._renderer.setSize(width, height, false);
    this._sceneTarget?.dispose();
    this._sceneTarget = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      // Depth buffer so WORLD-space panels (Space:World, translateZ) and 3D
      // subsystem content (Janvas meshes) share one depth buffer and occlude by
      // true Z — "front amount" as a real layer axis. Screen-space panels (z=0)
      // still draw depth-test-OFF in paint order, so 2D parity is unaffected.
      depthBuffer: true,
    });
    this._calibrateCamera();
    this._panelMat?.uniforms['u_Resolution']?.value.set(width, height);
  }

  /**
   * Position the perspective camera so its z=0 frustum plane maps world units
   * 1:1 to device pixels — the 2D parity mode.
   *
   * For a camera with vertical FOV `fovY` (radians), the distance `d` that makes
   * a height-H plane fill the canvas exactly is:  d = (H/2) / tan(fovY/2).
   * We set `fovY = 50°` and derive `d` from the current canvas height.
   *
   * The camera looks toward −z; the scene lives at z=0. World origin = top-left
   * canvas corner: x goes right, y goes down (matching CSS/canvas conventions).
   * We shift the camera to (width/2, height/2, d) and target (width/2, height/2, 0).
   */
  private _calibrateCamera(): void {
    if (this._height === 0) return;
    const fovY = this._camera.fov * (Math.PI / 180);
    const d = (this._height / 2) / Math.tan(fovY / 2);
    this._camDist = d;
    const cx = this._width  / 2;
    const cy = this._height / 2;
    this._camera.position.set(cx, cy, d);
    // Standard up=+Y (NOT -Y). World uses TOP-LEFT origin, y-DOWN. A -Y up vector
    // flips BOTH axes (it mirrors X too via the handedness change), which broke
    // the z=0 invariant horizontally. Instead keep up=+Y and flip ONLY Y in the
    // projection matrix below — gives clean y-down with no X-mirror, consistent
    // for panels AND Janvas content.
    this._camera.up.set(0, 1, 0);
    this._camera.lookAt(cx, cy, 0);
    this._camera.aspect = this._width / this._height;
    this._camera.near   = d * 0.001;
    this._camera.far    = d * 10;
    this._camera.updateProjectionMatrix();
    // Flip Y in clip space: negate the projection's Y row. Maps world +Y (down,
    // since our content grows downward) to clip −Y (screen down). elements[5] is
    // m11 (Y scale); elements[13] is m13 (Y translate) — negate both.
    this._camera.projectionMatrix.elements[5]  *= -1;
    this._camera.projectionMatrix.elements[13] *= -1;
    this._camera.projectionMatrixInverse.copy(this._camera.projectionMatrix).invert();
  }

  // ─── Build geometry / shaders ──────────────────────────────────────────

  private _buildPanelMesh(): void {
    // Unit quad: two triangles, vertices at (0,0),(1,0),(1,1),(0,1).
    // The vertex shader tiles this to each panel's device-px rect.
    // Unit quad as a `position` attribute (vec3, z=0). Three.js derives the
    // per-instance vertex count from `geometry.attributes.position` — a quad
    // attribute under any other name renders nothing. Shader reads position.xy.
    // CCW winding AFTER the vertex shader's Y-flip — index order reversed so
    // the visible face is front-facing (no DoubleSide, which double-blends the
    // overlapping back face and darkens edges ~2×).
    const quadVerts = new Float32Array([0,0,0, 1,0,0, 1,1,0, 0,1,0]);
    const quadIdx   = new Uint16Array([0,2,1, 0,3,2]);

    // InstancedBufferGeometry — required for the per-instance divisor to apply.
    this._panelGeo = new THREE.InstancedBufferGeometry();
    this._panelGeo.setAttribute('position', new THREE.BufferAttribute(quadVerts, 3));
    this._panelGeo.setIndex(new THREE.BufferAttribute(quadIdx, 1));

    this._instanceData  = new Float32Array(64 * ThreeRenderer.FLOATS_PER_INSTANCE);
    this._instanceCount = 0;
    this._buildInstanceTexture(64);

    this._panelMat = new THREE.RawShaderMaterial({
      glslVersion:    THREE.GLSL3,
      vertexShader:   PANEL_VERT,
      fragmentShader: PANEL_FRAG,
      uniforms: {
        u_Resolution:   { value: new THREE.Vector2(this._width, this._height) },
        u_Instances:    { value: this._instanceTex },
        u_InstanceTexW: { value: this._instanceTexW },
        u_ViewProj:     { value: new THREE.Matrix4() },
        u_CamDist:      { value: 1 },
        u_FogColor:     { value: new THREE.Vector3(0.05, 0.06, 0.09) },
        u_FogStart:     { value: 0 },
        u_FogRange:     { value: 1000 },
        u_FogDensity:   { value: 0 },   // off → 2D board unchanged
        // Scene light (cursor/gyro-driven). Off by default (Strength 0 → no-op).
        u_LightPos:     { value: new THREE.Vector3(0, 0, 600) },  // device px + height
        u_LightColor:   { value: new THREE.Vector3(1, 1, 1) },
        u_LightStrength:{ value: 0 },   // 0 = off; >0 = sheen/specular over UI
        u_LightRadius:  { value: 700 }, // falloff radius of the highlight (px)
        u_SceneLightDir:   { value: new THREE.Vector3(0, 0, 1) },  // screen dir TO light (xy) + forward (z)
        u_SceneLightColor: { value: new THREE.Vector3(1, 1, 1) },
        u_SceneLightInt:   { value: 1 },
        u_SceneLightOn:    { value: 0 },  // 0 = fall back to per-instance LightAngle (no regression)
        u_FocusDepth:   { value: 600 }, // DOF: view-depth that's sharp
        u_FocusRange:   { value: 200 },
        u_DofStrength:  { value: 0 },   // 0 = off → no DOF
        u_ClipBuf:      { value: this._clipTex },
        u_ClipBufW:     { value: this._clipTexW },
        u_BgMode:       { value: 0 },
        u_BgImage:      { value: null },
        u_BgUv:         { value: new THREE.Vector4(1, 1, 0, 0) },
        u_BgFade:       { value: 1 },
        u_GradDir:      { value: new THREE.Vector2(0, 1) },
        u_GradRadius:   { value: 0.5 },
        u_GradStopCount:{ value: 0 },
        u_GradStopColor:{ value: Array.from({ length: 8 }, () => new THREE.Vector4(0, 0, 0, 0)) },
        u_GradStopPos:  { value: new Float32Array(8) },
      },
      transparent: true,
      depthTest:   false,
      depthWrite:  false,
      side:        THREE.FrontSide,   // winding fixed in the index buffer
      blending:    THREE.CustomBlending,
      blendEquation:       THREE.AddEquation,
      blendSrc:            THREE.SrcAlphaFactor,
      blendDst:            THREE.OneMinusSrcAlphaFactor,
      blendEquationAlpha:  THREE.AddEquation,
      blendSrcAlpha:       THREE.OneFactor,
      blendDstAlpha:       THREE.OneMinusSrcAlphaFactor,
    });

    // Glass variant — same instanced quad + instance texture, but the glass
    // fragment shader (refraction, specular, fresnel, edge light) sampling the
    // blur pyramid as u_Backdrop. Selected per-batch by PanelDrawBatch.
    this._glassMat = new THREE.RawShaderMaterial({
      glslVersion:    THREE.GLSL3,
      vertexShader:   GLASS_VERT,
      fragmentShader: GLASS_FRAG,
      uniforms: {
        u_Resolution:   { value: new THREE.Vector2(this._width, this._height) },
        u_Instances:    { value: this._instanceTex },
        u_InstanceTexW: { value: this._instanceTexW },
        u_Backdrop:     { value: null },
        u_BaseFrostLod: { value: 0 },
        u_SpecularTilt: { value: new THREE.Vector2(0, 0) },
        u_ClipTex:      { value: this._clipTex },
      },
      transparent: true,
      depthTest:   false,
      depthWrite:  false,
      side:        THREE.FrontSide,
      blending:    THREE.CustomBlending,
      blendEquation:       THREE.AddEquation,
      blendSrc:            THREE.SrcAlphaFactor,
      blendDst:            THREE.OneMinusSrcAlphaFactor,
      blendEquationAlpha:  THREE.AddEquation,
      blendSrcAlpha:       THREE.OneFactor,
      blendDstAlpha:       THREE.OneMinusSrcAlphaFactor,
    });

    this._panelMesh = new THREE.Mesh(this._panelGeo, this._panelMat);
    this._panelMesh.frustumCulled = false;
  }

  private _buildBlitMesh(): void {
    // Fullscreen NDC quad for blitting the scene target to the swap chain.
    const verts = new Float32Array([-1,-1,0, 1,-1,0, 1,1,0, -1,1,0]);
    const idx   = new Uint16Array([0,1,2, 0,2,3]);
    this._blitGeo = new THREE.BufferGeometry();
    this._blitGeo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    this._blitGeo.setIndex(new THREE.BufferAttribute(idx, 1));
    this._blitMat = new THREE.RawShaderMaterial({
      glslVersion:    THREE.GLSL3,
      vertexShader:   BLIT_VERT,
      fragmentShader: BLIT_FRAG,
      uniforms: { u_Tex: { value: null } },
      depthTest:  false,
      depthWrite: false,
    });
    this._blitMesh = new THREE.Mesh(this._blitGeo, this._blitMat);
    this._blitMesh.frustumCulled = false;
  }

  private _buildPblurMesh(): void {
    // Single unit quad positioned per-draw via u_Rect (CCW after Y-flip).
    const verts = new Float32Array([0,0,0, 1,0,0, 1,1,0, 0,1,0]);
    const idx   = new Uint16Array([0,2,1, 0,3,2]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this._pblurMat = new THREE.RawShaderMaterial({
      glslVersion:    THREE.GLSL3,
      vertexShader:   PBLUR_VERT,
      fragmentShader: PBLUR_FRAG,
      uniforms: {
        u_Resolution: { value: new THREE.Vector2(this._width, this._height) },
        u_Rect:       { value: new THREE.Vector4(0, 0, 0, 0) },
        u_Scene:      { value: null },
        u_Pyramid:    { value: null },
        u_MaxLod:     { value: 1 },
        u_Direction:  { value: 0 },
        u_Feather:    { value: 0 },
        u_Easing:     { value: 1 },
        u_Opacity:    { value: 1 },
        u_Background: { value: new THREE.Vector4(0, 0, 0, 0) },
        u_Grading:    { value: new THREE.Vector3(1, 1, 1) },
        u_ClipTex:    { value: this._clipTex },
        u_ClipMeta:   { value: [0, 0] },   // ivec2 → int array
      },
      transparent: true,
      depthTest:   false,
      depthWrite:  false,
      side:        THREE.FrontSide,
      blending:    THREE.CustomBlending,
      blendEquation:       THREE.AddEquation,
      blendSrc:            THREE.SrcAlphaFactor,
      blendDst:            THREE.OneMinusSrcAlphaFactor,
      blendEquationAlpha:  THREE.AddEquation,
      blendSrcAlpha:       THREE.OneFactor,
      blendDstAlpha:       THREE.OneMinusSrcAlphaFactor,
    });
    this._pblurMesh = new THREE.Mesh(geo, this._pblurMat);
    this._pblurMesh.frustumCulled = false;
    this._pblurScene = new THREE.Scene();
    this._pblurScene.add(this._pblurMesh);
  }

  private _buildTextMesh(): void {
    const quadVerts = new Float32Array([0,0,0, 1,0,0, 1,1,0, 0,1,0]);
    const quadIdx   = new Uint16Array([0,2,1, 0,3,2]);  // CCW after Y-flip
    this._textGeo = new THREE.InstancedBufferGeometry();
    this._textGeo.setAttribute('position', new THREE.BufferAttribute(quadVerts, 3));
    this._textGeo.setIndex(new THREE.BufferAttribute(quadIdx, 1));

    this._textData = new Float32Array(128 * 16);
    this._textCount = 0;
    this._buildTextTexture(128);

    this._textMat = new THREE.RawShaderMaterial({
      glslVersion:    THREE.GLSL3,
      vertexShader:   TEXT_VERT,
      fragmentShader: TEXT_FRAG,
      uniforms: {
        u_Resolution:   { value: new THREE.Vector2(this._width, this._height) },
        u_Instances:    { value: this._textTex },
        u_InstanceTexW: { value: ThreeRenderer.TEXT_VEC4S },
        u_Atlas:        { value: null },
        u_ClipBuf:      { value: this._clipTex },
        u_ClipBufW:     { value: this._clipTexW },
      },
      transparent: true,
      depthTest:   false,
      depthWrite:  false,
      side:        THREE.FrontSide,   // winding fixed in the index buffer
      blending:    THREE.CustomBlending,
      blendEquation:      THREE.AddEquation,
      blendSrc:           THREE.SrcAlphaFactor,
      blendDst:           THREE.OneMinusSrcAlphaFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha:      THREE.OneFactor,
      blendDstAlpha:      THREE.OneMinusSrcAlphaFactor,
    });
    this._textMesh = new THREE.Mesh(this._textGeo, this._textMat);
    this._textMesh.frustumCulled = false;
  }

  private _buildTextTexture(capacity: number): void {
    const w = ThreeRenderer.TEXT_VEC4S;
    const h = Math.max(1, capacity);
    this._textTex?.dispose();
    this._textTex = new THREE.DataTexture(
      new Float32Array(w * h * 4), w, h, THREE.RGBAFormat, THREE.FloatType,
    );
    this._textTex.minFilter = THREE.NearestFilter;
    this._textTex.magFilter = THREE.NearestFilter;
    this._textTex.needsUpdate = true;
    this._textTexCap = capacity;
    if (this._textMat) {
      this._textMat.uniforms['u_Instances'].value    = this._textTex;
      this._textMat.uniforms['u_InstanceTexW'].value = w;
    }
  }

  /** (Re)build the clip-stack data texture for `capacity` entries (3 texels each).
   *  SINGLE ROW (height 1): the glass shader fetches `texelFetch(u_ClipTex, ivec2(i,0))`
   *  assuming a 1-D layout, and the panel/text CLIP_STACK_GLSL's `x=texel%w, y=texel/w`
   *  collapses to y=0 when width ≥ texel count. Width = 3·capacity texels (max ~capacity
   *  682 at the 2048 GPU limit — far beyond any real clip-stack depth). */
  private _buildClipTexture(capacity: number): void {
    const w = Math.max(3, 3 * capacity);   // 3 texels/entry, all on row 0
    const rows = 1;
    this._clipTex?.dispose();
    this._clipTex = new THREE.DataTexture(
      new Float32Array(w * rows * 4), w, rows, THREE.RGBAFormat, THREE.FloatType,
    );
    this._clipTex.minFilter = THREE.NearestFilter;
    this._clipTex.magFilter = THREE.NearestFilter;
    this._clipTex.needsUpdate = true;
    this._clipTexW   = w;
    this._clipTexCap = capacity;
    if (this._panelMat) { this._panelMat.uniforms['u_ClipBuf'].value = this._clipTex; this._panelMat.uniforms['u_ClipBufW'].value = w; }
    if (this._textMat)  { this._textMat.uniforms['u_ClipBuf'].value  = this._clipTex; this._textMat.uniforms['u_ClipBufW'].value  = w; }
    if (this._glassMat) { this._glassMat.uniforms['u_ClipTex'].value = this._clipTex; }
  }

  // ─── Per-Frame ──────────────────────────────────────────────────────────

  BeginFrame(): void {
    this._instanceCount = 0;
    // Recompute the camera view-projection ONCE per frame (it only changes on
    // resize/calibrate, but the camera may animate, so refresh each frame here
    // rather than redundantly per panel batch). Three refreshes matrixWorldInverse
    // only inside render(), so we invert the fresh world matrix ourselves.
    this._camera.updateMatrixWorld();
    this._camera.matrixWorldInverse.copy(this._camera.matrixWorld).invert();
    this._viewProj.multiplyMatrices(this._camera.projectionMatrix, this._camera.matrixWorldInverse);
  }

  EndFrame(): void {
    // Canvas orchestrator calls PresentScene; EndFrame is a no-op here.
  }

  GetFrameGpuMs(): number | null { return null; }

  // ─── Render Targets ─────────────────────────────────────────────────────

  get SceneTexture(): GpuTextureHandle {
    return _mint(this._sceneTarget?.texture ?? null);
  }

  get BlurPyramidTexture(): GpuTextureHandle { return _mint(this._blurResult); }

  // ─── Scene Pass ─────────────────────────────────────────────────────────

  BeginScenePass(clearR: number, clearG: number, clearB: number): void {
    if (!this._sceneTarget) return;
    this._renderer.setRenderTarget(this._sceneTarget);
    this._renderer.setClearColor(new THREE.Color(clearR, clearG, clearB), 1);
    this._renderer.clear(true, true, false);
  }

  EndScenePass(): void {
    // Nothing — panels accumulate into instance buffer until PanelDrawBatch.
  }

  // ─── Panel Rendering ────────────────────────────────────────────────────

  PanelBeginBatch(): void {
    this._instanceCount = 0;
  }

  PanelAddInstance(data: Float32Array, offset: number, count: number): void {
    const fpi = ThreeRenderer.FLOATS_PER_INSTANCE;
    const needed = this._instanceCount * fpi + count;
    if (needed > this._instanceData.length) this._growInstanceBuffer(needed);
    this._instanceData.set(data.subarray(offset, offset + count), this._instanceCount * fpi);
    this._instanceCount += count / fpi;
  }

  PanelDrawBatch(
    canvasWidth: number,
    canvasHeight: number,
    backdrop: GpuTextureHandle | null,
    baseFrostLod: number,
    specTiltX: number,
    specTiltY: number,
    useGlassShader?: boolean,
    _scene?: GpuTextureHandle | null,
    bgPaint?: BgPaint,
    worldSpace?: boolean,
  ): void {
    if (this._instanceCount === 0) return;
    this._uploadInstanceData();

    if (useGlassShader) {
      // Glass batch — draw with the glass material sampling the blur pyramid.
      const m = this._glassMat;
      m.uniforms['u_Resolution'].value.set(canvasWidth, canvasHeight);
      m.uniforms['u_Instances'].value    = this._instanceTex;
      m.uniforms['u_InstanceTexW'].value = this._instanceTexW;
      // Sample the MIPMAPPED pyramid (textureLod-sampleable), NOT the passed
      // `backdrop` handle. That handle is the pre-mipmap level-0 ComputeBlur
      // result captured before GenerateBlurMipmap ran; binding it makes
      // textureLod(u_Backdrop, uv, frostLod) clamp to LOD 0 — so high
      // BackdropFrostBlur produced NO visible frost (only the 1px base blur).
      // GenerateBlurMipmap promotes _blurResult to the real pyramid; use it.
      // Mirrors DrawProgressiveBlur, which already samples _blur.PyramidTexture.
      const pyramid = this._blur.PyramidTexture ?? (backdrop as ThreeTextureHandle | null)?._texture ?? this._blurResult;
      m.uniforms['u_Backdrop'].value     = pyramid;
      m.uniforms['u_BaseFrostLod'].value = baseFrostLod;
      (m.uniforms['u_SpecularTilt'].value as THREE.Vector2).set(specTiltX, specTiltY);
      m.uniforms['u_ClipTex'].value      = this._clipTex;
      this._panelMesh.material = m;
    } else {
      this._panelMat.uniforms['u_Resolution'].value.set(canvasWidth, canvasHeight);
      // View-projection (world device-px → clip) — computed ONCE per frame in
      // BeginFrame, not per batch (the camera only changes on resize). Reused
      // here. For z=0 it reproduces the flat NDC mapping exactly; translateZ/
      // World use it for perspective.
      (this._panelMat.uniforms['u_ViewProj'].value as THREE.Matrix4).copy(this._viewProj);
      this._panelMat.uniforms['u_CamDist'].value = this._camDist;
      this._bindBgPaint(bgPaint);
      this._panelMesh.material = this._panelMat;
    }

    // DEPTH-AS-LAYERING. Screen-space batches (the default, z=0) draw with depth
    // test+write OFF → pure painter's order, pixel-identical to the 2D board and
    // the WebGL2 copy. WORLD-space batches turn depth test+write ON so they
    // occlude / are occluded by 3D subsystem content and each other by true Z
    // ("front amount" as a real layer axis). We toggle on the active material
    // for this draw and restore after, so screen batches are never affected.
    const mat = this._panelMesh.material as THREE.Material;
    if (worldSpace) {
      mat.depthTest = true;
      mat.depthWrite = true;
      mat.needsUpdate = true;
    }

    this._renderer.setRenderTarget(this._sceneTarget);
    this._renderer.render(this._panelScene, this._camera);

    if (worldSpace) {
      mat.depthTest = false;
      mat.depthWrite = false;
      mat.needsUpdate = true;
    }
    this._panelMesh.material = this._panelMat;  // restore default for next batch
    this._instanceCount = 0;
  }

  /** Set the per-draw background-paint uniforms on _panelMat. Color (or no
   *  paint) resets to mode 0 with stop count 0 so a prior gradient/image can't
   *  leak into the next solid batch — keeping Color pixel-identical. Gradient /
   *  image batches are single-panel per the Renderer contract. */
  private _bindBgPaint(bgPaint: BgPaint | undefined): void {
    const u = this._panelMat.uniforms;
    if (!bgPaint || bgPaint.Mode === 'Color') {
      u['u_BgMode'].value = 0;
      u['u_GradStopCount'].value = 0;
      u['u_BgImage'].value = null;
      return;
    }
    if (bgPaint.Mode === 'Image') {
      u['u_BgMode'].value = 1;
      u['u_BgImage'].value = (bgPaint.Texture as ThreeTextureHandle)._texture;
      (u['u_BgUv'].value as THREE.Vector4).set(
        bgPaint.UvScaleX, bgPaint.UvScaleY, bgPaint.UvOffsetX, bgPaint.UvOffsetY);
      u['u_BgFade'].value = bgPaint.FadeAlpha;
      u['u_GradStopCount'].value = 0;
      return;
    }
    // Gradient — pack stops (capped at 8) into the color/pos uniform arrays.
    const stops = bgPaint.Stops;
    const n = Math.min(stops.length, 8);
    const colors = u['u_GradStopColor'].value as THREE.Vector4[];
    const positions = u['u_GradStopPos'].value as Float32Array;
    for (let i = 0; i < n; i++) {
      const s = stops[i];
      colors[i].set(s.R, s.G, s.B, s.A);
      positions[i] = s.Position;
    }
    u['u_GradStopCount'].value = n;
    u['u_BgImage'].value = null;
    if (bgPaint.Mode === 'LinearGradient') {
      u['u_BgMode'].value = 2;
      (u['u_GradDir'].value as THREE.Vector2).set(bgPaint.DirX, bgPaint.DirY);
    } else {
      u['u_BgMode'].value = 3;
      (u['u_GradDir'].value as THREE.Vector2).set(bgPaint.CenterX, bgPaint.CenterY);
      u['u_GradRadius'].value = bgPaint.Radius;
    }
  }

  /**
   * (Re)build the instance data texture for `capacity` instances.
   *
   * Each instance occupies `INSTANCE_VEC4S` consecutive RGBA32F texels. The
   * texture is laid out row-major with a fixed width of `INSTANCE_VEC4S` texels
   * (one instance per row) so the shader's texel index math is trivial:
   * `texel = instance * INSTANCE_VEC4S + slot`.
   *
   * Future-proof: adding per-instance data (Phase 3 glass already uses all 15
   * slots; Phase 5 thickness/lighting can extend past 15) only requires bumping
   * INSTANCE_VEC4S and FLOATS_PER_INSTANCE — no attribute-slot ceiling, no
   * per-slot plumbing, no shader attribute list to grow. The vertex shader
   * fetches any slot by index via fetchSlot(id, slot).
   */
  private _buildInstanceTexture(capacity: number): void {
    const w = ThreeRenderer.INSTANCE_VEC4S;          // texels per instance row
    const h = Math.max(1, capacity);                 // one instance per row
    this._instanceTex?.dispose();
    this._instanceTex = new THREE.DataTexture(
      new Float32Array(w * h * 4), w, h, THREE.RGBAFormat, THREE.FloatType,
    );
    this._instanceTex.minFilter = THREE.NearestFilter;
    this._instanceTex.magFilter = THREE.NearestFilter;
    this._instanceTex.needsUpdate = true;
    this._instanceTexW   = w;
    this._instanceTexCap = capacity;
    if (this._panelMat) {
      this._panelMat.uniforms['u_Instances'].value    = this._instanceTex;
      this._panelMat.uniforms['u_InstanceTexW'].value = w;
    }
    if (this._glassMat) {   // glass shares the same instance texture
      this._glassMat.uniforms['u_Instances'].value    = this._instanceTex;
      this._glassMat.uniforms['u_InstanceTexW'].value = w;
    }
  }

  /** Copy this batch's packed instance floats into the data texture and mark it
   *  dirty. One upload per draw — no per-instance allocations. Grows the
   *  texture (doubling) when the batch exceeds current capacity. */
  private _uploadInstanceData(): void {
    const n = this._instanceCount;
    if (n > this._instanceTexCap) {
      let cap = this._instanceTexCap;
      while (cap < n) cap *= 2;
      this._buildInstanceTexture(cap);
    }
    // The texture backing array is laid out exactly like _instanceData
    // (FLOATS_PER_INSTANCE contiguous floats per instance), so this is a single
    // contiguous copy — rows beyond `n` are stale but never sampled.
    const dst = this._instanceTex.image.data as Float32Array;
    dst.set(this._instanceData.subarray(0, n * ThreeRenderer.FLOATS_PER_INSTANCE));
    this._instanceTex.needsUpdate = true;
    (this._panelGeo as THREE.InstancedBufferGeometry).instanceCount = n;
  }

  private _growInstanceBuffer(minFloats: number): void {
    let cap = this._instanceData.length;
    while (cap < minFloats) cap *= 2;
    const grown = new Float32Array(cap);
    grown.set(this._instanceData);
    this._instanceData = grown;
  }

  // ─── Text ────────────────────────────────────────────────────────────────

  TextBeginBatch(): void {
    this._textCount = 0;
  }

  TextAddInstance(data: Float32Array, offset: number, count: number): void {
    const fpi = 16;
    const needed = this._textCount * fpi + count;
    if (needed > this._textData.length) {
      let cap = this._textData.length;
      while (cap < needed) cap *= 2;
      const grown = new Float32Array(cap);
      grown.set(this._textData);
      this._textData = grown;
    }
    this._textData.set(data.subarray(offset, offset + count), this._textCount * fpi);
    this._textCount += count / fpi;
  }

  TextDrawBatch(canvasWidth: number, canvasHeight: number, atlas: GpuTextureHandle): void {
    if (this._textCount === 0) return;
    const atlasTex = (atlas as ThreeTextureHandle)._texture;
    if (!atlasTex) return;

    const n = this._textCount;
    if (n > this._textTexCap) {
      let cap = this._textTexCap;
      while (cap < n) cap *= 2;
      this._buildTextTexture(cap);
    }
    (this._textTex.image.data as Float32Array).set(this._textData.subarray(0, n * 16));
    this._textTex.needsUpdate = true;

    this._textMat.uniforms['u_Resolution'].value.set(canvasWidth, canvasHeight);
    this._textMat.uniforms['u_Atlas'].value = atlasTex;
    (this._textGeo as THREE.InstancedBufferGeometry).instanceCount = n;

    this._renderer.setRenderTarget(this._sceneTarget);
    this._renderer.render(this._textScene, this._camera);
    this._textCount = 0;
  }

  // ─── Blur (Phase 3) ─────────────────────────────────────────────────────

  ComputeBlur(
    input: GpuTextureHandle,
    width: number, height: number, radius: number,
    minDepth?: number,
    scissor?: { x: number; y: number; w: number; h: number },
  ): GpuTextureHandle {
    const tex = (input as ThreeTextureHandle)._texture;
    if (!tex) return this.BlurPyramidTexture;
    this._blurResult = this._blur.Blur(tex, width, height, radius, minDepth ?? 0, scissor);
    this._lastBlurDepth = this._blur.LastDepth;
    return _mint(this._blurResult);
  }

  GenerateBlurMipmap(maxLod?: number): void {
    this._blur.GenerateMipmap(maxLod);
    // The mipmapped pyramid (textureLod-sampleable) becomes the current blur
    // result so glass/pblur sample the real LOD chain, not just level 0.
    const pyr = this._blur.PyramidTexture;
    if (pyr) this._blurResult = pyr;
  }

  get LastBlurDepth(): number { return this._lastBlurDepth; }

  DrawProgressiveBlur(params: ProgressiveBlurParams): void {
    const m = this._pblurMat;
    m.uniforms['u_Resolution'].value.set(this._width, this._height);
    (m.uniforms['u_Rect'].value as THREE.Vector4).set(params.Rect.X, params.Rect.Y, params.Rect.W, params.Rect.H);
    m.uniforms['u_Scene'].value   = (params.Scene as ThreeTextureHandle)._texture;
    // Use the mipmapped pyramid built by GenerateBlurMipmap (textureLod-sampleable)
    // — the passed handle is the pre-mipmap level-0 blur.
    m.uniforms['u_Pyramid'].value = this._blur.PyramidTexture
      ?? (params.Pyramid as ThreeTextureHandle)._texture;
    m.uniforms['u_MaxLod'].value    = params.MaxLod;
    m.uniforms['u_Direction'].value = params.Direction;
    m.uniforms['u_Feather'].value   = params.Feather;
    m.uniforms['u_Easing'].value    = params.Easing;
    m.uniforms['u_Opacity'].value   = params.Opacity;
    (m.uniforms['u_Background'].value as THREE.Vector4).set(
      params.Background.R, params.Background.G, params.Background.B, params.Background.A);
    (m.uniforms['u_Grading'].value as THREE.Vector3).set(
      params.Grading.Brightness, params.Grading.Saturation, params.Grading.Contrast);
    m.uniforms['u_ClipTex'].value = this._clipTex;
    (m.uniforms['u_ClipMeta'].value as number[])[0] = params.ClipOffset;
    (m.uniforms['u_ClipMeta'].value as number[])[1] = params.ClipCount;

    this._renderer.setRenderTarget(this._sceneTarget);
    this._renderer.render(this._pblurScene, this._camera);
  }

  // ─── Blit / Snapshot ────────────────────────────────────────────────────

  Blit(source: GpuTextureHandle): void {
    const h = source as ThreeTextureHandle;
    if (!h._texture) return;
    this._blitMat.uniforms['u_Tex'].value = h._texture;
    this._renderer.setRenderTarget(null);
    this._renderer.render(this._blitScene, this._blitCam);
  }

  SnapshotScreen(): GpuTextureHandle {
    // Copy the scene target into a snapshot RT so a pass that draws INTO the
    // scene target can still sample what was there (no feedback loop). Glass
    // samples the blur pyramid (separate texture) so it doesn't need this, but
    // progressive blur's u_Scene does.
    if (!this._sceneTarget) return this.SceneTexture;
    const w = this._sceneTarget.width, h = this._sceneTarget.height;
    if (!this._snapshotTarget || this._snapshotTarget.width !== w || this._snapshotTarget.height !== h) {
      this._snapshotTarget?.dispose();
      this._snapshotTarget = new THREE.WebGLRenderTarget(w, h, {
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
        depthBuffer: false, stencilBuffer: false,
      });
    }
    this._blitMat.uniforms['u_Tex'].value = this._sceneTarget.texture;
    this._renderer.setRenderTarget(this._snapshotTarget);
    this._renderer.render(this._blitScene, this._blitCam);
    this._renderer.setRenderTarget(this._sceneTarget);
    return _mint(this._snapshotTarget.texture);
  }

  // ─── Texture Management ─────────────────────────────────────────────────

  CreateTexture(width: number, height: number): GpuTextureHandle {
    // Byte-RGBA texture cleared to transparent; UploadSubTexture fills regions
    // from a canvas/ImageBitmap. Used for the glyph atlas and image quads.
    const tex = new THREE.DataTexture(
      new Uint8Array(width * height * 4), width, height,
      THREE.RGBAFormat, THREE.UnsignedByteType,
    );
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.flipY = false;          // atlas UVs are top-left origin, like canvas
    tex.premultiplyAlpha = false;
    tex.needsUpdate = true;
    return _mint(tex);
  }

  UploadSubTexture(
    texture: GpuTextureHandle,
    x: number, y: number,
    source: HTMLCanvasElement | OffscreenCanvas | ImageBitmap | ImageData,
  ): void {
    const tex = (texture as ThreeTextureHandle)._texture as THREE.DataTexture | null;
    if (!tex) return;

    // Direct texSubImage2D from the source into the atlas, going around Three's
    // texture-state cache so it can't clobber our manual bind: we save/restore
    // the active 2D binding and dirty Three's cache afterward. (copyTextureToTexture
    // requires a matching source THREE.Texture per call — heavier, and r152+ only.)
    const gl = this._renderer.getContext() as WebGL2RenderingContext;
    this._renderer.initTexture(tex);  // ensures __webglTexture exists + storage allocated
    const glTex = (this._renderer.properties.get(tex) as { __webglTexture?: WebGLTexture }).__webglTexture;
    if (!glTex) return;

    const prev = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
    gl.bindTexture(gl.TEXTURE_2D, glTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (source instanceof ImageData) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, source.width, source.height,
        gl.RGBA, gl.UNSIGNED_BYTE, source.data);
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, gl.RGBA, gl.UNSIGNED_BYTE,
        source as TexImageSource);
    }
    gl.bindTexture(gl.TEXTURE_2D, prev);
    // Three caches bound-texture state per unit; force a re-bind next use.
    this._renderer.resetState();
  }

  // ─── Clip Stack ──────────────────────────────────────────────────────────

  SetClipBuffer(data: Float32Array, floatCount: number): void {
    const entries = floatCount / 12;  // CLIP_FLOATS_PER_ENTRY
    if (entries > this._clipTexCap) {
      let cap = this._clipTexCap;
      while (cap < entries) cap *= 2;
      this._buildClipTexture(cap);
    }
    const dst = this._clipTex.image.data as Float32Array;
    dst.set(data.subarray(0, floatCount));
    this._clipTex.needsUpdate = true;
  }

  // ─── Render State ───────────────────────────────────────────────────────

  EnableBlend(): void {}   // Three manages blend via material settings.
  DisableBlend(): void {}

  BindDefaultTarget(clear?: { R: number; G: number; B: number }): void {
    this._renderer.setRenderTarget(null);
    if (clear) {
      this._renderer.setClearColor(new THREE.Color(clear.R, clear.G, clear.B), 1);
      this._renderer.clear(true, false, false);
    }
  }

  RebindSceneTarget(): void {
    this._renderer.setRenderTarget(this._sceneTarget);
  }

  InvalidateFrameTransients(): void {}

  PresentScene(): void {
    if (!this._sceneTarget) return;
    this._blitMat.uniforms['u_Tex'].value = this._sceneTarget.texture;
    this._renderer.setRenderTarget(null);
    this._renderer.render(this._blitScene, this._blitCam);
  }

  SetViewport(x: number, y: number, width: number, height: number): void {
    this._renderer.setViewport(x, y, width, height);
  }

  // ─── Subsystem escape hatch ─────────────────────────────────────────────

  /** Atmospheric fog for depth-pushed UI. Off by default (density 0 = no change
   *  to the z=0 board). `start`/`range` are view-depth in device px relative to
   *  the camera; on-plane UI sits at view-depth ≈ camera distance, so a `start`
   *  near that keeps the plane fog-free and only world/Z-pushed elements haze. */
  SetFog(opts: { Color?: [number, number, number]; Start?: number; Range?: number; Density?: number }): void {
    const u = this._panelMat?.uniforms;
    if (!u) return;
    if (opts.Color)  (u['u_FogColor'].value as THREE.Vector3).set(opts.Color[0], opts.Color[1], opts.Color[2]);
    if (opts.Start   !== undefined) u['u_FogStart'].value   = opts.Start;
    if (opts.Range   !== undefined) u['u_FogRange'].value   = opts.Range;
    if (opts.Density !== undefined) u['u_FogDensity'].value = opts.Density;
  }

  /** Scene light the UI responds to (cursor/gyro-driven sheen + specular glint).
   *  Off by default (Strength 0 = no-op). Pos is device px (x,y) + height (z);
   *  set it to the pointer each frame for "light rakes across the UI" feel. */
  SetLight(opts: { Pos?: [number, number, number]; Color?: [number, number, number]; Strength?: number; Radius?: number }): void {
    const u = this._panelMat?.uniforms;
    if (!u) return;
    if (opts.Pos)   (u['u_LightPos'].value as THREE.Vector3).set(opts.Pos[0], opts.Pos[1], opts.Pos[2]);
    if (opts.Color) (u['u_LightColor'].value as THREE.Vector3).set(opts.Color[0], opts.Color[1], opts.Color[2]);
    if (opts.Strength !== undefined) u['u_LightStrength'].value = opts.Strength;
    if (opts.Radius   !== undefined) u['u_LightRadius'].value   = opts.Radius;
  }

  /** Shared scene light set (from `<light>` Jivs). Drives BOTH real THREE lights
   *  for World/Janvas meshes AND the UI surface shader's lighting — one shared
   *  environment, so a `<light>` rakes a glass pill and a marcher mesh alike.
   *  Empty ⇒ a default key+ambient so nothing goes black. Positions are device px
   *  (+z toward viewer); the slab/face lighting reads the dominant light. */
  SetSceneLights(items: ReadonlyArray<{ Light: { Kind: string; Color: { R: number; G: number; B: number }; Intensity: number; Direction: [number, number, number]; Range: number; ConeAngle: number; Penumbra: number }; X: number; Y: number; Z: number }>): void {
    // Sync the THREE light pool for mesh lighting. Reuse existing lights where
    // the kind matches to avoid per-frame allocation; add/remove the tail.
    let ambientR = 0, ambientG = 0, ambientB = 0;
    const nonAmbient = items.filter((it) => it.Light.Kind !== 'Ambient');
    for (const it of items) {
      if (it.Light.Kind === 'Ambient') {
        ambientR += it.Light.Color.R * it.Light.Intensity;
        ambientG += it.Light.Color.G * it.Light.Intensity;
        ambientB += it.Light.Color.B * it.Light.Intensity;
      }
    }
    // Default key+ambient when no lights authored, so meshes + surfaces never go
    // black and the current look is preserved until a <light> is added.
    const hasAny = items.length > 0;
    this._ambientLight.color.setRGB(hasAny ? ambientR : 0.55, hasAny ? ambientG : 0.55, hasAny ? ambientB : 0.6);
    this._ambientLight.intensity = 1;
    if (!this._ambientLight.parent) this._scene.add(this._ambientLight);

    // Grow/shrink the directional/point pool to match nonAmbient count.
    while (this._sceneLights.length < nonAmbient.length) {
      const dl = new THREE.DirectionalLight(0xffffff, 1);
      this._sceneLights.push(dl);
      this._scene.add(dl);
    }
    while (this._sceneLights.length > nonAmbient.length) {
      const dl = this._sceneLights.pop()!;
      this._scene.remove(dl);
    }
    for (let i = 0; i < nonAmbient.length; i++) {
      const it = nonAmbient[i];
      const l = this._sceneLights[i] as THREE.DirectionalLight;
      l.color.setRGB(it.Light.Color.R, it.Light.Color.G, it.Light.Color.B);
      l.intensity = it.Light.Intensity;
      // Position in world: device px, +z toward viewer (matches camera calib).
      l.position.set(it.X, it.Y, it.Z + this._camDist);
      l.target.position.set(it.X + it.Light.Direction[0], it.Y + it.Light.Direction[1], it.Z + it.Light.Direction[2]);
      if (!l.target.parent) this._scene.add(l.target);
    }

    // Drive the UI surface shader from the dominant light (first non-ambient),
    // so panels/slabs catch the same light. Off (strength 0) when none — the
    // surface keeps its per-element LightAngle baseline, no regression.
    const u = this._panelMat?.uniforms;
    if (u) {
      if (nonAmbient.length > 0) {
        const it = nonAmbient[0];
        // The positional sheen (u_LightPos/Strength/Radius) is a LOCAL highlight —
        // only Point/Spot lights drive it (a Directional light has no position;
        // feeding it here washes the whole screen white). Directional lights only
        // drive the bevel/face shading via u_SceneLightDir below.
        if (it.Light.Kind === 'Point' || it.Light.Kind === 'Spot') {
          (u['u_LightPos'].value as THREE.Vector3).set(it.X, it.Y, Math.max(it.Z + this._camDist, 1));
          (u['u_LightColor'].value as THREE.Vector3).set(it.Light.Color.R, it.Light.Color.G, it.Light.Color.B);
          u['u_LightStrength'].value = Math.min(it.Light.Intensity * 0.3, 0.6);
          u['u_LightRadius'].value = it.Light.Range > 0 ? it.Light.Range : 700;
        } else {
          u['u_LightStrength'].value = 0;
        }
        // Scene light direction for the slab bevel/face shading. The shader's L
        // is the direction TOWARD the light: screen xy = -aim.xy, z = forward
        // lean from -aim.z. Normalized in-shader. Makes a <light> rake slab depth.
        const dir = it.Light.Direction;
        (u['u_SceneLightDir'].value as THREE.Vector3).set(-dir[0], dir[1], Math.max(-dir[2], 0.2));
        (u['u_SceneLightColor'].value as THREE.Vector3).set(it.Light.Color.R, it.Light.Color.G, it.Light.Color.B);
        u['u_SceneLightInt'].value = it.Light.Intensity;
        u['u_SceneLightOn'].value = 1;
      } else {
        u['u_LightStrength'].value = 0;
        u['u_SceneLightOn'].value = 0;
      }
    }
  }

  /** Depth-of-field — elements far from the focus depth soften. Off by default
   *  (Strength 0). FocusDepth/Range are view-depth in device px (on-plane UI sits
   *  at view-depth ≈ camera distance). Per-element approximation (see shader). */
  SetDof(opts: { FocusDepth?: number; FocusRange?: number; Strength?: number }): void {
    const u = this._panelMat?.uniforms;
    if (!u) return;
    if (opts.FocusDepth !== undefined) u['u_FocusDepth'].value = opts.FocusDepth;
    if (opts.FocusRange !== undefined) u['u_FocusRange'].value = opts.FocusRange;
    if (opts.Strength   !== undefined) u['u_DofStrength'].value = opts.Strength;
  }

  /** Raw Three access for Janvas subsystems (marchers etc.) — see ThreeMigration.md. */
  GetThree(): {
    Scene:    THREE.Scene;
    World:    THREE.Group;
    Renderer: THREE.WebGLRenderer;
    Camera:   THREE.PerspectiveCamera;
  } {
    return {
      Scene:    this._scene,
      World:    this._world,
      Renderer: this._renderer,
      Camera:   this._camera,
    };
  }

  /** Attach (once) and tick Janvas subsystems into the shared world. They mount
   *  their own Object3D subtree under `_world` and are drawn as part of the
   *  unified frame (the next `_world` render / scene composite), NOT as a
   *  separate FBO pass — so they share camera + depth + lights with the UI. */
  DrawSubsystems(items: ReadonlyArray<SubsystemDrawItem>, dt: number): void {
    for (const item of items) {
      if (!this._attachedSubsystems.has(item.Key)) {
        this._attachedSubsystems.add(item.Key);
        item.Renderer.Attach({
          Scene:    this._scene,
          World:    this._world,
          Camera:   this._camera,
          Renderer: this._renderer,
          MarkDirty: () => { /* Canvas drives dirty via the Janvas node */ },
        });
      }
      if (item.Dirty) item.Renderer.Update(item.Rect, dt);
    }
    // The subsystem subtree lives under `_world`; render it into the scene
    // target so panels/glass composite over it (UI draws after this).
    this._renderer.setRenderTarget(this._sceneTarget);
    this._renderer.render(this._scene, this._camera);
  }
}
