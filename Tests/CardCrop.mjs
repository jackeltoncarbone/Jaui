import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { writeFileSync } from 'node:fs';
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
await p.goto('http://localhost:6777/Corpus/Home.html', { waitUntil: 'domcontentloaded' });
await p.locator('canvas').first().waitFor({ state: 'visible', timeout: 10000 }).catch(()=>{});
await p.waitForTimeout(3000);
const full = await p.screenshot();
const png = PNG.sync.read(full);
// crop the first trending card (Neon Cadence) ~ x230..480, y545..700
const cx=224, cy=540, cw=270, ch=200;
const out = new PNG({ width: cw, height: ch });
for (let y=0;y<ch;y++) for (let x=0;x<cw;x++){ const s=((cy+y)*png.width+(cx+x))*4, d=(y*cw+x)*4; out.data[d]=png.data[s];out.data[d+1]=png.data[s+1];out.data[d+2]=png.data[s+2];out.data[d+3]=png.data[s+3]; }
writeFileSync('tests/compare-out/card-crop.png', PNG.sync.write(out));
// Measure: at the top edge, find where the card's top-left corner pixel becomes non-background, scanning down the left column vs across the top row.
console.log('saved card-crop.png');
await b.close();
