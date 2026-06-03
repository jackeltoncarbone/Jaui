// Perf probe for the new (Three.js) renderer. Measures steady-state frame time
// per corpus scene + the JS bundle size. NOTE: headless uses swiftshader unless
// a real GPU is exposed — pass --gpu to attempt hardware (chromium may still
// fall back). Treat absolute ms as relative across scenes, not device-truth.
import { chromium } from 'playwright';

const USE_GPU = process.argv.includes('--gpu');
const SCENES = ['FlatPanels', 'Shadows', 'Text', 'Glass', 'Mixed'];
const ORIGIN = 'http://localhost:5174';

const args = USE_GPU
  ? ['--ignore-gpu-blocklist', '--enable-gpu-rasterization']
  : ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'];

const browser = await chromium.launch({ args });

async function measureScene(scene) {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.goto(`${ORIGIN}/Corpus/index.html?scene=${scene}`, { waitUntil: 'domcontentloaded' });
  await page.locator('canvas').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(800); // settle

  // Sample window.__jaui_framems (EMA frame duration the corpus exposes) over 2s.
  const samples = await page.evaluate(async () => {
    const out = [];
    const read = () => (window).__jaui_framems;
    await new Promise((res) => {
      let n = 0;
      const id = setInterval(() => {
        const v = read();
        if (typeof v === 'number') out.push(v);
        if (++n >= 40) { clearInterval(id); res(); }
      }, 50);
    });
    return out;
  });
  await page.close();

  const valid = samples.filter((s) => s > 0 && s < 1000);
  valid.sort((a, b) => a - b);
  const median = valid.length ? valid[Math.floor(valid.length / 2)] : -1;
  const mean = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : -1;
  return { scene, median, mean, samples: valid.length };
}

async function bundleKb() {
  const page = await browser.newPage();
  let total = 0;
  page.on('response', (r) => {
    const url = r.url();
    if (url.startsWith(ORIGIN) && (url.includes('.ts') || url.includes('.js')) && !url.includes('node_modules')) {
      const len = parseInt(r.headers()['content-length'] ?? '0', 10);
      if (len) total += len;
    }
  });
  try { await page.goto(`${ORIGIN}/Corpus/index.html?scene=Mixed`, { waitUntil: 'networkidle', timeout: 15000 }); } catch {}
  await page.close();
  return Math.round(total / 1024 * 10) / 10;
}

console.log(`\n=== Three renderer perf (${USE_GPU ? 'GPU-attempt' : 'swiftshader'}) ===\n`);
console.log('scene'.padEnd(14) + 'median ms'.padEnd(12) + 'mean ms'.padEnd(12) + 'samples');
console.log('-'.repeat(46));
for (const s of SCENES) {
  const r = await measureScene(s);
  console.log(s.padEnd(14) + r.median.toFixed(2).padEnd(12) + r.mean.toFixed(2).padEnd(12) + r.samples);
}
const kb = await bundleKb();
console.log('-'.repeat(46));
console.log(`source JS served (unminified, dev): ${kb} KB`);
await browser.close();
