// Drive real clicks/hover on the Solid + Glass buttons; assert the engine's
// hit-test + OnClick fire (proving interaction works at the engine level).
import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
const errs = []; p.on('pageerror', e => errs.push(e.message));
await p.goto('http://localhost:6777/Corpus/index.html?scene=ClickTest', { waitUntil: 'domcontentloaded' });
await p.locator('canvas').first().waitFor({ state: 'visible', timeout: 10000 }).catch(()=>{});
await p.waitForTimeout(1000);

// Discover each button's location by hover-sweep (robust — no coordinate
// guessing). Find a point that hovers each label, then click there.
const findPoint = async (label) => {
  for (let x = 180; x <= 620; x += 8) for (let y = 250; y <= 350; y += 8) {
    await p.mouse.move(x, y);
    const h = await p.evaluate(() => window.__hovers[window.__hovers.length - 1]);
    if (h === label) return [x, y];
  }
  return null;
};
const solidPt = await findPoint('Solid');
const glassPt = await findPoint('Glass');
if (solidPt) await p.mouse.click(solidPt[0], solidPt[1]);
await p.waitForTimeout(120);
if (glassPt) await p.mouse.click(glassPt[0], glassPt[1]);
await p.waitForTimeout(120);

const r = await p.evaluate(() => ({ clicks: window.__clicks, hovers: window.__hovers }));
await b.close();
console.log('clicks:', JSON.stringify(r.clicks));
console.log('hovers:', JSON.stringify(r.hovers));
console.log('errors:', errs.length, errs.slice(0,3).join(' | '));
const ok = r.clicks.includes('Solid') && r.clicks.includes('Glass');
console.log('RESULT:', ok ? 'PASS — engine fires OnClick on solid AND glass' : 'FAIL — ' + (r.clicks.includes('Solid') ? '' : 'solid click missed; ') + (r.clicks.includes('Glass') ? '' : 'glass click missed'));
