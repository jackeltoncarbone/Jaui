// Dual-filter downsample — compute shader port of BlurPass.ts DOWN_FRAG.
//
// 5-tap kernel: center (weight 4) + 4 diagonal half-pixel offsets (weight 1 each).
// Reads from source texture at full resolution, writes to storage texture at
// half resolution. Each thread writes one pixel of the destination.
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

    // UV at the center of this destination pixel, mapped to source coordinates.
    let uv = (vec2f(gid.xy) + 0.5) / vec2f(dst_size);
    let hp = params.half_pixel * params.tap_offset;

    // Center tap weighted 4×, four diagonal taps weighted 1× each. Sum / 8.
    var sum = textureSampleLevel(src, src_sampler, uv, 0.0).rgb * 4.0;
    sum += textureSampleLevel(src, src_sampler, uv - hp, 0.0).rgb;
    sum += textureSampleLevel(src, src_sampler, uv + hp, 0.0).rgb;
    sum += textureSampleLevel(src, src_sampler, uv + vec2f(hp.x, -hp.y), 0.0).rgb;
    sum += textureSampleLevel(src, src_sampler, uv - vec2f(hp.x, -hp.y), 0.0).rgb;

    textureStore(dst, gid.xy, vec4f(sum / 8.0, 1.0));
}
