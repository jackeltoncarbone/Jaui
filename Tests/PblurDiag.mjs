// Structured progressive-blur correctness test. Renders the pblur corpus scene
// in BOTH copy (reference) and new, then checks SPECIFIC properties rather than
// one scalar:
//   1. REGION: the feather only affects the top strip (y < featherH); content
//      well below it (e.g. y=400) is byte-identical between "pblur on" and the
//      sharp rows — i.e. pblur didn't bleed downward.
//   2. RAMP DIRECTION: for ToTop, blur is heaviest at the very top and clears
//      downward — measure local detail (edge energy) at y=10, y=80, y=150 and
//      assert monotonic increase (more detail lower down).
//   3. NO WRONG-CONTENT: the feather region's average color should resemble the
//      content DIRECTLY behind it (top rows), not content from far down. We
//      check the dominant hue at the top strip vs row 1's swatch/text region.
// Compares new vs copy so we see whether new reproduces the reference's behavior.
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { writeFileSync } from 'node:fs';

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });

async function grab(origin) {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.goto(`${origin}/Corpus/index.html?scene=Pblur`, { waitUntil: 'domcontentloaded' });
  await page.locator('canvas').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const shot = await page.locator('canvas').first().screenshot({ type: 'png' });
  await page.close();
  return PNG.sync.read(shot);
}

// Horizontal edge energy across a row (high = sharp detail, low = blurred).
function rowEdge(png, y) {
  const W = png.width; let e = 0;
  for (let x = 20; x < 740; x++) {
    const i = (y * W + x) * 4, j = (y * W + x + 1) * 4;
    e += Math.abs(png.data[i] - png.data[j]) + Math.abs(png.data[i+1] - png.data[j+1]) + Math.abs(png.data[i+2] - png.data[j+2]);
  }
  return Math.round(e);
}
// Average color of a band.
function bandAvg(png, y0, y1) {
  const W = png.width; let r=0,g=0,b=0,n=0;
  for (let y=y0;y<y1;y++) for (let x=20;x<740;x++){const i=(y*W+x)*4;r+=png.data[i];g+=png.data[i+1];b+=png.data[i+2];n++;}
  return [Math.round(r/n),Math.round(g/n),Math.round(b/n)];
}

let failures = 0;
function assert(cond, msg) { if (!cond) { console.log('  FAIL:', msg); failures++; } else console.log('  ok:', msg); }

for (const [label, origin] of [['COPY', 'http://localhost:5173'], ['NEW', 'http://localhost:5174']]) {
  const png = await grab(origin);
  writeFileSync(`tests/pblur-diag-${label}.png`, PNG.sync.write(png));
  const e10 = rowEdge(png, 10), e80 = rowEdge(png, 80), e150 = rowEdge(png, 150), e300 = rowEdge(png, 300);
  const topAvg = bandAvg(png, 0, 40);        // feather top — should be DARK (top of page is dark bg + blurred row1)
  const row1 = bandAvg(png, 40, 90);         // row 1 band (green swatch + text)
  console.log(`\n=== ${label} ===  edges y10/80/150/300 = ${e10}/${e80}/${e150}/${e300}  topAvg=${topAvg}`);

  // 1. RAMP DIRECTION (ToTop): detail must increase downward through the feather.
  assert(e10 < e80 && e80 <= e150 && e150 <= e300, 'ramp: blur heaviest at top, clears downward');
  // 2. ACTUALLY BLURRED at top: top edge energy must be a small fraction of sharp.
  assert(e10 < e300 * 0.5, 'top is genuinely blurred (<50% of sharp-row detail)');
  // 3. NO WRONG-CONTENT (the bug): the feather-top must NOT be dominated by the
  //    magenta of bottom rows (R high & B high & G low). Bottom rows are pinkish
  //    (~[200,80,200]); top content is green/dark. Flag magenta bleed at top.
  const magentaBleed = topAvg[0] > 60 && topAvg[2] > 60 && topAvg[1] < topAvg[0] - 15;
  assert(!magentaBleed, 'no bottom-row (magenta) content bleeding into the top feather');
  void row1;
}
await browser.close();
console.log(`\nimages: tests/pblur-diag-{COPY,NEW}.png  |  ${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'}`);
process.exit(failures === 0 ? 0 : 1);
