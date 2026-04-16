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
}

@group(0) @binding(0) var<uniform> uniforms: ProgressiveBlurUniforms;
@group(0) @binding(1) var scene: texture_2d<f32>;
@group(0) @binding(2) var scene_sampler: sampler;
@group(0) @binding(3) var pyramid: texture_2d<f32>;
@group(0) @binding(4) var pyramid_sampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) local: vec2f,       // 0..1 across the Jiv; y=0 is top
  @location(1) sample_uv: vec2f,   // UV into the blur pyramid / scene
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
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
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
