// Copy (WebGL2) vs New (Three) — real pixel-diff + frame time per corpus scene.
// Both dev servers must be running: copy=5173, new=5174.
// Absolute ms are swiftshader (software) — read them RELATIVELY (copy vs new),
// not as device-truth.
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SCENES = ['FlatPanels', 'Shadows', 'Text', 'Glass', 'Mixed', 'Pblur'];
const COPY = 'http://localhost:5173';
const NEW  = 'http://localhost:5174';
const OUT = resolve(process.cwd(), 'tests/compare-out');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });

async function grab(origin, scene) {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.goto(`${origin}/Corpus/index.html?scene=${scene}`, { waitUntil: 'domcontentloaded' });
  await page.locator('canvas').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1200);
  // frame time samples
  const samples = await page.evaluate(async () => {
    const out = []; let n = 0;
    await new Promise((res) => { const id = setInterval(() => { const v = window.__jaui_framems; if (typeof v === 'number') out.push(v); if (++n >= 30) { clearInterval(id); res(); } }, 50); });
    return out;
  });
  const shot = await page.locator('canvas').first().screenshot({ type: 'png' });
  await page.close();
  const valid = samples.filter((s) => s > 0 && s < 2000).sort((a, b) => a - b);
  const median = valid.length ? valid[Math.floor(valid.length / 2)] : -1;
  return { shot, median };
}

console.log('\n=== Copy (WebGL2) vs New (Three) — parity + frame time ===');
console.log('(ms are swiftshader/software — compare copy↔new, not absolute)\n');
console.log('scene'.padEnd(13) + 'diff%'.padEnd(10) + 'copy ms'.padEnd(10) + 'new ms'.padEnd(10) + 'verdict');
console.log('-'.repeat(55));

for (const scene of SCENES) {
  const c = await grab(COPY, scene);
  const n = await grab(NEW, scene);
  const a = PNG.sync.read(c.shot), b = PNG.sync.read(n.shot);
  let diffPct = -1;
  if (a.width === b.width && a.height === b.height) {
    const diff = new PNG({ width: a.width, height: a.height });
    const changed = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 });
    diffPct = (changed / (a.width * a.height)) * 100;
    writeFileSync(resolve(OUT, `${scene}.diff.png`), PNG.sync.write(diff));
    writeFileSync(resolve(OUT, `${scene}.copy.png`), c.shot);
    writeFileSync(resolve(OUT, `${scene}.new.png`), n.shot);
  }
  const verdict = diffPct < 0 ? 'SIZE-MISMATCH' : diffPct <= 2 ? 'MATCH' : diffPct <= 8 ? 'CLOSE' : 'DIVERGED';
  console.log(
    scene.padEnd(13) +
    (diffPct < 0 ? 'n/a' : diffPct.toFixed(2)).padEnd(10) +
    c.median.toFixed(1).padEnd(10) +
    n.median.toFixed(1).padEnd(10) +
    verdict,
  );
}
console.log('-'.repeat(55));
console.log(`diff images → tests/compare-out/\n`);
await browser.close();
