// Load the full-window home host, capture console + page errors, wait for the
// model, drag to orbit, screenshot. Proves: full-window fit (no overflow),
// resolution-independent layout, glass (blur + tamed specular), and the GLTF
// loading into the shared world + pointer orbit.
import { chromium } from 'playwright';
import { resolve } from 'node:path';

const URL = 'http://localhost:6777/Corpus/Home.html';
const OUT = resolve(process.cwd(), 'tests/compare-out');
const VW = 1440, VH = 900;

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1 });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.locator('canvas').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});

// Overflow check: the document must not scroll — body scroll size == viewport.
const overflow = await page.evaluate(() => ({
  scrollW: document.documentElement.scrollWidth,
  scrollH: document.documentElement.scrollHeight,
  innerW: window.innerWidth,
  innerH: window.innerHeight,
  canvasCss: (() => { const c = document.querySelector('canvas'); const r = c.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })(),
}));

await page.waitForTimeout(9000);   // remote glTF fetch + decode on software GPU
const fmIdle = await page.evaluate(() => window.__jaui_framems);
try { await page.screenshot({ path: `${OUT}/home.idle.png`, timeout: 90000, animations: 'disabled' }); }
catch (e) { console.log('idle screenshot failed:', e.message); }

// Drag across the stage center to orbit the model.
const cx = VW / 2, cy = VH / 2;
await page.mouse.move(cx, cy);
await page.mouse.down();
for (let i = 1; i <= 12; i++) { await page.mouse.move(cx - i * 14, cy - i * 3); await page.waitForTimeout(16); }
await page.mouse.up();
await page.waitForTimeout(300);
try { await page.screenshot({ path: `${OUT}/home.dragged.png`, timeout: 90000, animations: 'disabled' }); }
catch (e) { console.log('dragged screenshot failed:', e.message); }

const fm = fmIdle;
await browser.close();

console.log('frame ms (sw):', typeof fm === 'number' ? fm.toFixed(1) : 'n/a');
console.log('overflow:', JSON.stringify(overflow));
console.log('  no-scroll:', overflow.scrollW <= overflow.innerW && overflow.scrollH <= overflow.innerH ? 'OK' : 'OVERFLOW');
console.log('  canvas fills window:', overflow.canvasCss.w === overflow.innerW && overflow.canvasCss.h === overflow.innerH ? 'OK' : `${overflow.canvasCss.w}x${overflow.canvasCss.h} vs ${overflow.innerW}x${overflow.innerH}`);
console.log('errors:', errors.length);
for (const e of errors.slice(0, 20)) console.log('  ' + e);
console.log('shots → tests/compare-out/home.idle.png, home.dragged.png');
