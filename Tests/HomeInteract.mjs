import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const errs=[]; p.on('pageerror',e=>errs.push(e.message)); p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
await p.goto('http://localhost:6777/Corpus/Home.html', { waitUntil: 'domcontentloaded' });
await p.locator('canvas').first().waitFor({ state: 'visible', timeout: 10000 }).catch(()=>{});
await p.waitForTimeout(2500);
const out = [];
const cur = () => p.evaluate(() => document.querySelector('canvas').style.cursor || '(none)');
const at = async (x,y,label) => { await p.mouse.move(x,y); await p.waitForTimeout(150); out.push(`cursor ${label} (${x},${y}): ${await cur()}`); };
await at(100,102,'Home nav');
await at(100,202,'Shop nav');
await at(1120,52,'coins');
await at(760,400,'empty');
// Drag hero: read whether the canvas re-rendered by sampling __jaui_framems
// presence + just confirm no throw. Also test a nav CLICK fires (instrument window).
await p.evaluate(() => { window.__navClicks = 0; });
// click Home nav twice
await p.mouse.click(100,102); await p.waitForTimeout(100);
await p.mouse.click(100,202); await p.waitForTimeout(100);
// drag over hero
await p.mouse.move(760,220); await p.mouse.down();
for (let i=1;i<=12;i++){ await p.mouse.move(760-i*18,220); await p.waitForTimeout(16); }
await p.mouse.up();
out.push('drag completed without throw');
out.push('errors: ' + errs.length + ' ' + errs.slice(0,4).join(' | '));
console.log(out.join('\n'));
await b.close();
