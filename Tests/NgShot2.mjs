import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const errs=[]; p.on('pageerror',e=>errs.push(e.message)); p.on('console',m=>{const t=m.text(); if(m.type()==='error'||/worker|canvas|jaui|boot/i.test(t)) errs.push(m.type()+': '+t);});
await p.goto('http://localhost:6777/', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(12000);   // generous for worker boot + JSS + remote images
// inspect the canvas backing store + whether a <jaui> host exists
const info = await p.evaluate(() => {
  const c = document.querySelector('canvas');
  const jaui = document.querySelector('jaui');
  return { hasCanvas: !!c, w: c?.width, h: c?.height, jauiBox: jaui ? jaui.getBoundingClientRect().width+'x'+jaui.getBoundingClientRect().height : 'none' };
});
await p.screenshot({ path: 'tests/compare-out/ng-home.png' });
console.log('canvas:', JSON.stringify(info));
console.log('log/err lines:', errs.length); errs.slice(0,10).forEach(e=>console.log('  '+e.slice(0,120)));
await b.close();
