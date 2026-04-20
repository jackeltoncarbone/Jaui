// Text rendering — atlas-sampled glyph quads.
//
// Port of Text.Quad.vert + Text.Quad.frag. Each instance is one word/glyph
// with a screen rect, atlas UV rect, and opacity. Reads instance data from
// a storage buffer indexed by instance_index. Also runs the inherited
// clip-stack discard so text is clipped to ancestor overflow boxes.

// Per-frame uniforms
struct TextUniforms {
  resolution: vec2f,
  _pad: vec2f,
}

// Per-instance data: 3 x vec4f = 12 floats (matches TEXT_FLOATS_PER_INSTANCE)
struct TextInstance {
  rect: vec4f,         // screen x, y, w, h (device px)
  uv_rect: vec4f,      // atlas u, v, uW, uH
  opacity_clip: vec4f, // opacity, clipOffset, clipCount, _pad
}

@group(0) @binding(0) var<uniform> uniforms: TextUniforms;
@group(0) @binding(1) var atlas: texture_2d<f32>;
@group(0) @binding(2) var atlas_sampler: sampler;
@group(1) @binding(0) var<storage, read> instances: array<TextInstance>;
// Each clip is 3 vec4s: rect(x,y,w,h), radii(tl,tr,br,bl), meta(smoothness,_,_,_).
// Rect/radii in device pixels; smoothness is unitless (0=circle corners).
@group(2) @binding(0) var<storage, read> clip_stack: array<vec4f>;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) tex_coord: vec2f,
  @location(1) opacity: f32,
  @location(2) pixel_pos: vec2f,
  @location(3) @interpolate(flat) clip_offset: u32,
  @location(4) @interpolate(flat) clip_count: u32,
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
  out.opacity = inst.opacity_clip.x;
  out.pixel_pos = pos;
  out.clip_offset = u32(inst.opacity_clip.y);
  out.clip_count = u32(inst.opacity_clip.z);
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

fn inside_clip_stack(pixel: vec2f, offset: u32, count: u32) -> bool {
  for (var i: u32 = 0u; i < count; i = i + 1u) {
    let base = (offset + i) * 3u;
    if (!inside_clip_shape(pixel, clip_stack[base], clip_stack[base + 1u], clip_stack[base + 2u].x)) {
      return false;
    }
  }
  return true;
}

// Fragment shader — sample atlas, multiply by opacity, discard outside clip.
@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  if (!inside_clip_stack(in.pixel_pos, in.clip_offset, in.clip_count)) {
    discard;
  }
  let texel = textureSample(atlas, atlas_sampler, in.tex_coord);
  return texel * in.opacity;
}
