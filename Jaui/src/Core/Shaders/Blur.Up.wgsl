// Dual-filter upsample — compute shader port of BlurPass.ts UP_FRAG.
//
// 8-tap tent kernel: 4 axis-aligned taps (weight 1) + 4 diagonal taps (weight 2).
// Reads from source texture at half resolution, writes to storage texture at
// double resolution. Each thread writes one pixel of the destination.
//
// Reference: Marius Bjørge, ARM, "Bandwidth-Efficient Rendering", SIGGRAPH 2015.

struct BlurParams {
  half_pixel: vec2f,
  tap_offset: f32,
  _pad: f32,
}

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var src_sampler: sampler;
@group(0) @binding(2) var dst: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(3) var<uniform> params: BlurParams;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let dst_size = textureDimensions(dst);
    if (gid.x >= dst_size.x || gid.y >= dst_size.y) { return; }

    let uv = (vec2f(gid.xy) + 0.5) / vec2f(dst_size);
    let hp = params.half_pixel * params.tap_offset;

    // 8-tap tent: axis-aligned (weight 1) + diagonal (weight 2). Sum / 12.
    var sum  = textureSampleLevel(src, src_sampler, uv + vec2f(-hp.x * 2.0, 0.0), 0.0).rgb;
    sum += textureSampleLevel(src, src_sampler, uv + vec2f(-hp.x,  hp.y), 0.0).rgb * 2.0;
    sum += textureSampleLevel(src, src_sampler, uv + vec2f( 0.0,   hp.y * 2.0), 0.0).rgb;
    sum += textureSampleLevel(src, src_sampler, uv + vec2f( hp.x,  hp.y), 0.0).rgb * 2.0;
    sum += textureSampleLevel(src, src_sampler, uv + vec2f( hp.x * 2.0, 0.0), 0.0).rgb;
    sum += textureSampleLevel(src, src_sampler, uv + vec2f( hp.x, -hp.y), 0.0).rgb * 2.0;
    sum += textureSampleLevel(src, src_sampler, uv + vec2f( 0.0,  -hp.y * 2.0), 0.0).rgb;
    sum += textureSampleLevel(src, src_sampler, uv + vec2f(-hp.x, -hp.y), 0.0).rgb * 2.0;

    textureStore(dst, gid.xy, vec4f(sum / 12.0, 1.0));
}
