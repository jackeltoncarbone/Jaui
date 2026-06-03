import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { readFileSync, writeFileSync } from 'node:fs';
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
await p.goto('http://localhost:6777/Corpus/Home.html', { waitUntil: 'domcontentloaded' });
await p.locator('canvas').first().waitFor({ state: 'visible', timeout: 10000 }).catch(()=>{});
await p.waitForTimeout(3000);
const full = await p.screenshot();   // full page, no clip (clip hangs on animation)
writeFileSync('tests/compare-out/home-full.png', full);
// crop the hero area (x 224..1240, y 100..480) from the PNG buffer
const png = PNG.sync.read(full);
const cx=224, cy=100, cw=1016, ch=380;
const out = new PNG({ width: cw, height: ch });
for (let y=0;y<ch;y++) for (let x=0;x<cw;x++){ const s=((cy+y)*png.width+(cx+x))*4, d=(y*cw+x)*4; out.data[d]=png.data[s];out.data[d+1]=png.data[s+1];out.data[d+2]=png.data[s+2];out.data[d+3]=png.data[s+3]; }
writeFileSync('tests/compare-out/hero-crop.png', PNG.sync.write(out));
console.log('saved hero-crop.png');
await b.close();
