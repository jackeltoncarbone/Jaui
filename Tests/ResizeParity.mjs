// Resize/interaction parity harness — the gap that let the canvas-blowup and
// frozen-size bugs through. Drives REAL window resizes (minimize/maximize style)
// at dpr 1 AND dpr 2, and asserts the canvas backing store + CSS box track the
// window every step: never collapses, never exceeds the window, always follows.
//
// Run against the full-window product host (home.html). Usage:
//   node tests/resize-parity.mjs
import { chromium } from 'playwright';

const URL = process.env.HOST_URL || 'http://localhost:6777/Corpus/Home.html';

const STEPS = [
  { w: 1280, h: 800, tag: 'initial' },
  { w: 1600, h: 1000, tag: 'maximize' },
  { w: 720, h: 500, tag: 'restore-small' },
  { w: 400, h: 300, tag: 'minimize-ish' },
  { w: 1920, h: 1080, tag: 'fullscreen' },
  { w: 1100, h: 720, tag: 'settle' },
];

async function run(dpr) {
  const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: STEPS[0].w, height: STEPS[0].h }, deviceScaleFactor: dpr });
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.locator('canvas').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(800);

  const rows = [];
  for (const s of STEPS) {
    await page.setViewportSize({ width: s.w, height: s.h });
    // Wait for the backing store to SETTLE at the EXPECTED value (or 2s), as a
    // real user perceives — a transient mid-correction frame is fine as long as
    // it converges. Expected backing = window x dpr.
    const wantW = Math.round(s.w * dpr), wantH = Math.round(s.h * dpr);
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(100);
      const cur = await page.evaluate(() => { const c = document.querySelector('canvas'); return [c.width, c.height]; });
      if (cur[0] === wantW && cur[1] === wantH) break;
    }
    const m = await page.evaluate(() => {
      const c = document.querySelector('canvas');
      const r = c.getBoundingClientRect();
      return { backW: c.width, backH: c.height, cssW: Math.round(r.width), cssH: Math.round(r.height),
               scrollW: document.documentElement.scrollWidth, scrollH: document.documentElement.scrollHeight,
               innerW: window.innerWidth, innerH: window.innerHeight, dpr: window.devicePixelRatio };
    });
    // Assertions
    const follows = m.cssW === m.innerW && m.cssH === m.innerH;          // CSS box == window
    const backingOk = m.backW === Math.round(m.innerW * m.dpr) && m.backH === Math.round(m.innerH * m.dpr);
    const noScroll = m.scrollW <= m.innerW && m.scrollH <= m.innerH;     // no overflow
    const alive = m.backW > 0 && m.backH > 0;
    rows.push({ ...s, m, follows, backingOk, noScroll, alive });
  }
  await browser.close();
  return { rows, errs };
}

let allPass = true;
for (const dpr of [1, 2]) {
  const { rows, errs } = await run(dpr);
  console.log(`\n===== dpr ${dpr} =====`);
  console.log('step           win        css        backing      follows backing noScroll alive');
  for (const r of rows) {
    const ok = r.follows && r.backingOk && r.noScroll && r.alive;
    allPass = allPass && ok;
    console.log(
      `${r.tag.padEnd(14)} ${(r.w+'x'+r.h).padEnd(10)} ${(r.m.cssW+'x'+r.m.cssH).padEnd(10)} ${(r.m.backW+'x'+r.m.backH).padEnd(12)} ` +
      `${r.follows?'  Y':'  N'}     ${r.backingOk?'Y':'N'}      ${r.noScroll?'Y':'N'}       ${r.alive?'Y':'N'}`
    );
  }
  if (errs.length) console.log('errors:', errs.slice(0, 5).join(' | '));
}
console.log('\nRESULT:', allPass ? 'PASS — canvas tracks window at all sizes/dprs' : 'FAIL — see N columns above');
process.exit(allPass ? 0 : 1);
