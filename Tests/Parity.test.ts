// Parity & performance harness: WebGL2 reference vs Three.js migration.
//
// Renders each corpus scene in BOTH the frozen copy (old WebGL2 renderer) and
// the live repo (Three.js), captures the canvas, and does a REAL per-pixel diff
// with pixelmatch. Also reports ms/frame and main-bundle KB for each.
//
// Prerequisites — start both Vite dev servers before running:
//
//   Copy server  (WebGL2 reference, port 5173):
//     cd "Jaui Copy/Examples/Vanilla" && npx vite --port 5173
//
//   New server   (Three.js migration, port 5174):
//     cd "Jaui/Examples/Vanilla" && npx vite --port 5174
//
// Run:
//   cd Jaui && npx playwright test Tests/Parity.test.ts

import { test, expect, type Page } from 'playwright/test';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Config — adjust ports here if servers run elsewhere ──────────────────────

const COPY_ORIGIN = 'http://localhost:5173';  // WebGL2 reference ("Jaui Copy")
const NEW_ORIGIN  = 'http://localhost:5174';  // Three.js migration  ("Jaui")

const READY_ATTRIBUTE   = 'data-ready';
const SETTLE_TIMEOUT_MS  = 800;
// A pixel counts as "different" only if its color delta exceeds this (0..1).
// 0.1 tolerates sub-pixel AA / rounding without masking real divergence.
const PIXELMATCH_THRESHOLD = 0.1;
// A scene PASSES parity if ≤ this fraction of pixels differ.
const MAX_DIFF_PIXEL_RATIO = 0.02;

const DIFF_DIR = resolve(__dirname, 'parity-diffs');

const CORPUS_SCENES = ['FlatPanels', 'Shadows', 'Text', 'Glass', 'Mixed'] as const;

// ── Types ────────────────────────────────────────────────────────────────────

interface SceneResult {
  Scene:        string;
  DiffRatio:    number;   // fraction of pixels that differ (0..1)
  Passed:       boolean;
  CopyFrameMs:  number;
  NewFrameMs:   number;
}

interface BundleInfo { Origin: string; SizeKb: number; }

// ── Helpers ──────────────────────────────────────────────────────────────────

function SceneUrl(origin: string, scene: string): string {
  return `${origin}/Corpus/index.html?scene=${scene}`;
}

/** Navigate to a corpus scene and wait until the canvas reports data-ready. */
async function NavigateAndSettle(page: Page, origin: string, scene: string): Promise<void> {
  await page.goto(SceneUrl(origin, scene), { waitUntil: 'domcontentloaded' });
  const canvas = page.locator('canvas').first();
  await canvas.waitFor({ state: 'visible', timeout: 10_000 });
  await canvas.evaluate(
    (el, attr) => new Promise<void>((res) => {
      if (el.getAttribute(attr) === 'true') return res();
      const obs = new MutationObserver(() => {
        if (el.getAttribute(attr) === 'true') { obs.disconnect(); res(); }
      });
      obs.observe(el, { attributes: true, attributeFilter: [attr] });
      setTimeout(res, 5_000);
    }),
    READY_ATTRIBUTE,
  );
  // Let a few frames settle (springs/text wrap) before sampling.
  await page.waitForTimeout(SETTLE_TIMEOUT_MS);
}

async function ReadFrameMs(page: Page): Promise<number> {
  return page.evaluate(() => {
    const v = (window as unknown as Record<string, unknown>)['__jaui_framems'];
    return typeof v === 'number' ? v : 0;
  });
}

async function ScreenshotCanvas(page: Page): Promise<Buffer> {
  return page.locator('canvas').first().screenshot({ type: 'png' });
}

/** Real per-pixel diff. Returns the fraction of differing pixels and writes a
 *  diff PNG for visual inspection. Handles mismatched dimensions by reporting
 *  a full mismatch (1.0) rather than throwing. */
function DiffPngs(copyBuf: Buffer, newBuf: Buffer, scene: string): number {
  const a = PNG.sync.read(copyBuf);
  const b = PNG.sync.read(newBuf);
  if (a.width !== b.width || a.height !== b.height) {
    console.warn(`[${scene}] dimension mismatch copy=${a.width}x${a.height} new=${b.width}x${b.height}`);
    return 1.0;
  }
  const diff = new PNG({ width: a.width, height: a.height });
  const changed = pixelmatch(a.data, b.data, diff.data, a.width, a.height, {
    threshold: PIXELMATCH_THRESHOLD,
  });
  mkdirSync(DIFF_DIR, { recursive: true });
  writeFileSync(resolve(DIFF_DIR, `${scene}.copy.png`), copyBuf);
  writeFileSync(resolve(DIFF_DIR, `${scene}.new.png`),  newBuf);
  writeFileSync(resolve(DIFF_DIR, `${scene}.diff.png`), PNG.sync.write(diff));
  return changed / (a.width * a.height);
}

