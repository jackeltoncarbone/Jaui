import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { writeFileSync } from 'node:fs';
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
await p.goto('http://localhost:6777/Corpus/Home.html', { waitUntil: 'domcontentloaded' });
await p.locator('canvas').first().waitFor({ state: 'visible', timeout: 10000 }).catch(()=>{});
await p.waitForTimeout(2500);
const full = await p.screenshot();
const png = PNG.sync.read(full);
// brighten + sample the nav region (top-left 230x300) — report max luminance to see if anything's there
let maxL=0, sum=0, n=0;
for (let y=20;y<320;y++) for (let x=10;x<224;x++){ const s=(y*png.width+x)*4; const l=png.data[s]+png.data[s+1]+png.data[s+2]; maxL=Math.max(maxL,l); sum+=l; n++; }
console.log('nav region: maxLuminance(0-765)='+maxL+' avg='+(sum/n).toFixed(1));
// crop + amplify so I can see faint content
const cw=224, ch=320, out=new PNG({width:cw,height:ch});
for(let y=0;y<ch;y++)for(let x=0;x<cw;x++){const s=((20+y)*png.width+(10+x))*4,d=(y*cw+x)*4; out.data[d]=Math.min(255,png.data[s]*3);out.data[d+1]=Math.min(255,png.data[s+1]*3);out.data[d+2]=Math.min(255,png.data[s+2]*3);out.data[d+3]=255;}
writeFileSync('tests/compare-out/nav-amp.png', PNG.sync.write(out));
console.log('saved nav-amp.png (3x brightened)');
await b.close();
