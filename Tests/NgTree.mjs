import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
await p.goto('http://localhost:6777/', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(9000);
const r = await p.evaluate(() => {
  const j = window.__jaui?.canvas;
  if (!j) return 'no __jaui';
  const root = j.Root;
  return { hasRoot: !!root, rootKids: root?.Children?.length ?? 'n/a', rootW: root?.Width, rootH: root?.Height };
});
console.log('jaui tree:', JSON.stringify(r));
await b.close();
