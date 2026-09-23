// Mipmap generation — compute shader that reads mip level N and writes N+1.
//
// WebGPU has no gl.generateMipmap() equivalent. This shader is dispatched
// once per mip level. Used after the blur upsample chain to build the LOD
// chain that the glass shader (textureSampleLevel) and progressive blur
// shader need. Port of BlurPass.ts MIP_FRAG: four bilinear taps at +-0.75
// source texel on both axes, a separable [1 3 3 1] / 8 binomial, where a
// 2x2 box leaves blocks that boil under scroll.

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var src_sampler: sampler;
@group(0) @binding(2) var dst: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let dst_size = textureDimensions(dst);
    if (gid.x >= dst_size.x || gid.y >= dst_size.y) { return; }

    let uv = (vec2f(gid.xy) + 0.5) / vec2f(dst_size);
    let hp = 0.75 / vec2f(textureDimensions(src));
    let color = (textureSampleLevel(src, src_sampler, uv - hp, 0.0)
        + textureSampleLevel(src, src_sampler, uv + hp, 0.0)
        + textureSampleLevel(src, src_sampler, uv + vec2f(hp.x, -hp.y), 0.0)
        + textureSampleLevel(src, src_sampler, uv - vec2f(hp.x, -hp.y), 0.0)) * 0.25;

    textureStore(dst, gid.xy, color);
}
