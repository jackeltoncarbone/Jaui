/**
 * Three.Shaders — GLSL ES 3.00 (WebGL2) ports of the WGSL panel and
 * progressive-blur shaders.
 *
 * GLASS_VERT / GLASS_FRAG: full glass panel — refraction, chromatic aberration,
 * specular, fresnel, edge lighting, bezel, Beer-Lambert tint, border refilter.
 * Instance data arrives as 15 vec4 per-instance attributes (locations 1..15),
 * same layout as the flat-panel shader in Three.Renderer.ts.
 *
 * PBLUR_FRAG: progressive blur — ramp-driven LOD sampling from a blur pyramid.
 * Shares PROGRESSIVE_BLUR_VERT from ProgressiveBlur.Shader.ts (reproduced here
 * as GLASS_VERT is panel-specific). The pblur vert is the same one already in
 * ProgressiveBlur.Shader.ts; consumers that already import that module can reuse
 * PROGRESSIVE_BLUR_VERT directly.
 *
 * Port notes vs WGSL source (Panel.wgsl / ProgressiveBlur.wgsl):
 *  - Storage buffers (instance array, clip_stack array) → per-instance attributes
 *    + sampler2D clip texture fetched with texelFetch.
 *  - Flat instance_id interpolation → all 15 vec4 varyings passed explicitly.
 *  - WGSL select(a,b,cond) → GLSL ternary throughout.
 *  - textureSampleLevel → textureLod; textureSample → texture.
 *  - WGSL var<private> SS_PILL_CURVE array → GLSL const array (GLSL ES 3.00
 *    supports const arrays of structs/vectors).
 *  - WGSL shape_mode / ss_pill paths fully ported; all three shape regimes
 *    (Rect, Pill, Circle) behave identically to the reference.
 *  - inside_clip_stack: WGSL hard-discards; GLSL smoothsteps the edge (1 px)
 *    matching ProgressiveBlur.Shader.ts convention for AA clip edges. The panel
 *    variant keeps the hard discard (matching WGSL semantics) because clip AA
 *    belongs to the clip composite pass, not the panel itself.
 */

// ─── Shared vertex shader ────────────────────────────────────────────────────
// Tiles the unit quad [0,1]² to the panel's device-pixel rect, converts to NDC,
// and passes all 15 instance vec4s as varyings. Matches WGSL vs_main exactly.

// Instance data is fetched from the shared RGBA32F instance texture by
// gl_InstanceID (NOT vertex attributes — 15 vec4 attrs + position overflow the
// 16-slot WebGL2 ceiling and Three silently drops the draw). Matches PANEL_VERT.
export const GLASS_VERT: string = /* glsl */`
precision highp float;

in vec3 position;            // unit quad [0,1]

uniform vec2 u_Resolution;
uniform sampler2D u_Instances;
uniform int u_InstanceTexW;

out vec2 v_PixelPos;
out vec4 v_PanelGeom;
out vec4 v_Radii;
out vec4 v_Tint;
out vec4 v_BorderColor;
out vec4 v_ShadowColor;
out vec4 v_ShadowParams;
out vec4 v_StyleParams;
out vec4 v_Grading;
out vec4 v_Refraction;
out vec4 v_Lighting;
out vec4 v_Specular;
out vec4 v_RimEdge;
out vec4 v_Outline;
out vec4 v_BorderFilter;

vec4 fetchSlot(int instance, int slot) {
  int texel = instance * 16 + slot;
  int x = texel % u_InstanceTexW;
  int y = texel / u_InstanceTexW;
  return texelFetch(u_Instances, ivec2(x, y), 0);
}

void main() {
  int id = gl_InstanceID;
  vec4 a_Rect    = fetchSlot(id, 0);
  v_PanelGeom    = fetchSlot(id, 1);
  v_Radii        = fetchSlot(id, 2);
  v_Tint         = fetchSlot(id, 3);
  v_BorderColor  = fetchSlot(id, 4);
  v_ShadowColor  = fetchSlot(id, 5);
  v_ShadowParams = fetchSlot(id, 6);
  v_StyleParams  = fetchSlot(id, 7);
  v_Grading      = fetchSlot(id, 8);
  v_Refraction   = fetchSlot(id, 9);
  v_Lighting     = fetchSlot(id, 10);
  v_Specular     = fetchSlot(id, 11);
  v_RimEdge      = fetchSlot(id, 12);
  v_Outline      = fetchSlot(id, 13);
  v_BorderFilter = fetchSlot(id, 14);

  vec2 pos = a_Rect.xy + position.xy * a_Rect.zw;
  vec2 ndc = (pos / u_Resolution) * 2.0 - 1.0;
  ndc.y    = -ndc.y;
  gl_Position = vec4(ndc, 0.0, 1.0);
  v_PixelPos  = pos;
}
`;

// ─── Glass fragment shader ───────────────────────────────────────────────────

