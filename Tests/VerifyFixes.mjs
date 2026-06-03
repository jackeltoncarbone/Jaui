// Verify (against the live-source 6777 server):
//  1. glass frost blur — the new BackdropFrostBlur:18 actually reads as a
//     frosted backdrop (shoot the glass scene, eyeball).
//  2. resize never collapses the scene to 0x0 — drive several resizes incl. a
//     tiny one, then assert the canvas backing store stayed > 0 throughout.
import { chromium } from 'playwright';
import { resolve } from 'node:path';

const BASE = 'http://localhost:6777/Corpus';
const OUT = resolve(process.cwd(), 'tests/compare-out');

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });

// ---- 1. glass frost ----
{
  const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
  await page.goto(`${BASE}/index.html?scene=Glass`, { waitUntil: 'domcontentloaded' });
  await page.locator('canvas').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/glass.frost.png`, animations: 'disabled' });
  await page.close();
  console.log('glass frost shot → tests/compare-out/glass.frost.png');
}

// ---- 2. resize stress on the full-window home host ----
{
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/Home.html`, { waitUntil: 'domcontentloaded' });
  await page.locator('canvas').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(2000);

  const sizes = [];
  const sample = async (tag) => {
    const s = await page.evaluate(() => { const c = document.querySelector('canvas'); return { w: c.width, h: c.height }; });
    sizes.push({ tag, ...s });
  };
  await sample('initial');
  // A sequence of resizes, including a momentary very small size (which is the
  // kind of transient that used to push a 0x0 contentRect).
  for (const [w, h, tag] of [[900, 700, 'shrink'], [1, 1, 'tiny'], [1500, 950, 'grow'], [1280, 820, 'settle']]) {
    await page.setViewportSize({ width: Math.max(1, w), height: Math.max(1, h) });
    await page.waitForTimeout(500);
    await sample(tag);
  }
  // Sit idle a while — the bug also manifested "after some time" with no resize.
  await page.waitForTimeout(3000);
  await sample('idle-after');

  await page.screenshot({ path: `${OUT}/home.resized.png`, animations: 'disabled' }).catch((e) => console.log('shot failed:', e.message));
  await page.close();

  console.log('resize samples:');
  for (const s of sizes) console.log(`  ${s.tag.padEnd(12)} ${s.w}x${s.h}`);
  const collapsed = sizes.find((s) => s.w <= 0 || s.h <= 0);
  console.log('collapsed-to-zero:', collapsed ? `YES at ${collapsed.tag}` : 'NO — OK');
  console.log('errors:', errors.length, errors.slice(0, 5).join(' | '));
}

await browser.close();
