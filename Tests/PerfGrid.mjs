// Performance grid: OLD (WebGL2 copy, :5173) vs NEW (Three, :5174), per scene.
// Measures median frame time over a settled window (window.__jaui_framems EMA).
// NOTE: this sandbox has NO GPU (software rasterizer), so absolute ms are NOT
// device-truth — read the COPY vs NEW columns RELATIVELY (same software workload
// both sides). The Ratio column is the meaningful figure: NEW / OLD.
import { chromium } from 'playwright';

const SCENES = ['FlatPanels', 'Shadows', 'Text', 'Glass', 'Mixed', 'Pblur'];
const COPY = 'http://localhost:5173';
const NEW  = 'http://localhost:5174';
const SAMPLES = 60;     // EMA reads over ~3s after settle
const SETTLE = 1200;

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });

async function measure(origin, scene) {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.goto(`${origin}/Corpus/index.html?scene=${scene}`, { waitUntil: 'domcontentloaded' });
  await page.locator('canvas').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(SETTLE);
  const samples = await page.evaluate(async (n) => {
    const out = []; let i = 0;
    await new Promise((res) => {
      const id = setInterval(() => {
        const v = window.__jaui_framems;
        if (typeof v === 'number') out.push(v);
        if (++i >= n) { clearInterval(id); res(); }
      }, 50);
    });
    return out;
  }, SAMPLES);
  await page.close();
  const v = samples.filter((s) => s > 0 && s < 5000).sort((a, b) => a - b);
  if (!v.length) return { median: -1, p95: -1 };
  return { median: v[Math.floor(v.length / 2)], p95: v[Math.floor(v.length * 0.95)] };
}

const rows = [];
for (const scene of SCENES) {
  const o = await measure(COPY, scene);
  const n = await measure(NEW, scene);
  rows.push({ scene, oldMs: o.median, oldP95: o.p95, newMs: n.median, newP95: n.p95 });
}
await browser.close();

const pad = (s, w) => String(s).padEnd(w);
const padN = (s, w) => String(s).padStart(w);
console.log('\n=== Frame time: OLD (WebGL2) vs NEW (Three) — SOFTWARE rasterizer, ms ===');
console.log('(no GPU in this env; absolute ms are NOT device-truth — read OLD vs NEW relatively)\n');
console.log(pad('scene', 14) + padN('OLD med', 9) + padN('OLD p95', 9) + padN('NEW med', 9) + padN('NEW p95', 9) + padN('Ratio', 9));
console.log('-'.repeat(59));
let sumRatio = 0, nRatio = 0;
for (const r of rows) {
  const ratio = (r.oldMs > 0 && r.newMs > 0) ? r.newMs / r.oldMs : -1;
  if (ratio > 0) { sumRatio += ratio; nRatio++; }
  console.log(
    pad(r.scene, 14) +
    padN(r.oldMs.toFixed(1), 9) + padN(r.oldP95.toFixed(1), 9) +
    padN(r.newMs.toFixed(1), 9) + padN(r.newP95.toFixed(1), 9) +
    padN(ratio > 0 ? ratio.toFixed(2) + 'x' : 'n/a', 9),
  );
}
console.log('-'.repeat(59));
console.log(pad('AVERAGE', 14 + 9 + 9 + 9 + 9) + padN((sumRatio / Math.max(nRatio, 1)).toFixed(2) + 'x', 9));
