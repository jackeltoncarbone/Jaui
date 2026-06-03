import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const all=[];
p.on('console',m=>all.push('PAGE '+m.type()+': '+m.text().slice(0,160)));
p.on('worker', w => { w.on('console', m => all.push('WORKER '+m.type()+': '+m.text().slice(0,160))); });
p.on('pageerror',e=>all.push('PAGEERR: '+e.message.split('\n')[0]));
await p.goto('http://localhost:6777/', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(9000);
// is the canvas actually all-black? sample center pixels via a 2d copy
const px = await p.evaluate(() => {
  const c=document.querySelector('canvas'); const t=document.createElement('canvas'); t.width=c.width;t.height=c.height;
  try{ t.getContext('2d').drawImage(c,0,0); const d=t.getContext('2d').getImageData(640,400,1,1).data; return [d[0],d[1],d[2]]; }catch(e){ return 'readfail:'+e.message; }
});
console.log('center pixel:', JSON.stringify(px));
console.log('=== console (worker+page), last 18 ===');
all.slice(-18).forEach(l=>console.log('  '+l));
await b.close();
