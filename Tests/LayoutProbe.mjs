import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
await p.goto('http://localhost:6777/Corpus/Home.html', { waitUntil: 'domcontentloaded' });
await p.locator('canvas').first().waitFor({ state: 'visible', timeout: 10000 }).catch(()=>{});
await p.waitForTimeout(2500);
const r = await p.evaluate(() => ({ attached: !!window.__stageAttached, rect: window.__stageRect ?? 'Update not called' }));
await b.close();
console.log('attached:', r.attached, '| rect:', r.rect);
