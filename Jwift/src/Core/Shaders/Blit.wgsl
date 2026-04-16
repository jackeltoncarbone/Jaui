// Fullscreen textured-quad blit.
//
// Port of Blit.ts inline GLSL. Renders a source texture onto the current
// render target. Used to copy the scene FBO to the screen.

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var src_sampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

// Vertex shader — unit quad [0,1] to fullscreen clip space
@vertex
fn vs_main(@location(0) a_position: vec2f) -> VertexOutput {
  // UV passes through as-is so top-of-scene maps to top-of-display.
  var out: VertexOutput;
  out.uv = a_position;
  let clip = a_position * 2.0 - 1.0;
  out.position = vec4f(clip, 0.0, 1.0);
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  return textureSample(src, src_sampler, in.uv);
}