export const GLASS_FRAG: string = /* glsl */`
precision highp float;

in vec2 v_PixelPos;
in vec4 v_PanelGeom;     // cx, cy, halfW, halfH
in vec4 v_Radii;         // tl, tr, br, bl
in vec4 v_Tint;
in vec4 v_BorderColor;
in vec4 v_ShadowColor;
in vec4 v_ShadowParams;  // offsetX, offsetY, blur, borderWidth
in vec4 v_StyleParams;   // borderEdgeAa, smoothness, opacity, materialType
in vec4 v_Grading;       // brightness, saturation, contrast, frostLod
in vec4 v_Refraction;    // thickness, bezelWidth, refractionStrength, bezelScale
in vec4 v_Lighting;      // lightDirX, lightDirY, lightIntensity, fresnelStrength
in vec4 v_Specular;      // specIntensity, specSharpness, chromaticAberration, innerBlur
in vec4 v_RimEdge;       // edgeLightTop, edgeLightBottom, borderVariance, bulge
in vec4 v_Outline;       // borderAlphaVariance, borderFresnelBrightness, clipOffset, clipCount
in vec4 v_BorderFilter;  // brightnessMul, saturationMul, contrastMul, lodOffset

// Per-frame uniforms
uniform vec2      u_Resolution;
uniform float     u_BaseFrostLod;
uniform vec2      u_SpecularTilt;
uniform sampler2D u_Backdrop;     // mipmapped blur pyramid / scene backdrop
uniform sampler2D u_ClipTex;      // clip-stack texture (texelFetch, 1-D logical layout)

out vec4 fragColor;

// ─── Constants ───────────────────────────────────────────────────────────────

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// Show Studio pill polyline — 33 sample points along upper-right endcap quarter.
// Generated by tests/Pill.PolylineGen.test.ts; do not hand-edit.
const int   SS_PILL_POINT_COUNT = 33;
const float SS_PILL_MAXEXTENT   = 1.6236;

const vec2 SS_PILL_CURVE[33] = vec2[33](
  vec2(0.000000, 1.000000), vec2(0.071905, 0.999903), vec2(0.141683, 0.999227),
  vec2(0.209303, 0.997390), vec2(0.274729, 0.993813), vec2(0.337929, 0.987916),
  vec2(0.398867, 0.979119), vec2(0.457512, 0.966841), vec2(0.513828, 0.950503),
  vec2(0.567783, 0.929525), vec2(0.619341, 0.903327), vec2(0.668471, 0.871328),
  vec2(0.715137, 0.832948), vec2(0.759307, 0.787608), vec2(0.800946, 0.734728),
  vec2(0.840021, 0.673727), vec2(0.874726, 0.607726), vec2(0.889889, 0.574476),
  vec2(0.904073, 0.540309), vec2(0.917279, 0.505288), vec2(0.929507, 0.469473),
  vec2(0.940756, 0.432925), vec2(0.951027, 0.395705), vec2(0.960321, 0.357875),
  vec2(0.968635, 0.319495), vec2(0.975972, 0.280627), vec2(0.982330, 0.241331),
  vec2(0.987711, 0.201669), vec2(0.992113, 0.161702), vec2(0.995536, 0.121490),
  vec2(0.997982, 0.081095), vec2(0.999449, 0.040578), vec2(0.999938, 0.000000)
);

// ─── Clip stack ──────────────────────────────────────────────────────────────
// Each clip entry is 3 texels: rect(x,y,w,h), radii(tl,tr,br,bl), meta(smoothness,_,_,_).
// Stored in a 1-D sampler2D; texelFetch(tex, ivec2(index, 0), 0).

const int MAX_CLIP_DEPTH = 16;

float pickClipRadius(vec2 p, vec4 radii) {
  if (p.x >= 0.0) return p.y <= 0.0 ? radii.y : radii.z;
  return p.y <= 0.0 ? radii.x : radii.w;
}

bool insideClipShape(vec2 pixel, vec4 rect, vec4 radii, float smoothness) {
  vec2 center   = rect.xy + rect.zw * 0.5;
  vec2 halfSize = rect.zw * 0.5;
  vec2 qSigned  = pixel - center;
  vec2 qAbs     = abs(qSigned);
  if (qAbs.x > halfSize.x || qAbs.y > halfSize.y) return false;
  float r       = pickClipRadius(qSigned, radii);
  vec2  cornerP = qAbs - (halfSize - vec2(r));
  if (r <= 0.0 || cornerP.x <= 0.0 || cornerP.y <= 0.0) return true;
  float n = 2.0 + 6.0 * clamp(smoothness, 0.0, 1.0);
  float L = pow(cornerP.x / r, n) + pow(cornerP.y / r, n);
  return L <= 1.0;
}

bool insideClipStack(vec2 pixel, int offset, int count) {
  for (int i = 0; i < MAX_CLIP_DEPTH; i++) {
    if (i >= count) break;
    int base    = (offset + i) * 3;
    vec4 rect   = texelFetch(u_ClipTex, ivec2(base,     0), 0);
    vec4 radii  = texelFetch(u_ClipTex, ivec2(base + 1, 0), 0);
    vec4 meta   = texelFetch(u_ClipTex, ivec2(base + 2, 0), 0);
    if (!insideClipShape(pixel, rect, radii, meta.x)) return false;
  }
  return true;
}

// ─── SDF helpers ─────────────────────────────────────────────────────────────

float smoothnessToExponent(float s) {
  return 2.0 + 6.0 * clamp(s, 0.0, 1.0);
}

float pickRectRadius(vec2 p, vec4 radii) {
  if (p.x >= 0.0) return p.y <= 0.0 ? radii.y : radii.z;
  return p.y <= 0.0 ? radii.x : radii.w;
}

// Shape classification: 0=Rect, 1=Pill, 2=Circle — mirrors WGSL shape_mode.
int shapeMode(vec2 halfSize, vec4 radii) {
  float minHalf   = min(halfSize.x, halfSize.y);
  float maxHalf   = max(halfSize.x, halfSize.y);
  float aspect    = maxHalf / max(minHalf, 0.0001);
  float minRadius = min(min(radii.x, radii.y), min(radii.z, radii.w));
  if (aspect < 1.43 && minRadius >= minHalf * 0.9)  return 2;
  if (aspect >= 1.7  && minRadius >= minHalf - 1.0) return 1;
  return 0;
}

// Superellipse SDF inner — rect / circle path.
float shapeSdfInner(vec2 p, vec2 halfSize, vec2 rAxis, float n) {
  vec2 q = abs(p) - halfSize + rAxis;
  if (q.x <= 0.0 && q.y <= 0.0) {
    return -min(halfSize.x - abs(p.x), halfSize.y - abs(p.y));
  }
  vec2  qc   = max(q, vec2(0.0));
  vec2  uv   = qc / rAxis;
  vec2  uvE  = max(uv, vec2(1e-5));
  float un   = pow(uvE.x, n);
  float vn   = pow(uvE.y, n);
  float bigL = pow(un + vn, 1.0 / n);
  float nm1  = n - 1.0;
  float gx   = pow(uvE.x, nm1) / rAxis.x;
  float gy   = pow(uvE.y, nm1) / rAxis.y;
  float lf   = pow(bigL, 1.0 - n);
  float gLen = lf * sqrt(gx * gx + gy * gy);
  return (bigL - 1.0) / max(gLen, 1e-5);
}

vec2 shapeGradInner(vec2 p, vec2 halfSize, vec2 rAxis, float n) {
  vec2  q   = abs(p) - halfSize + rAxis;
  vec2  qc  = max(q, vec2(0.0));
  vec2  uv  = qc / rAxis;
  vec2  uvE = max(uv, vec2(1e-5));
  float nm1 = n - 1.0;
  vec2  g   = vec2(
    sign(p.x) * pow(uvE.x, nm1) / rAxis.x,
    sign(p.y) * pow(uvE.y, nm1) / rAxis.y
  );
  float gLen = length(g);
  if (gLen < 1e-4) {
    float dx = halfSize.x - abs(p.x);
    float dy = halfSize.y - abs(p.y);
    return dx < dy ? vec2(sign(p.x), 0.0) : vec2(0.0, sign(p.y));
  }
  return g / gLen;
}

// SS Pill — merged SDF + gradient loop.
// Returns dist in .x, gradient in .yz. (Packs into vec3 to avoid struct limits.)
vec3 ssPillEval(vec2 p, vec2 halfSize) {
  bool  horiz     = halfSize.x >= halfSize.y;
  vec2  q         = horiz ? abs(p)    : abs(p.yx);
  vec2  hs        = horiz ? halfSize  : halfSize.yx;
  float halfY     = hs.y;
  float halfX     = hs.x;
  float maxExtent = SS_PILL_MAXEXTENT * halfY;
  float flatStart = halfX - maxExtent;

  if (q.x <= flatStart) {
    float dist = q.y - halfY;
    vec2 g = vec2(0.0, sign(p.y));
    g = horiz ? g : g.yx;
    return vec3(dist, g);
  }

  vec2  qL         = vec2(q.x - flatStart, q.y);
  float minDSq     = 1e9;
  vec2  bestClosest= qL;
  float uB         = -1.0;
  bool  bracketFound = false;

  for (int i = 0; i < SS_PILL_POINT_COUNT - 1; i++) {
    vec2 a = vec2(SS_PILL_CURVE[i].x     * maxExtent, SS_PILL_CURVE[i].y     * halfY);
    vec2 b = vec2(SS_PILL_CURVE[i + 1].x * maxExtent, SS_PILL_CURVE[i + 1].y * halfY);
    vec2 ab = b - a;
    vec2 ap = qL - a;
    float t = clamp(dot(ap, ab) / dot(ab, ab), 0.0, 1.0);
    vec2  cl = a + t * ab;
    vec2  d  = qL - cl;
    float dSq = dot(d, d);
    if (dSq < minDSq) {
      minDSq      = dSq;
      bestClosest = cl;
    }
    if (!bracketFound && qL.y <= a.y && qL.y >= b.y) {
      float dv = a.y - b.y;
      float tb = dv > 0.0001 ? (a.y - qL.y) / dv : 0.0;
      uB = mix(a.x, b.x, tb);
      bracketFound = true;
    }
  }

  float uDist = sqrt(minDSq);
  bool  inside = qL.y <= halfY && uB > 0.0 && qL.x <= uB;
  float dist   = inside ? -uDist : uDist;

  vec2 dg  = qL - bestClosest;
  float l  = length(dg);
  vec2  g  = l > 0.0001 ? dg / l : vec2(1.0, 0.0);
  if (inside) g = -g;
  g.x *= sign(p.x);
  g.y *= sign(p.y);
  g = horiz ? g : g.yx;
  return vec3(dist, g);
}

float ssPillSdf(vec2 p, vec2 halfSize) {
  bool  horiz     = halfSize.x >= halfSize.y;
  vec2  q         = horiz ? abs(p)   : abs(p.yx);
  vec2  hs        = horiz ? halfSize : halfSize.yx;
  float halfY     = hs.y;
  float halfX     = hs.x;
  float maxExtent = SS_PILL_MAXEXTENT * halfY;
  float flatStart = halfX - maxExtent;
  if (q.x <= flatStart) return q.y - halfY;

  vec2  qL       = vec2(q.x - flatStart, q.y);
  float minDSq   = 1e9;
  float uB       = -1.0;
  bool  bracketFound = false;

  for (int i = 0; i < SS_PILL_POINT_COUNT - 1; i++) {
    vec2 a = vec2(SS_PILL_CURVE[i].x     * maxExtent, SS_PILL_CURVE[i].y     * halfY);
    vec2 b = vec2(SS_PILL_CURVE[i + 1].x * maxExtent, SS_PILL_CURVE[i + 1].y * halfY);
    vec2 ab = b - a;
    vec2 ap = qL - a;
    float t = clamp(dot(ap, ab) / dot(ab, ab), 0.0, 1.0);
    vec2  cl = a + t * ab;
    vec2  d  = qL - cl;
    minDSq = min(minDSq, dot(d, d));
    if (!bracketFound && qL.y <= a.y && qL.y >= b.y) {
      float dv = a.y - b.y;
      float tb = dv > 0.0001 ? (a.y - qL.y) / dv : 0.0;
      uB = mix(a.x, b.x, tb);
      bracketFound = true;
    }
  }
  float uDist = sqrt(minDSq);
  bool  inside = qL.y <= halfY && uB > 0.0 && qL.x <= uB;
  return inside ? -uDist : uDist;
}

// Unified dispatch — returns (dist, gradX, gradY).
vec3 shapeEval(vec2 p, vec2 halfSize, vec4 radii, float smoothness, int mode) {
  if (mode == 1) return ssPillEval(p, halfSize);
  vec2  rAxis;
  float n;
  if (mode == 2) {
    rAxis = halfSize;
    n     = 2.0;
  } else {
    float r = min(pickRectRadius(p, radii), min(halfSize.x, halfSize.y));
    rAxis   = vec2(r);
    n       = smoothnessToExponent(smoothness);
  }
  float dist = shapeSdfInner(p, halfSize, rAxis, n);
  vec2  grad = shapeGradInner(p, halfSize, rAxis, n);
  return vec3(dist, grad);
}

float shapeSdf(vec2 p, vec2 halfSize, vec4 radii, float smoothness, int mode) {
  if (mode == 1) return ssPillSdf(p, halfSize);
  vec2  rAxis;
  float n;
  if (mode == 2) {
    rAxis = halfSize;
    n     = 2.0;
  } else {
    float r = min(pickRectRadius(p, radii), min(halfSize.x, halfSize.y));
    rAxis   = vec2(r);
    n       = smoothnessToExponent(smoothness);
  }
  return shapeSdfInner(p, halfSize, rAxis, n);
}

// ─── Backdrop sampling ───────────────────────────────────────────────────────

vec3 sampleBackdrop(vec2 uv, float extraLod, float frostLod) {
  float lod = max(0.0, frostLod - u_BaseFrostLod) + extraLod;
  return textureLod(u_Backdrop, uv, lod).rgb;
}

// ─── Grading ─────────────────────────────────────────────────────────────────

vec3 applyGrading(vec3 colorIn, float brightness, float saturation, float contrast) {
  vec3 color = colorIn * brightness;
  float luma = dot(color, LUMA);
  color = mix(vec3(luma), color, saturation);
  color = (color - 0.5) * contrast + 0.5;
  return color;
}

// ─── Main ────────────────────────────────────────────────────────────────────

void main() {
  // Clip stack — hard discard matching WGSL semantics.
  int clipOffset = int(v_Outline.z);
  int clipCount  = int(v_Outline.w);
  if (!insideClipStack(v_PixelPos, clipOffset, clipCount)) discard;

  vec2  panelCenter   = v_PanelGeom.xy;
  vec2  panelHalfSize = v_PanelGeom.zw;
  vec2  shadowOffset  = v_ShadowParams.xy;
  float shadowBlur    = v_ShadowParams.z;
  float borderWidth   = v_ShadowParams.w;
  float borderEdgeAa  = v_StyleParams.x;
  float smoothness    = v_StyleParams.y;
  float opacity       = v_StyleParams.z;
  float materialType  = v_StyleParams.w;

  float brightness   = v_Grading.x;
  float saturation   = v_Grading.y;
  float contrast     = v_Grading.z;
  float frostLod     = v_Grading.w;

  float thickness         = v_Refraction.x;
  float bezelWidth        = max(v_Refraction.y, 0.5);
  float refractionStrength= v_Refraction.z;
  float bezelScale        = max(v_Refraction.w, 0.05);

  vec2  lightDir         = v_Lighting.xy;
  float lightIntensity   = v_Lighting.z;
  float fresnelStrength  = v_Lighting.w;

  float specIntensity        = v_Specular.x;
  float specSharpness        = max(v_Specular.y, 1.0);
  float chromaticAberration  = v_Specular.z;
  float innerBlur            = v_Specular.w;

  float edgeLightTop    = v_RimEdge.x;
  float edgeLightBottom = v_RimEdge.y;
  float borderVariance  = v_RimEdge.z;
  float bulge           = v_RimEdge.w;

  vec2 p    = v_PixelPos - panelCenter;
  int  mode = shapeMode(panelHalfSize, v_Radii);

  vec3  shapeResult = shapeEval(p, panelHalfSize, v_Radii, smoothness, mode);
  float dist        = shapeResult.x;
  float edgeDist    = max(-dist, 0.0);
  vec2  normal      = shapeResult.yz;

  // Bezel hump (pincushion profile)
  float x    = edgeDist / bezelWidth;
  float s    = bezelScale;
  float hump = clamp((x / s) * exp(1.0 - x / s), 0.0, 1.0);

  // Fill alpha (shape mask)
  float fillAlpha = 1.0 - smoothstep(-0.5, 0.5, dist);
  float aa        = max(borderEdgeAa, 1e-4);

  // Base UV (screen space, Y flipped for GL texture convention)
  vec2  baseUv = vec2(v_PixelPos.x / u_Resolution.x,
                      1.0 - v_PixelPos.y / u_Resolution.y);

  bool hasBackdropFilter =
    abs(brightness - 1.0)  > 0.001 ||
    abs(saturation - 1.0)  > 0.001 ||
    abs(contrast - 1.0)    > 0.001 ||
    frostLod > u_BaseFrostLod + 0.001;

  vec3  backdropRgb = vec3(0.0);
  float lodBoost    = 0.0;

  if (materialType == 1.0) {
    // Glass path — refraction + chromatic aberration
    vec2 tangent      = vec2(-normal.y, normal.x);
    vec2 rotatedNormal= normal * 0.985 + tangent * 0.174;
    vec2 edgeDisp     = -rotatedNormal * hump * thickness;

    vec2 bulgeDisp = vec2(0.0);
    if (bulge != 0.0) {
      float minHalf   = min(panelHalfSize.x, panelHalfSize.y);
      float maxRadius = max(panelHalfSize.x, panelHalfSize.y);
      float normDist  = clamp(length(p) / max(maxRadius, 1.0), 0.0, 1.0);
      float domeProfile = normDist * (1.0 - 0.3 * normDist);
      vec2  radialDir   = length(p) > 0.001 ? p / length(p) : vec2(0.0);
      float bulgeMag    = bulge * minHalf * 0.25;
      bulgeDisp = radialDir * domeProfile * bulgeMag;
    }

    vec2 refractOffset = (edgeDisp + bulgeDisp) * refractionStrength;
    float caPx  = chromaticAberration * hump * 3.0;
    vec2  caStep = normal * caPx;

    vec2 refractPos = v_PixelPos + refractOffset;
    baseUv = vec2(refractPos.x / u_Resolution.x,
                  1.0 - refractPos.y / u_Resolution.y);
    vec2 uvR = vec2((refractPos.x + caStep.x) / u_Resolution.x,
                    1.0 - (refractPos.y + caStep.y) / u_Resolution.y);
    vec2 uvB = vec2((refractPos.x - caStep.x) / u_Resolution.x,
                    1.0 - (refractPos.y - caStep.y) / u_Resolution.y);

    float rimT     = clamp(edgeDist / (bezelWidth * 2.5), 0.0, 1.0);
    float rimBoost = (1.0 - rimT) * (1.0 - rimT);
    lodBoost = rimBoost * 1.5 + innerBlur * 1.0;

    vec3 sR = sampleBackdrop(uvR, lodBoost, frostLod);
    vec3 sG = sampleBackdrop(baseUv, lodBoost, frostLod);
    vec3 sB = sampleBackdrop(uvB, lodBoost, frostLod);
    backdropRgb = vec3(sR.r, sG.g, sB.b);
    backdropRgb = applyGrading(backdropRgb, brightness, saturation, contrast);

  } else if (hasBackdropFilter) {
    vec3 s = sampleBackdrop(baseUv, 0.0, frostLod);
    backdropRgb = applyGrading(s, brightness, saturation, contrast);
  }

  // Beer-Lambert tint (glass only)
  if (materialType == 1.0 && v_Tint.a > 0.001) {
    float pathLength = mix(0.3, 1.0,
      smoothstep(0.0, bezelWidth * 2.0, edgeDist));
    vec3 absorb = pow(max(v_Tint.rgb, vec3(0.0001)),
                      vec3(pathLength * v_Tint.a));
    backdropRgb *= absorb;
  }

  // Variable border width
  float alignment      = dot(normal, lightDir);
  float widthScale     = 1.0 + borderVariance * alignment;
  float localBorderW   = borderWidth * widthScale;
  float localBorderAa  = borderEdgeAa * widthScale;

  // Edge lighting (glass only)
  float edgeLightAlpha = 0.0;
  vec3  edgeLightRgb   = vec3(0.0);
  if (materialType == 1.0 && fillAlpha > 0.0) {
    float rimBand      = max(bezelWidth * 0.75, 6.0);
    float edgeProximity= dist > 0.0 ? 0.0 :
                         clamp(1.0 + dist / rimBand, 0.0, 1.0);
    float falloff      = pow(edgeProximity, 1.6);
    float lightFacing  = max(alignment, 0.0);
    float directional  = 0.6 + 0.4 * pow(lightFacing, 1.5);
    vec2  rimUvRaw     = (v_PixelPos - normal * rimBand * 1.2) / u_Resolution;
    vec2  rimUv        = vec2(rimUvRaw.x, 1.0 - rimUvRaw.y);
    vec3  rimSample    = sampleBackdrop(rimUv, 0.0, frostLod);
    float rimLuma      = dot(rimSample, LUMA);
    vec3  rimVibrant   = clamp(
      mix(vec3(rimLuma), rimSample, 1.6) * 1.25, vec3(0.0), vec3(1.0));
    float specularCap  = pow(edgeProximity, 3.5);
    edgeLightRgb  = mix(rimVibrant, mix(rimVibrant, vec3(1.0), 0.6), specularCap);
    edgeLightAlpha= falloff * directional * fresnelStrength * fillAlpha;
  }

  // Shadow
  vec2  sp          = p - shadowOffset;
  float shadowDist  = shapeSdf(sp, panelHalfSize, v_Radii, smoothness, mode);
  float shadowAlpha = smoothstep(shadowBlur, -shadowBlur, shadowDist)
                      * v_ShadowColor.a;

  // Fill
  vec3  fillRgb;
  float fillA;
  if (materialType == 1.0) {
    fillRgb = backdropRgb;
    fillA   = fillAlpha;
  } else if (hasBackdropFilter) {
    float tA = v_Tint.a;
    fillRgb  = v_Tint.rgb * tA + backdropRgb * (1.0 - tA);
    fillA    = fillAlpha;
  } else {
    fillRgb  = v_Tint.rgb;
    fillA    = fillAlpha * v_Tint.a;
  }

  // Composite: fill OVER shadow
  float outA   = fillA + shadowAlpha * (1.0 - fillA);
  vec3  outRgb = outA > 1e-5
    ? (fillRgb * fillA + v_ShadowColor.rgb * shadowAlpha * (1.0 - fillA)) / outA
    : vec3(0.0);
  vec4 result = vec4(outRgb, outA);

  if (materialType == 1.0) {
    // Hemispherical ambient edge lighting
    float hemiTop    = max(-normal.y, 0.0);
    float hemiBottom = max( normal.y, 0.0);
    float hemiAmbient= edgeLightTop * hemiTop + edgeLightBottom * hemiBottom;
    float rimMask    = dist > 0.0 ? 0.0
      : pow(clamp(1.0 + dist / max(bezelWidth, 0.5), 0.0, 1.0), 2.0);
    vec3  rimAmbientRgb = vec3(hemiAmbient) * rimMask;

    // Inner darkening
    float innerPos      = bezelWidth * 0.35;
    float innerW        = max(thickness * 0.25, 1.2);
    float innerD        = (dist + innerPos) / innerW;
    float innerDarkBand = exp(-innerD * innerD);
    float innerDarkAlpha= innerDarkBand * 0.04;

    // Blinn-Phong specular catchlight
    vec3  n3           = normalize(vec3(normal * hump, 1.0 - hump * 0.7));
    vec2  specLightDir2= normalize(lightDir + u_SpecularTilt);
    vec3  l3           = normalize(vec3(specLightDir2, 0.6));
    vec3  v3           = vec3(0.0, 0.0, 1.0);
    vec3  h3           = normalize(l3 + v3);
    float specBase     = pow(max(dot(n3, h3), 0.0), specSharpness);
    float specAlpha    = specBase * specIntensity * hump * fillAlpha * lightIntensity;

    // Composite glass layers
    result = vec4(result.rgb + rimAmbientRgb * fillAlpha, result.a);
    result = vec4(
      result.rgb * (1.0 - edgeLightAlpha) + edgeLightRgb * edgeLightAlpha,
      result.a   * (1.0 - edgeLightAlpha) + edgeLightAlpha
    );
    result = vec4(result.rgb * (1.0 - innerDarkAlpha), result.a);
    result = vec4(
      result.rgb * (1.0 - specAlpha) + vec3(specAlpha),
      result.a   * (1.0 - specAlpha) + specAlpha
    );

    // Rim specular highlight
    float rimSpecW    = max(thickness * 0.18, 0.75);
    float insideOutline= 1.0 - smoothstep(-aa, aa, dist);
    float withinBand   = smoothstep(-rimSpecW - aa, -rimSpecW + aa, dist);
    float rimSpecBand  = insideOutline * withinBand;
    vec2  specLightDirRim = normalize(lightDir + u_SpecularTilt);
    float rimSpecAlign    = dot(normal, specLightDirRim);
    float rimSpecDir      = pow(max(rimSpecAlign, 0.0), 3.0);
    float rimSpecAlpha    = rimSpecBand * rimSpecDir * specIntensity * fillAlpha;
    vec3  rimSpecBackdrop = sampleBackdrop(baseUv,
                              max(0.0, lodBoost - 0.5), frostLod);
    float rimSpecLuma     = dot(rimSpecBackdrop, LUMA);
    vec3  rimSpecVibrant  = clamp(
      mix(vec3(rimSpecLuma), rimSpecBackdrop, 1.8) * 1.4, vec3(0.0), vec3(1.0));
    vec3  rimSpecRgb      = mix(rimSpecVibrant, vec3(1.0), 0.45);
    result = vec4(
      result.rgb * (1.0 - rimSpecAlpha) + rimSpecRgb * rimSpecAlpha,
      result.a   * (1.0 - rimSpecAlpha) + rimSpecAlpha
    );

    // Border zone backdrop refilter
    float borderOuter = smoothstep(-aa, aa, dist);
    float borderInner = smoothstep(-aa, aa, dist + localBorderW);
    float borderBase  = (1.0 - borderOuter) * borderInner;
    if (borderBase > 0.001) {
      float bLod     = max(0.0, lodBoost + v_BorderFilter.w);
      vec3  bSample  = sampleBackdrop(baseUv, bLod, frostLod);
      vec3  borderBackdrop = applyGrading(
        bSample,
        brightness * v_BorderFilter.x,
        saturation * v_BorderFilter.y,
        contrast   * v_BorderFilter.z
      );
      float lightFacingB     = max(alignment, 0.0);
      float alphaFloor       = 1.0 - v_Outline.x;
      float strokeBrightness = mix(alphaFloor, 1.0, pow(lightFacingB, 2.0));
      vec3  strokeTint       = mix(v_BorderColor.rgb, vec3(1.0),
                                   pow(lightFacingB, 3.0) * v_Outline.y);
      vec3  borderRgb        = mix(borderBackdrop, strokeTint,
                                   v_BorderColor.a * strokeBrightness);
      result = vec4(
        mix(result.rgb, borderRgb, borderBase),
        max(result.a, borderBase * fillAlpha)
      );
    }

  } else {
    // Non-glass border
    float borderOuter = smoothstep(-aa, aa, dist);
    float borderInner = smoothstep(-aa, aa, dist + localBorderW);
    float borderBase  = (1.0 - borderOuter) * borderInner;
    float borderAlpha = borderBase * v_BorderColor.a;
    result = vec4(
      result.rgb * (1.0 - borderAlpha) + v_BorderColor.rgb * borderAlpha,
      result.a   * (1.0 - borderAlpha) + borderAlpha
    );
  }

  result = vec4(result.rgb, result.a * opacity);
  fragColor = result;
}
`;

