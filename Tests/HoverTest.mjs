import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
await p.goto('http://localhost:6777/Corpus/Home.html', { waitUntil: 'domcontentloaded' });
await p.locator('canvas').first().waitFor({ state: 'visible', timeout: 10000 }).catch(()=>{});
await p.waitForTimeout(2500);
// Move OFF first, shoot the Shop-nav region; then hover Shop, shoot again; diff.
const clip = { x: 14, y: 178, width: 182, height: 46 };  // Shop nav item area
await p.mouse.move(700, 400); await p.waitForTimeout(400);
const off = await p.screenshot({ clip });
await p.mouse.move(100, 202); await p.waitForTimeout(500);   // hover Shop
const on = await p.screenshot({ clip });
console.log('Shop nav hover changed pixels:', Buffer.compare(off, on) !== 0 ? 'YES (hover feedback works)' : 'NO (no visual response)');
await b.close();
