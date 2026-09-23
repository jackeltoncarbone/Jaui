import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * AN IMAGE FADES IN ONLY AFTER A WAIT THE NODE ACTUALLY SHOWED.
 *
 * The fade from the placeholder color hides a texture arriving late. A node whose texture was already
 * resident never painted that placeholder, so fading it in anyway takes the picture on screen to the flat
 * placeholder in one frame and climbs back over 260ms. Measured on the home hero (dev, 2026-09-23): a
 * dissolve revealing a freshly assigned layer went 101 -> 0.3 luma in one frame, and every card swapping
 * `[image]` to a cached picture flashed the same way.
 */
const JAUI = readFileSync(join(__dirname, '../src/Core/Jaui.ts'), 'utf8').replace(/\r\n/g, '\n');

describe('image fade-in > only what the node waited for', () => {
  it('a texture in flight records the URL the placeholder is standing in for', () => {
    expect(JAUI).toContain(`        node.BgImageFadeUrl = null;
        node.BgImageWaitUrl = bg.Url;
        return undefined;`);
  });

  it('first sight of a Ready texture fades only if this node waited for THAT url; otherwise alpha 1 now', () => {
    expect(JAUI).toContain(`      if (node.BgImageFadeUrl !== bg.Url) {
        node.BgImageFadeUrl = bg.Url;
        node.BgImageFadeStartMs = node.BgImageWaitUrl === bg.Url ? now : now - Canvas._BG_IMAGE_FADE_MS;
        node.BgImageWaitUrl = null;
      }`);
  });

  it('the occlusion pre-pass reads the same clock, so a resident photo covers from its first frame', () => {
    expect(JAUI).toContain('return performance.now() - node.BgImageFadeStartMs >= Canvas._BG_IMAGE_FADE_MS;');
  });
});
