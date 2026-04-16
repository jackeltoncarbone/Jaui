// Text rendering — atlas-sampled glyph quads.
//
// Port of Text.Quad.vert + Text.Quad.frag. Each instance is one word/glyph
// with a screen rect, atlas UV rect, and opacity. Reads instance data from
// a storage buffer indexed by instance_index.

// Per-frame uniforms
struct TextUniforms {
  resolution: vec2f,
  _pad: vec2f,
}

// Per-instance data: 3 x vec4f = 12 floats (matches TEXT_FLOATS_PER_INSTANCE)
struct TextInstance {
  rect: vec4f,         // screen x, y, w, h (device px)
  uv_rect: vec4f,      // atlas u, v, uW, uH
  opacity_pad: vec4f,  // opacity, pad, pad, pad
}

@group(0) @binding(0) var<uniform> uniforms: TextUniforms;
@group(0) @binding(1) var atlas: texture_2d<f32>;
@group(0) @binding(2) var atlas_sampler: sampler;
@group(1) @binding(0) var<storage, read> instances: array<TextInstance>;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) tex_coord: vec2f,
  @location(1) opacity: f32,
}

// Vertex shader — unit quad [0,1] expanded to instance screen rect
@vertex
fn vs_main(
  @location(0) a_position: vec2f,
  @builtin(instance_index) instance_id: u32,
) -> VertexOutput {
  let inst = instances[instance_id];

  let pos = inst.rect.xy + a_position * inst.rect.zw;
  let tex_coord = inst.uv_rect.xy + a_position * inst.uv_rect.zw;

  // Screen → clip space, Y-flipped (top = +1 in screen, -1 in clip)
  var clip = (pos / uniforms.resolution) * 2.0 - 1.0;
  clip.y = -clip.y;

  var out: VertexOutput;
  out.position = vec4f(clip, 0.0, 1.0);
  out.tex_coord = tex_coord;
  out.opacity = inst.opacity_pad.x;
  return out;
}

// Fragment shader — sample atlas, multiply by opacity
@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  let texel = textureSample(atlas, atlas_sampler, in.tex_coord);
  return texel * in.opacity;
}
