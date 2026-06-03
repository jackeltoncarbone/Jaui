import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const errs=[]; p.on('pageerror',e=>errs.push(e.message)); p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
await p.goto('http://localhost:6777/Corpus/Home.html', { waitUntil: 'domcontentloaded' });
await p.locator('canvas').first().waitFor({ state: 'visible', timeout: 10000 }).catch(()=>{});
await p.waitForTimeout(2500);
// cursor over where nav SHOULD be — if pointer, nav is laid out (just not painting)
const cur = async (x,y) => { await p.mouse.move(x,y); await p.waitForTimeout(120); return p.evaluate(()=>document.querySelector('canvas').style.cursor||'(none)'); };
console.log('cursor nav area (90,110):', await cur(90,110));
console.log('cursor card area (350,620):', await cur(350,620));
console.log('cursor topbar coins (1120,57):', await cur(1120,57));
console.log('errors:', errs.length, errs.slice(0,5).join(' | '));
await b.close();
