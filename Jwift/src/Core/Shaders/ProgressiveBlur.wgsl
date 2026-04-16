// Progressive blur — per-pixel continuously-variable Gaussian blur.
//
// Port of ProgressiveBlur.Shader.ts inline GLSL. Draws a quad over the
// composited scene and samples a mipmapped blur pyramid at a ramp-driven LOD.
// The pyramid is the same one built for glass panels.
//
// Ramp: 0.0 = unblurred scene (clear end), 1.0 = pyramid at max_lod (heaviest blur).
// Direction: "ToX" = blurred AT X, clear at the opposite edge.

struct ProgressiveBlurUniforms {
  resolution: vec2f,        // canvas w/h, device px
  rect: vec4f,              // x, y, w, h in device px (y = top)
  max_lod: f32,
  direction: i32,           // 0=ToTop, 1=ToBottom, 2=ToLeft, 3=ToRight
  opacity: f32,
  _pad0: f32,
  background: vec4f,        // RGBA tint mixed in along the ramp
  grading: vec3f,           // brightness, saturation, contrast (1 = identity)
  _pad1: f32,
  clip_meta: vec4f,         // clipOffset, clipCount, _pad, _pad
}

@group(0) @binding(0) var<uniform> uniforms: ProgressiveBlurUniforms;
@group(0) @binding(1) var scene: texture_2d<f32>;
@group(0) @binding(2) var scene_sampler: sampler;
@group(0) @binding(3) var pyramid: texture_2d<f32>;
@group(0) @binding(4) var pyramid_sampler: sampler;
// Each clip is 3 vec4s: rect(x,y,w,h), radii(tl,tr,br,bl), meta(smoothness,_,_,_).
@group(1) @binding(0) var<storage, read> clip_stack: array<vec4f>;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) local: vec2f,       // 0..1 across the Jiv; y=0 is top
  @location(1) sample_uv: vec2f,   // UV into the blur pyramid / scene
  @location(2) pixel_pos: vec2f,   // fragment position in device pixels
}

@vertex
fn vs_main(@location(0) a_position: vec2f) -> VertexOutput {
  let local = a_position;
  let pixel = uniforms.rect.xy + a_position * uniforms.rect.zw;
  let sample_uv = vec2f(pixel.x / uniforms.resolution.x, 1.0 - pixel.y / uniforms.resolution.y);

  var clip = (pixel / uniforms.resolution) * 2.0 - 1.0;
  clip.y = -clip.y;

  var out: VertexOutput;
  out.position = vec4f(clip, 0.0, 1.0);
  out.local = local;
  out.sample_uv = sample_uv;
  out.pixel_pos = pixel;
  return out;
}

fn pick_rect_radius(p: vec2f, radii: vec4f) -> f32 {
  if (p.x >= 0.0) {
    return select(radii.z, radii.y, p.y <= 0.0);
  }
  return select(radii.w, radii.x, p.y <= 0.0);
}

fn inside_clip_shape(pixel: vec2f, rect: vec4f, radii: vec4f, smoothness: f32) -> bool {
  let center = rect.xy + rect.zw * 0.5;
  let half_size = rect.zw * 0.5;
  let q_signed = pixel - center;
  let q_abs = abs(q_signed);
  if (q_abs.x > half_size.x || q_abs.y > half_size.y) { return false; }
  let r = pick_rect_radius(q_signed, radii);
  let corner_p = q_abs - (half_size - vec2f(r, r));
  if (r <= 0.0 || corner_p.x <= 0.0 || corner_p.y <= 0.0) { return true; }
  let n = 2.0 + 6.0 * clamp(smoothness, 0.0, 1.0);
  let L = pow(corner_p.x / r, n) + pow(corner_p.y / r, n);
  return L <= 1.0;
}

fn inside_clip_stack(pixel: vec2f, clip_meta: vec4f) -> bool {
  let offset = u32(clip_meta.x);
  let count = u32(clip_meta.y);
  for (var i: u32 = 0u; i < count; i = i + 1u) {
    let base = (offset + i) * 3u;
    if (!inside_clip_shape(pixel, clip_stack[base], clip_stack[base + 1u], clip_stack[base + 2u].x)) {
      return false;
    }
  }
  return true;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  if (!inside_clip_stack(in.pixel_pos, uniforms.clip_meta)) {
    discard;
  }

  // t = 0 at clear end → 1 at blurred end
  var t: f32;
  if (uniforms.direction == 0)      { t = 1.0 - in.local.y; }  // ToTop
  else if (uniforms.direction == 1) { t = in.local.y; }         // ToBottom
  else if (uniforms.direction == 2) { t = 1.0 - in.local.x; }  // ToLeft
  else                              { t = in.local.x; }         // ToRight

  let ramp = smoothstep(0.0, 1.0, t);

  let scene_rgb = textureSample(scene, scene_sampler, in.sample_uv).rgb;

  // Quadratic LOD curve — each mipmap LOD doubles sigma, so squaring makes
  // perceived blur increase feel linear.
  let lod = ramp * ramp * uniforms.max_lod;
  let blur_rgb = textureSampleLevel(pyramid, pyramid_sampler, in.sample_uv, lod).rgb;

  // Gradual crossfade from unblurred scene into pyramid over first 20%.
  let blend_t = smoothstep(0.0, 0.2, ramp);
  var rgb = mix(scene_rgb, blur_rgb, blend_t);

  // Backdrop grading — ramps from identity (clear end) to authored value (blurred end).
  let brightness = mix(1.0, uniforms.grading.x, ramp);
  let saturation = mix(1.0, uniforms.grading.y, ramp);
  let contrast = mix(1.0, uniforms.grading.z, ramp);
  rgb *= brightness;
  let luma = dot(rgb, vec3f(0.299, 0.587, 0.114));
  rgb = mix(vec3f(luma), rgb, saturation);
  rgb = (rgb - 0.5) * contrast + 0.5;

  // Background tint — mixed in proportional to ramp so clear end shows none.
  let bg_mix = uniforms.background.a * ramp;
  rgb = mix(rgb, uniforms.background.rgb, bg_mix);

  return vec4f(rgb, uniforms.opacity);
}