// ─── Progressive blur vertex shader ──────────────────────────────────────────
// Places a unit quad at u_Rect (device px) and emits the varyings PBLUR_FRAG
// needs: v_Local (0..1 across element, y=0 top), v_SampleUv (UV into the
// full-canvas pyramid/scene), v_PixelPos (device px). Single non-instanced quad.

export const PBLUR_VERT: string = /* glsl */`
precision highp float;
in vec3 position;            // unit quad [0,1]
uniform vec2 u_Resolution;
uniform vec4 u_Rect;         // x, y, w, h (device px)
out vec2 v_Local;
out vec2 v_SampleUv;
out vec2 v_PixelPos;
void main() {
  vec2 pos = u_Rect.xy + position.xy * u_Rect.zw;
  vec2 ndc = (pos / u_Resolution) * 2.0 - 1.0;
  ndc.y = -ndc.y;
  gl_Position = vec4(ndc, 0.0, 1.0);
  v_Local    = position.xy;                 // 0..1, y=0 top (matches pos mapping)
  v_PixelPos = pos;
  // Sample UV into the full-canvas pyramid/scene: device px → 0..1, y flipped
  // to match the GL texture orientation of the scene render target.
  v_SampleUv = vec2(pos.x / u_Resolution.x, 1.0 - pos.y / u_Resolution.y);
}
`;