/** Capture the first non-node_modules JS response size in KB. */
async function MeasureBundleSizeKb(page: Page, origin: string, scene: string): Promise<number> {
  let bundleUrl: string | null = null;
  page.on('response', (r) => {
    const url = r.url();
    if (!bundleUrl && url.startsWith(origin) && url.endsWith('.ts') === false
        && (url.includes('.js') || (r.headers()['content-type'] ?? '').includes('javascript'))
        && !url.includes('node_modules')) {
      bundleUrl = url;
    }
  });
  try { await page.goto(SceneUrl(origin, scene), { waitUntil: 'networkidle', timeout: 15_000 }); }
  catch { /* networkidle may time out; we only need the URL */ }
  if (!bundleUrl) return -1;
  const head = await page.request.head(bundleUrl);
  const len = head.headers()['content-length'];
  return len ? Math.round((parseInt(len, 10) / 1024) * 10) / 10 : -1;
}

// ── Suite ──────────────────────────────────────────────────────────────────

test.describe('Renderer parity (WebGL2 copy vs Three.js new)', () => {
  const results: SceneResult[] = [];
  const bundleCopy: BundleInfo = { Origin: COPY_ORIGIN, SizeKb: -1 };
  const bundleNew:  BundleInfo = { Origin: NEW_ORIGIN,  SizeKb: -1 };

  for (const scene of CORPUS_SCENES) {
    test(`scene: ${scene}`, async ({ browser }) => {
      const copyCtx = await browser.newContext({ viewport: { width: 900, height: 700 } });
      const newCtx  = await browser.newContext({ viewport: { width: 900, height: 700 } });
      const copyPage = await copyCtx.newPage();
      const newPage  = await newCtx.newPage();
      try {
        await NavigateAndSettle(copyPage, COPY_ORIGIN, scene);
        await NavigateAndSettle(newPage,  NEW_ORIGIN,  scene);

        const copyFrameMs = await ReadFrameMs(copyPage);
        const newFrameMs  = await ReadFrameMs(newPage);

        const copyShot = await ScreenshotCanvas(copyPage);
        const newShot  = await ScreenshotCanvas(newPage);

        const diffRatio = DiffPngs(copyShot, newShot, scene);
        const passed = diffRatio <= MAX_DIFF_PIXEL_RATIO;

        results.push({ Scene: scene, DiffRatio: diffRatio, Passed: passed, CopyFrameMs: copyFrameMs, NewFrameMs: newFrameMs });

        console.log(
          `[${scene}] diff=${(diffRatio * 100).toFixed(3)}% ` +
          `(${passed ? 'PASS' : 'FAIL'} @ ${(MAX_DIFF_PIXEL_RATIO * 100).toFixed(1)}%)  ` +
          `copy=${copyFrameMs.toFixed(2)}ms new=${newFrameMs.toFixed(2)}ms  ` +
          `→ Tests/parity-diffs/${scene}.diff.png`,
        );

        expect(diffRatio, `${scene} pixel diff exceeds tolerance`).toBeLessThanOrEqual(MAX_DIFF_PIXEL_RATIO);
      } finally {
        await copyCtx.close();
        await newCtx.close();
      }
    });
  }

  test('bundle size: copy vs new', async ({ browser }) => {
    const copyCtx = await browser.newContext();
    const newCtx  = await browser.newContext();
    try {
      bundleCopy.SizeKb = await MeasureBundleSizeKb(await copyCtx.newPage(), COPY_ORIGIN, 'FlatPanels');
      bundleNew.SizeKb  = await MeasureBundleSizeKb(await newCtx.newPage(),  NEW_ORIGIN,  'FlatPanels');
      console.log(`Bundle — copy: ${bundleCopy.SizeKb} KB   new: ${bundleNew.SizeKb} KB`);
    } finally {
      await copyCtx.close();
      await newCtx.close();
    }
  });

  test.afterAll(() => {
    if (results.length === 0) return;
    const col = (s: string | number, w: number) => String(s).padEnd(w);
    console.log('\n=== Parity + Performance Summary ===\n');
    console.log(col('Scene', 16) + col('Diff %', 12) + col('Result', 10) + col('Copy ms', 12) + col('New ms', 12));
    console.log('-'.repeat(62));
    for (const r of results) {
      console.log(
        col(r.Scene, 16) +
        col((r.DiffRatio * 100).toFixed(3), 12) +
        col(r.Passed ? 'PASS' : 'FAIL', 10) +
        col(r.CopyFrameMs.toFixed(2), 12) +
        col(r.NewFrameMs.toFixed(2), 12),
      );
    }
    console.log('-'.repeat(62));
    console.log(`Bundle — copy: ${bundleCopy.SizeKb} KB   new: ${bundleNew.SizeKb} KB\n`);
  });
});
