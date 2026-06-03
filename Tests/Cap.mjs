import { chromium } from 'playwright';
import { resolve } from 'node:path';
const OUT = resolve(process.cwd(), 'tests/compare-out');
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
await p.goto('http://localhost:6777/Corpus/Home.html', { waitUntil: 'domcontentloaded' });
await p.locator('canvas').first().waitFor({ state: 'visible', timeout: 10000 }).catch(()=>{});
await p.waitForTimeout(4000);
await p.screenshot({ path: `${OUT}/home.png` });   // plain, no animations-disable
console.log('saved home.png; errors:', errs.length, errs.slice(0,3).join(' | '));
await b.close();