// ─── Progressive blur fragment shader ────────────────────────────────────────
// Port of ProgressiveBlur.wgsl fs_main.

export const PBLUR_FRAG: string = /* glsl */`
precision highp float;

in vec2 v_Local;      // 0..1 across the element; y=0 is top
in vec2 v_SampleUv;   // UV into the blur pyramid / scene
in vec2 v_PixelPos;   // device-pixel position (for clip SDF)

uniform vec2      u_Resolution;
uniform vec4      u_Rect;         // x, y, w, h of this pblur element (device px)
uniform sampler2D u_Scene;        // unblurred scene
uniform sampler2D u_Pyramid;      // mipmapped blur pyramid
uniform float     u_MaxLod;
uniform int       u_Direction;    // 0 ToTop, 1 ToBottom, 2 ToLeft, 3 ToRight
uniform float     u_Feather;      // ramp length in device px (0 = full-element ramp)
uniform float     u_Easing;       // exponent on smoothstep'd ramp
uniform float     u_Opacity;
uniform vec4      u_Background;   // RGBA tint mixed along ramp
uniform vec3      u_Grading;      // brightness, saturation, contrast (1 = identity)
uniform sampler2D u_ClipTex;
uniform ivec2     u_ClipMeta;     // (offset, count)

out vec4 fragColor;

// ─── Clip helpers (pblur: smoothstep edge, matching existing GLSL convention) ─

const int MAX_CLIP_DEPTH = 16;

float pickClipRadiusPb(vec2 p, vec4 radii) {
  if (p.x >= 0.0) return p.y <= 0.0 ? radii.y : radii.z;
  return p.y <= 0.0 ? radii.x : radii.w;
}

float clipShapeDistance(vec2 pixel, vec4 rect, vec4 radii, float smoothness) {
  vec2  center   = rect.xy + rect.zw * 0.5;
  vec2  halfSize = rect.zw * 0.5;
  vec2  qSigned  = pixel - center;
  vec2  qAbs     = abs(qSigned);
  float r        = pickClipRadiusPb(qSigned, radii);
  vec2  cornerP  = qAbs - (halfSize - vec2(r));
  if (r <= 0.0 || cornerP.x <= 0.0 || cornerP.y <= 0.0) {
    return max(qAbs.x - halfSize.x, qAbs.y - halfSize.y);
  }
  float n = 2.0 + 6.0 * clamp(smoothness, 0.0, 1.0);
  float L = pow(cornerP.x / r, n) + pow(cornerP.y / r, n);
  return r * (pow(max(L, 0.0), 1.0 / n) - 1.0);
}

float clipStackDistance(vec2 pixel, int offset, int count) {
  float d = -1e20;
  for (int i = 0; i < MAX_CLIP_DEPTH; i++) {
    if (i >= count) break;
    int  base  = (offset + i) * 3;
    vec4 rect  = texelFetch(u_ClipTex, ivec2(base,     0), 0);
    vec4 radii = texelFetch(u_ClipTex, ivec2(base + 1, 0), 0);
    vec4 meta  = texelFetch(u_ClipTex, ivec2(base + 2, 0), 0);
    d = max(d, clipShapeDistance(pixel, rect, radii, meta.x));
  }
  return d;
}

vec4 clipStackUvAabb(int offset, int count) {
  vec2 uvMin = vec2(0.0);
  vec2 uvMax = vec2(1.0);
  for (int i = 0; i < MAX_CLIP_DEPTH; i++) {
    if (i >= count) break;
    int  base  = (offset + i) * 3;
    vec4 rect  = texelFetch(u_ClipTex, ivec2(base, 0), 0);
    vec2 pxMin = rect.xy;
    vec2 pxMax = rect.xy + rect.zw;
    vec2 cUvMin= vec2(pxMin.x / u_Resolution.x, 1.0 - pxMax.y / u_Resolution.y);
    vec2 cUvMax= vec2(pxMax.x / u_Resolution.x, 1.0 - pxMin.y / u_Resolution.y);
    uvMin = max(uvMin, cUvMin);
    uvMax = min(uvMax, cUvMax);
  }
  return vec4(uvMin, uvMax);
}

void main() {
  float clipD     = clipStackDistance(v_PixelPos, u_ClipMeta.x, u_ClipMeta.y);
  if (clipD > 1.0) discard;
  float clipAlpha = 1.0 - smoothstep(-0.5, 0.5, clipD);

  // Ramp: 0 = clear end, 1 = blurred end
  float t;
  if      (u_Direction == 0) t = 1.0 - v_Local.y;  // ToTop
  else if (u_Direction == 1) t = v_Local.y;         // ToBottom
  else if (u_Direction == 2) t = 1.0 - v_Local.x;  // ToLeft
  else                       t = v_Local.x;         // ToRight

  if (u_Feather > 0.0) {
    float axisLen = (u_Direction == 0 || u_Direction == 1) ? u_Rect.w : u_Rect.z;
    t = clamp(t * axisLen / u_Feather, 0.0, 1.0);
  }

  // Early-out: solid background zone
  if (t >= 1.0 && u_Background.a >= 0.999) {
    fragColor = vec4(u_Background.rgb, u_Opacity * clipAlpha);
    return;
  }

  float ramp = pow(smoothstep(0.0, 1.0, t), u_Easing);

  // UV clamping — prevent mipmap neighborhoods from crossing the clip AABB.
  vec4  clipUv  = clipStackUvAabb(u_ClipMeta.x, u_ClipMeta.y);
  float lod     = ramp * ramp * u_MaxLod;
  vec2  texelUv = exp2(lod) / u_Resolution;
  vec2  uvMin   = clipUv.xy + texelUv * 0.5;
  vec2  uvMax   = clipUv.zw - texelUv * 0.5;
  vec2  safeUv  = clamp(v_SampleUv, min(uvMin, uvMax), max(uvMin, uvMax));

  vec3 sceneRgb = texture(u_Scene, safeUv).rgb;
  vec3 blurRgb  = textureLod(u_Pyramid, safeUv, lod).rgb;

  // Crossfade: unblurred → pyramid over first 20% of ramp
  float blendT = smoothstep(0.0, 0.2, ramp);
  vec3  rgb    = mix(sceneRgb, blurRgb, blendT);

  // Backdrop grading — ramps from identity (clear) to authored (blurred)
  float gr_brightness = mix(1.0, u_Grading.x, ramp);
  float gr_saturation = mix(1.0, u_Grading.y, ramp);
  float gr_contrast   = mix(1.0, u_Grading.z, ramp);
  rgb *= gr_brightness;
  float luma = dot(rgb, vec3(0.299, 0.587, 0.114));
  rgb = mix(vec3(luma), rgb, gr_saturation);
  rgb = (rgb - 0.5) * gr_contrast + 0.5;

  // Background tint — fades in proportional to ramp
  float bgMix = u_Background.a * ramp;
  rgb = mix(rgb, u_Background.rgb, bgMix);

  fragColor = vec4(rgb, u_Opacity * clipAlpha);
}
`;
