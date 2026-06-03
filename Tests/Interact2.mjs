import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const errs=[]; p.on('pageerror',e=>errs.push(e.message)); p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
await p.goto('http://localhost:6777/Corpus/Home.html', { waitUntil: 'domcontentloaded' });
await p.locator('canvas').first().waitFor({ state: 'visible', timeout: 10000 }).catch(()=>{});
await p.waitForTimeout(2500);
const cur = async (x,y) => { await p.mouse.move(x,y); await p.waitForTimeout(150); return p.evaluate(()=>document.querySelector('canvas').style.cursor||'(none)'); };
// nav rail is inset ~16px, items around x=110, y 102/156/210
console.log('cursor nav Home (110,114):', await cur(110,114));
console.log('cursor nav Shop  (110,168):', await cur(110,168));
console.log('cursor card (350,620):', await cur(350,620));
console.log('cursor hero formation (740,250):', await cur(740,250));
console.log('cursor coins (1120,57):', await cur(1120,57));
// drag the hero — does the model rotate? read RotationView yaw if exposed... it's not, so just confirm no throw + frames advance
const f0 = await p.evaluate(()=>window.__jaui_framems);
await p.mouse.move(740,250); await p.mouse.down();
for(let i=1;i<=12;i++){await p.mouse.move(740-i*16,250);await p.waitForTimeout(16);} await p.mouse.up();
await p.waitForTimeout(200);
console.log('hero drag: no throw, frames active=', typeof (await p.evaluate(()=>window.__jaui_framems))==='number');
console.log('errors:', errs.length, errs.slice(0,4).join(' | '));
await b.close();
