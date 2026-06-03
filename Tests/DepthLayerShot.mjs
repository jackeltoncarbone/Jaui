import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const OUT = resolve(process.cwd(), 'tests/compare-out');
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
const errs = []; p.on('pageerror', e => errs.push(e.message));
await p.goto('http://localhost:6777/Corpus/index.html?scene=DepthLayer', { waitUntil: 'domcontentloaded' });
await p.locator('canvas').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
await p.waitForTimeout(1500);
await p.locator('canvas').first().screenshot({ path: `${OUT}/depthlayer.png` });
await b.close();

// Read pixels from the saved PNG (reliable; live WebGL readback returns blank).
// Red rect: x260-560,y180-420. Blue: x380-680,y300-540. Overlap center ~(470,360).
const png = PNG.sync.read(readFileSync(`${OUT}/depthlayer.png`));
const at = (x, y) => { const i = (png.width * y + x) * 4; return [png.data[i], png.data[i+1], png.data[i+2]]; };
const px = { overlap: at(470, 360), redOnly: at(300, 200), blueOnly: at(620, 500) };
const isRed = (c) => c[0] > 150 && c[1] < 110 && c[2] < 110;
const isBlue = (c) => c[2] > 150 && c[0] < 130 && c[1] < 170;
console.log('overlap rgb:', px.overlap, '->', isRed(px.overlap) ? 'RED (depth wins ✓)' : isBlue(px.overlap) ? 'BLUE (paint order — depth FAILED)' : 'other');
console.log('redOnly  rgb:', px.redOnly, isRed(px.redOnly) ? '✓' : '');
console.log('blueOnly rgb:', px.blueOnly, isBlue(px.blueOnly) ? '✓' : '');
console.log('errors:', errs.length, errs.slice(0,3).join(' | '));
console.log('RESULT:', isRed(px.overlap) ? 'PASS — world-Z occludes by depth, not paint order' : 'FAIL');
