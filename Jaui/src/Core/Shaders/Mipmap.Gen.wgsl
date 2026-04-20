// Mipmap generation — compute shader that reads mip level N and writes N+1.
//
// WebGPU has no gl.generateMipmap() equivalent. This shader is dispatched
// once per mip level, each time halving the resolution with a box filter.
// Used after the blur upsample chain to build the LOD chain that the glass
// shader (textureSampleLevel) and progressive blur shader need.

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var src_sampler: sampler;
@group(0) @binding(2) var dst: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let dst_size = textureDimensions(dst);
    if (gid.x >= dst_size.x || gid.y >= dst_size.y) { return; }

    // Sample the source at the center of the 2×2 block this destination
    // pixel covers. Linear filtering gives us the box-filter average.
    let uv = (vec2f(gid.xy) + 0.5) / vec2f(dst_size);
    let color = textureSampleLevel(src, src_sampler, uv, 0.0);

    textureStore(dst, gid.xy, color);
}
