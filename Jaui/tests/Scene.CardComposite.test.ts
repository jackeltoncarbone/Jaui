/**
 * The card composite, and the `glass-grid` numbers it should produce.
 *
 * `ShowStudio.Documentation/Perf/SceneRaw.Finding.md` 4(c). The frame's cost is the number of times
 * the SCENE target's Metal render encoder ENDS while the bed is in it: switches 40 -> 20 -> 0 gave
 * 72.85 -> 34.32 -> 11.32 GPU ms on an M4 at dpr 2, two points through the origin. This path makes
 * the scene render pass the bed ONCE and touches it afterwards only with region blits.
 *
 * There is no GPU here and no claim about milliseconds. What these pin is the arithmetic the design
 * rests on -- the grid law that makes a region-sized SOURCE a crop rather than a resample, the
 * replay rule that makes a seeded target equal to what the scene held, and the switch count the
 * walk should now report -- derived from the real classes and the real grid, plus the wiring in the
 * renderer that has to be there for any of it to hold.
 *
 * `Scene.ReadAfterWrite.test.ts` is left byte-for-byte as it was: the M4 has measured numbers
 * against every table in it.
 */
import { describe, it, expect } from 'vitest';
import { SceneReadLedger } from '@jaui/Core/Scene.Ledger';
import {
  readRenderer, readJaui, readJwiftGlass, readPerfJss,
  arrowBody, getterBody, jssClass, jssNumber, jssBlurPt,
} from './Scene.ReadAfterWrite.Source';

// ── The geometry, out of the real sheets ──────────────────────────────────────────────────────

const GLASS = jssClass(readJwiftGlass(), 'JwiftGlass');
const CARD = jssClass(readPerfJss(), 'PerfCard');
const GRID = jssClass(readPerfJss(), 'PerfGrid');

const FROST_PT = jssBlurPt(GLASS, 'BackdropFilter');
const THICKNESS = jssNumber(GLASS, 'Thickness');
const FILLET = jssNumber(GLASS, 'Fillet');
const REFRACTION = jssNumber(GLASS, 'Refraction');
const CA = jssNumber(GLASS, 'ChromaticAberration');
const SHADOW_BLUR_PT = jssNumber(GLASS, 'ShadowBlur');
const SHADOW_OFFSET_Y_PT = jssNumber(GLASS, 'ShadowOffsetY');
const CARD_W_PT = jssNumber(CARD, 'Width');
const CARD_H_PT = jssNumber(CARD, 'Height');
const GAP_PT = jssNumber(GRID, 'Gap');

const DPR = 2;
const CARDS = 20;
const CANVAS_W = 2560;
const CANVAS_H = 1600;

/** `Jaui.ts`'s glass FILL sample margin, mirrored. Unrotated, unscaled: `avgScale` is 1. */
const fillMarginDev = (dpr: number): number => {
  const thicknessDev = THICKNESS * 1 * dpr;
  const minHalf = Math.min(CARD_W_PT, CARD_H_PT) * dpr * 0.5;
  const bulgeMax = FILLET * minHalf * 0.25 * 0.7;
  return FROST_PT * dpr + (thicknessDev + bulgeMax) * REFRACTION + CA * 3 + 8 * dpr;
};
/** `Jaui.ts`'s `_subtreeMaxPaintMargin`, mirrored for a card: shadow blur plus the larger offset. */
const paintMarginDev = (dpr: number): number => (SHADOW_BLUR_PT + SHADOW_OFFSET_Y_PT) * dpr;

/** `BlurPass.PyramidDepth`, mirrored, at `minDepth` 0 -- which is what `ComputeBlur` passes. */
const pyramidDepth = (radius: number): number =>
  Math.max(1, Math.min(8, Math.ceil(Math.log2(Math.max(1, radius) / 3 + 1))));
/** `BlurPass.BaseDownsampleFactor`, mirrored, measured against the CANVAS. */
const baseFactor = (radius: number, regionArea: number): number => {
  if (radius <= 4) return 1;
  if (regionArea < 0.15 * CANVAS_W * CANVAS_H) return 1;
  return Math.min(8, 1 << Math.floor(Math.log2(radius / 4)));
};
/** `WebGL2Renderer.SetCardGrid`, mirrored. */
const cardGrid = (phase: number): number => Math.max(1, 1 << Math.ceil(Math.log2(Math.max(1, phase))));

/** `WebGL2Renderer.BeginCardComposite`'s region derivation, mirrored. Device px, y=0 at TOP. */
const cardRegion = (
  px: number, py: number, pw: number, ph: number, sampleMargin: number, paintMargin: number, P: number,
): { X: number; Y: number; W: number; H: number } => {
  const out = Math.max(sampleMargin, paintMargin);
  const x0 = Math.max(0, Math.floor((px - out) / P) * P);
  const x1 = Math.min(CANVAS_W, Math.ceil((px + pw + out) / P) * P);
  const yb0 = Math.max(0, Math.floor((CANVAS_H - (py + ph + out)) / P) * P);
  const yb1 = Math.min(CANVAS_H, Math.ceil((CANVAS_H - (py - out)) / P) * P);
  return { X: x0, Y: CANVAS_H - yb1, W: x1 - x0, H: yb1 - yb0 };
};

/** `ResolveRegionRect`, mirrored, over an input of `width` x `height`. */
const resolveRegionRect = (
  region: { x: number; y: number; w: number; h: number }, width: number, height: number, phase: number,
): { X: number; YBottom: number; W: number; H: number } => {
  const rx = Math.max(0, Math.min(width - 1, Math.floor(region.x)));
  const ry = Math.max(0, Math.min(height - 1, Math.floor(region.y)));
  const rw = Math.max(1, Math.min(width - rx, Math.ceil(region.w)));
  const rh = Math.max(1, Math.min(height - ry, Math.ceil(region.h)));
  const ryb = height - (ry + rh);
  const x0 = Math.floor(rx / phase) * phase;
  const y0 = Math.floor(ryb / phase) * phase;
  return {
    X: x0, YBottom: y0,
    W: Math.min(width - x0, Math.ceil((rx + rw - x0) / phase) * phase),
    H: Math.min(height - y0, Math.ceil((ryb + rh - y0) / phase) * phase),
  };
};

// `glass-grid`: five columns of four, 236pt pitch, laid out on the 2560x1600 canvas.
const PITCH_X = (CARD_W_PT + GAP_PT) * DPR;
const PITCH_Y = (CARD_H_PT + GAP_PT) * DPR;
const BOX_W = CARD_W_PT * DPR;
const BOX_H = CARD_H_PT * DPR;
const COLS = 5, ROWS = 4;
const ORIGIN_X = Math.floor((CANVAS_W - (COLS * PITCH_X - GAP_PT * DPR)) / 2);
const ORIGIN_Y = Math.floor((CANVAS_H - (ROWS * PITCH_Y - GAP_PT * DPR)) / 2);
const boxes = (): { x: number; y: number }[] => {
  const out: { x: number; y: number }[] = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    out.push({ x: ORIGIN_X + c * PITCH_X, y: ORIGIN_Y + r * PITCH_Y });
  }
  return out;
};

describe('the grid law — a region-sized source is a CROP, not a resample', () => {
  const RADIUS = Math.max(1, FROST_PT) * DPR;
  const P = cardGrid(1 << pyramidDepth(RADIUS));

  it('glass-grid resolves to depth 2, phase 4, and k=1 measured against the CANVAS', () => {
    // `Jaui.ts` floors a surface's own sigma at 1pt, so radius = max(1, 4pt) * 2 = 8 device px.
    expect(RADIUS).toBe(8);
    expect(pyramidDepth(RADIUS)).toBe(2);
    expect(P).toBe(4);
    const region = cardRegion(ORIGIN_X, ORIGIN_Y, BOX_W, BOX_H, fillMarginDev(DPR), paintMarginDev(DPR), P);
    expect(baseFactor(RADIUS, region.W * region.H)).toBe(1);
  });

  it('a card-sized input would pick k=4 without the pin, which is a QUARTER-RES pyramid', () => {
    // The reason `ComputeBlur` computes the factor against the canvas and passes it explicitly.
    // `BaseDownsampleFactor` gates on the region's share of its INPUT's area, and a card-sized
    // input makes every region ~100% of it -- so the gate that keeps a little glass card at full
    // density against a 2560x1600 canvas stops holding the moment the source shrinks to the card.
    const region = cardRegion(ORIGIN_X, ORIGIN_Y, BOX_W, BOX_H, fillMarginDev(DPR), paintMarginDev(DPR), P);
    const againstCard = (): number => {
      if (RADIUS <= 4) return 1;
      if (region.W * region.H < 0.15 * region.W * region.H) return 1;
      return Math.min(8, 1 << Math.floor(Math.log2(RADIUS / 4)));
    };
    expect(againstCard()).toBe(2);
    expect(againstCard()).not.toBe(baseFactor(RADIUS, region.W * region.H));
  });

  it('every card origin is on the grid, on BOTH axes, measured from x=0 and from the BOTTOM', () => {
    // The whole identity argument: floor((rx - X) / phase) * phase == floor(rx / phase) * phase - X
    // exactly when phase divides X. `ResolveRegionRect` works in the input's texels and measures y
    // from the bottom, so the BOTTOM gap carries the same condition as the left edge.
    for (const b of boxes()) {
      const c = cardRegion(b.x, b.y, BOX_W, BOX_H, fillMarginDev(DPR), paintMarginDev(DPR), P);
      expect(c.X % P).toBe(0);
      expect((CANVAS_H - c.Y - c.H) % P).toBe(0);
    }
  });

  it('the pyramid resolves to the SAME absolute texels against the card as against the canvas', () => {
    const margin = fillMarginDev(DPR);
    for (const b of boxes()) {
      const c = cardRegion(b.x, b.y, BOX_W, BOX_H, margin, paintMarginDev(DPR), P);
      // The sample region `Jaui.ts` hands `ComputeBlur`, in screen device px.
      const region = {
        x: Math.max(0, Math.floor(b.x - margin)),
        y: Math.max(0, Math.floor(b.y - margin)),
        w: Math.min(CANVAS_W, Math.ceil(BOX_W + margin * 2)),
        h: Math.min(CANVAS_H, Math.ceil(BOX_H + margin * 2)),
      };
      const onCanvas = resolveRegionRect(region, CANVAS_W, CANVAS_H, P);
      const onCard = resolveRegionRect(
        { x: region.x - c.X, y: region.y - c.Y, w: region.w, h: region.h }, c.W, c.H, P,
      );
      // Same extent, and the same absolute origin once the card's own offsets are added back.
      expect(onCard.W).toBe(onCanvas.W);
      expect(onCard.H).toBe(onCanvas.H);
      expect(onCard.X + c.X).toBe(onCanvas.X);
      expect(onCard.YBottom + (CANVAS_H - c.Y - c.H)).toBe(onCanvas.YBottom);
    }
  });

  it('an UNALIGNED card origin moves the texels, which is what the grid law exists to stop', () => {
    // The negative control. Shift one card's origin off the grid by a single pixel and the same
    // region resolves to a different absolute rect -- different neighbours averaged at every level.
    const margin = fillMarginDev(DPR);
    const b = boxes()[6];
    const c = cardRegion(b.x, b.y, BOX_W, BOX_H, margin, paintMarginDev(DPR), P);
    const region = { x: Math.floor(b.x - margin), y: Math.floor(b.y - margin), w: Math.ceil(BOX_W + margin * 2), h: Math.ceil(BOX_H + margin * 2) };
    const onCanvas = resolveRegionRect(region, CANVAS_W, CANVAS_H, P);
    const skewed = { X: c.X + 1, Y: c.Y, W: c.W, H: c.H };
    const onSkewed = resolveRegionRect(
      { x: region.x - skewed.X, y: region.y - skewed.Y, w: region.w, h: region.h }, skewed.W, skewed.H, P,
    );
    expect(onSkewed.X + skewed.X).not.toBe(onCanvas.X);
  });

  it('the card target is 568 x 436 — the same rect the pyramid already resolves to', () => {
    // Both are the fill region snapped to the same grid, so the composite adds no new size to the
    // level-chain LRU: `glass-grid`'s twenty cards share ONE bucket in the pool and ONE chain.
    const sizes = new Set(boxes().map((b) => {
      const c = cardRegion(b.x, b.y, BOX_W, BOX_H, fillMarginDev(DPR), paintMarginDev(DPR), P);
      return `${c.W}x${c.H}`;
    }));
    expect(sizes.size).toBe(1);
    expect([...sizes][0]).toBe('568x436');
  });
});

describe('the replay rule — a seeded target equals what the scene held', () => {
  const P = 4;
  const margin = fillMarginDev(DPR);
  const paint = paintMarginDev(DPR);

  it('a card PAINTS 36 px past its box and its region REACHES 68, which is why replay is needed', () => {
    // The paint rect is what a later surface replays; the region is what it needs filled. The gap
    // is 40 px, so paint stops 4 px short of the neighbour's box and the region lands 68 px in.
    expect(paint).toBe(36);
    expect(margin).toBeCloseTo(64.75, 6);
    const gap = GAP_PT * DPR;
    expect(gap).toBe(40);
    expect(paint).toBeLessThan(gap);              // no card's ink reaches its neighbour's BOX
    expect(margin).toBeGreaterThan(gap);          // but every card's region reaches its neighbour
  });

  it('an interior card replays exactly four earlier neighbours, and they total ~0.064 Mpx', () => {
    const all = boxes();
    const idx = 2 * COLS + 2;                     // row 2, column 2: interior on both axes
    const me = cardRegion(all[idx].x, all[idx].y, BOX_W, BOX_H, margin, paint, P);
    let n = 0, px = 0;
    for (let j = 0; j < idx; j++) {
      const e = all[j];
      const x0 = Math.max(e.x - paint, me.X), x1 = Math.min(e.x + BOX_W + paint, me.X + me.W);
      const y0 = Math.max(e.y - paint, me.Y), y1 = Math.min(e.y + BOX_H + paint, me.Y + me.H);
      if (x1 <= x0 || y1 <= y0) continue;
      n++;
      px += (x1 - x0) * (y1 - y0);
    }
    expect(n).toBe(4);                            // left, above, above-left, above-right
    expect(px / 1e6).toBeGreaterThan(0.05);
    expect(px / 1e6).toBeLessThan(0.08);
  });

  it('no earlier card PAINTS into a later card\'s own box, so every shadow probe is free', () => {
    // `MeasureShadowBackdrop` samples strictly inside the surface's box. When nothing earlier has
    // painted there the frame snapshot already holds those bytes, so the probe costs no copy.
    const all = boxes();
    for (let i = 0; i < all.length; i++) {
      for (let j = 0; j < i; j++) {
        const e = all[j], m = all[i];
        const hit = m.x < e.x + BOX_W + paint && m.x + BOX_W > e.x - paint
                 && m.y < e.y + BOX_H + paint && m.y + BOX_H > e.y - paint;
        expect(hit).toBe(false);
      }
    }
  });

  it('the copy traffic is ~15 Mpx a frame against 320 Mpx of store-and-load it replaces', () => {
    const all = boxes();
    let blit = CANVAS_W * CANVAS_H;               // the one frame snapshot
    for (let i = 0; i < all.length; i++) {
      const me = cardRegion(all[i].x, all[i].y, BOX_W, BOX_H, margin, paint, P);
      blit += me.W * me.H;                        // seed
      blit += me.W * me.H;                        // write-back
      for (let j = 0; j < i; j++) {
        const e = all[j];
        const x0 = Math.max(e.x - paint, me.X), x1 = Math.min(e.x + BOX_W + paint, me.X + me.W);
        const y0 = Math.max(e.y - paint, me.Y), y1 = Math.min(e.y + BOX_H + paint, me.Y + me.H);
        if (x1 > x0 && y1 > y0) blit += (x1 - x0) * (y1 - y0);
      }
    }
    const replaced = 39 * 2 * CANVAS_W * CANVAS_H; // 39 encoder ends, store + load, whole canvas
    expect(blit / 1e6).toBeGreaterThan(14);
    expect(blit / 1e6).toBeLessThan(17);
    expect(replaced / blit).toBeGreaterThan(20);
  });

  it('twenty live targets is ~20 MB, one pool bucket, released at the drain', () => {
    const c = cardRegion(boxes()[0].x, boxes()[0].y, BOX_W, BOX_H, margin, paint, P);
    const mb = (c.W * c.H * 4 * CARDS) / (1024 * 1024);
    expect(mb).toBeGreaterThan(18);
    expect(mb).toBeLessThan(21);
  });
});

describe('glass-grid — what the switch column should read now', () => {
  it('the composited walk ends the scene encoder ONCE', () => {
    // The bed draws; the first surface cuts the frame snapshot, which is the one non-scene bind
    // over a dirty scene in the whole frame; every card after it is seeded by a BLIT from that
    // snapshot, builds its pyramid from its own target and draws into it, so the scene is never
    // dirtied again until the write-backs land at the end.
    const l = new SceneReadLedger();
    l.BeginFrame();
    for (let band = 0; band < 6; band++) l.NoteWrite();  // the bed
    l.NoteRead(); l.NoteTargetBind('snapshot');           // the one full-canvas cut
    for (let card = 0; card < CARDS; card++) {
      l.NoteTargetBind('card');                           // the seed blit's target bind
      l.NoteTargetBind('blur');                           // fill build, from the CARD
      l.NoteTargetBind('shadow-state');                   // the adaptive probe
      l.NoteTargetBind('blur');                           // rim build, from the CARD
      l.NoteTargetBind('card');                           // rebind after each of the above
    }
    // The drain: twenty blits into the scene, then the present.
    l.NoteFrameEndDrain();
    expect(l.Switches).toBe(1);
    expect(l.Restarts).toBe(1);
    expect(l.Reads).toBe(1);
  });

  it('a card bind is not free by fiat — it costs a switch exactly when the scene IS dirty', () => {
    // The ledger is not special-cased for this path and must not be: a seed bind taken while the
    // bed is unresolved really is an encoder end, and that is the fallback's honest price.
    const l = new SceneReadLedger();
    l.BeginFrame();
    l.NoteWrite();
    l.NoteTargetBind('card');
    expect(l.Switches).toBe(1);
    l.NoteTargetBind('card');
    expect(l.Switches).toBe(1);
  });

  it('a page that draws into the scene between surfaces lands between 1 and the old 40', () => {
    // Three glass surfaces with a plain panel between each pair: every run of glass costs one cut.
    const l = new SceneReadLedger();
    l.BeginFrame();
    l.NoteWrite();                                        // the page
    for (let run = 0; run < 3; run++) {
      l.NoteRead(); l.NoteTargetBind('snapshot');          // re-cut over the direct draw
      l.NoteTargetBind('card'); l.NoteTargetBind('blur'); l.NoteTargetBind('blur');
      l.NoteWrite();                                       // the drain, then the panel
    }
    l.NoteFrameEndDrain();
    expect(l.Switches).toBe(3);
    expect(l.Switches).toBeLessThan(40);
    expect(l.Switches).toBeGreaterThan(1);
  });
});

describe('the renderer actually does what the arithmetic assumes', () => {
  const renderer = readRenderer();

  it('every card bind goes through `_tgt`, so the ledger sees it', () => {
    expect(arrowBody(renderer, 'BeginCardComposite')).toContain("this._tgt('card');");
    expect(arrowBody(renderer, 'RebindSceneTarget')).toContain("this._tgt('card');");
  });

  it('the seed, the replay and the write-back are BLITS — the path adds no draw call', () => {
    const begin = arrowBody(renderer, 'BeginCardComposite');
    const drain = arrowBody(renderer, '_drainCards');
    expect(begin).toContain('gl.blitFramebuffer(');
    expect(drain).toContain('gl.blitFramebuffer(');
    // A draw into the scene is what re-opens its render encoder. If either of these ever became a
    // textured quad the count would go straight back to one end per surface.
    expect(begin).not.toMatch(/gl\.draw(Arrays|Elements)/);
    expect(drain).not.toMatch(/gl\.draw(Arrays|Elements)/);
    expect(arrowBody(renderer, '_cardIntoSnapshotTex')).not.toMatch(/gl\.draw(Arrays|Elements)/);
  });

  it('the seed comes from the FRAME snapshot, which is not the scissored `_snapshotTex`', () => {
    // They are different textures on purpose: the sharp-tap path writes CARD pixels into
    // `_snapshotTex`, and sharing one would corrupt every later card's seed.
    expect(arrowBody(renderer, 'BeginCardComposite')).toContain('this._frameSnapFbo');
    expect(arrowBody(renderer, '_cardIntoSnapshotTex')).toContain('this._snapshotFbo');
    expect(renderer).toContain('private _frameSnapTex: WebGLTexture | null = null;');
  });

  it('the write-back is deferred, because doing it eagerly puts the encoder ends back', () => {
    // Eagerly writing card i back re-dirties the scene, so card i+1's seed bind ends the encoder
    // again -- twenty ends instead of one, which is the whole finding undone.
    expect(arrowBody(renderer, 'EndCardComposite')).toContain('this._cardQueue.push(card);');
    expect(arrowBody(renderer, 'EndCardComposite')).not.toContain('blitFramebuffer');
  });

  it('anything that draws directly into the scene drains the queue FIRST', () => {
    const body = arrowBody(renderer, '_noteSceneDraw');
    expect(body).toContain('this._drainCards(true)');
    expect(body.indexOf('_drainCards')).toBeLessThan(body.indexOf('NoteWrite'));
    // ...and the old semantics are byte-for-byte intact beside it.
    expect(body).toContain("if (this._boundTarget === 'scene') this._sceneLedger.NoteWrite();");
  });

  it('anything that READS the scene drains it first too', () => {
    // A surface that fell back is about to sample the attachment, and the surfaces before it may
    // still be in card targets. Without this its backdrop is missing every queued card.
    expect(getterBody(renderer, 'SceneTexture')).toContain('this._drainCards(true)');
    expect(arrowBody(renderer, '_snapshotBlit')).toContain('this._drainCards(true)');
    expect(arrowBody(renderer, 'BuildSharedBackdrop')).toContain('this._drainCards(true)');
  });

  it('the drain writes back in ASCENDING order, blend-disabled, one region each', () => {
    const body = arrowBody(renderer, '_drainCards');
    expect(body).toContain('for (let i = 0; i < q.length; i++)');
    expect(body).toContain('this._sceneFbo.Framebuffer');
    // blitFramebuffer is a replace: it is not affected by blend, which is what makes "the bytes the
    // scene would have held" an exact statement rather than an approximate one.
    expect(body).not.toContain('EnableBlend');
  });

  it('ComputeBlur pins the downsample factor against the CANVAS, not the card', () => {
    const body = arrowBody(renderer, 'ComputeBlur');
    expect(body).toContain('BaseDownsampleFactor(radius, this._width, this._height, screenRegion)');
    expect(body).toContain('pass.Blur(blurCard.Fbo.Texture, blurCard.W, blurCard.H, radius, minDepth, local, k)');
    // ...and the old path, and its ledger note, are untouched ahead of it.
    expect(body).toContain('if (_unwrap(input) === this._sceneFbo.Texture) this._sceneLedger.NoteRead();');
    expect(body.indexOf("NoteTargetBind('blur')")).toBeLessThan(body.indexOf('blurCard'));
  });

  it('the pyramid map is re-expressed in SCREEN uv before any consumer sees it', () => {
    const body = arrowBody(renderer, '_cardRegionToScreen');
    expect(body).toContain('ScaleX: local.ScaleX * (this._width / card.W)');
    expect(body).toContain('OffsetX: local.OffsetX - card.X * local.ScaleX / card.W');
    // y is measured from the BOTTOM, so the card's bottom gap is the offset, not its top.
    expect(body).toContain('(this._height - card.Y - card.H)');
  });

  it('the sub-window is the VIEWPORT, so `u_Resolution` stays the canvas', () => {
    // `Jiv.Panel.frag` reads its backdrop at `v_PixelPos / u_Resolution` -- a SCREEN uv. The layer
    // cache's retarget (shrink the resolution, offset the projection) would rescale every
    // refraction tap by canvas/card. A negative viewport origin moves the raster and nothing else.
    const body = arrowBody(renderer, '_cardViewport');
    expect(body).toContain('this._gl.viewport(-card.X, -(this._height - card.Y - card.H), this._width, this._height)');
    expect(arrowBody(renderer, 'RebindSceneTarget')).not.toContain('_captureViewOffset');
  });

  it('the grid phase is a power of two and is handed over once a frame', () => {
    expect(arrowBody(renderer, 'SetCardGrid'))
      .toContain('1 << Math.ceil(Math.log2(Math.max(1, phase)))');
    expect(readJaui()).toContain('this._renderer.SetCardGrid(this._renderer.CardGridPhaseFor(');
  });

  it('a nested surface reads its PARENT card rather than opening another', () => {
    // Correct and region-sized: its encoder ends cost a 1 MB target instead of a 16 MB one, and a
    // seed cut from a target that is still being drawn into would not be a seed.
    expect(arrowBody(renderer, 'BeginCardComposite')).toContain('if (this._cardStack.length !== 0) return false;');
    expect(getterBody(renderer, 'SceneTexture')).toContain('if (card !== null) return _wrap(card.Fbo.Texture);');
  });

  it('the area gate keeps k at 1 and keeps a full-screen scrim on the old path', () => {
    expect(arrowBody(renderer, 'BeginCardComposite')).toContain('0.15 * W * H');
  });

  it('the pool releases at the DRAIN, not when a surface finishes drawing', () => {
    // A later surface in the same run replays out of an earlier one's target, so the lifetime is
    // the run and not the surface.
    expect(arrowBody(renderer, '_drainCards')).toContain('Release(c.Fbo)');
    expect(arrowBody(renderer, 'EndCardComposite')).not.toContain('Release');
  });

  it('the whole path has an off switch and a per-frame count', () => {
    const jaui = readJaui();
    expect(jaui).toContain("params.has('no-cardcomposite')");
    expect(jaui).toContain('this._counts.CardComposites = this._renderer.CardComposites;');
    expect(jaui).toContain('cards=${c.CardComposites}');
  });

  it('BeginFrame resets the card state ahead of the split-frame early return', () => {
    const body = arrowBody(renderer, 'BeginFrame');
    expect(body.indexOf('this._frameSnapValid = false;')).toBeLessThan(body.indexOf('_beginPassFrame'));
  });

  it('a resize drops every retained target — they are the OLD canvas\'s regions', () => {
    expect(arrowBody(renderer, 'Resize')).toContain('this._cardPool?.Dispose();');
  });
});

describe('Jaui only composites what it can reproduce exactly', () => {
  const jaui = readJaui();

  it('a gradient fill anywhere in the subtree keeps the surface on the in-scene path', () => {
    // The one fragment whose output depends on WHERE it rasterises: the gradient dither hashes
    // `gl_FragCoord`, which is framebuffer space. Sub-LSB, invisible, and not zero -- and the
    // density rule for this lane is zero differing pixels.
    const body = arrowBody(jaui, '_subtreeHasUnretargetable');
    expect(body).toContain("_bgk === 'LinearGradient' || _bgk === 'RadialGradient'");
    expect(jaui).toContain('&& !this._subtreeHasUnretargetable(node)');
  });

  it('the glass branch opens the composite BEFORE the snapshot, the pyramid and the draw', () => {
    const body = arrowBody(jaui, '_render');
    const open = body.indexOf('r2.BeginCardComposite(');
    expect(open).toBeGreaterThan(-1);
    // The FILL's build, which is the one after the open -- the rim overlay's identical call sits
    // earlier in the file, inside `descendChildren`.
    expect(body.indexOf('lastBackdrop = r.ComputeBlur(r.SceneTexture', open)).toBeGreaterThan(open);
    expect(body.indexOf('r.PanelDrawBatch(w, h, lastBackdrop', open)).toBeGreaterThan(open);
  });

  it('the bracket closes AFTER the children, because the rim paints among them', () => {
    const body = arrowBody(jaui, '_render');
    const walk = body.lastIndexOf('descendChildren(node, eff, stack, scope, effH, childPersp);');
    const close = body.indexOf('(r2 as WebGL2Renderer).EndCardComposite();');
    expect(walk).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(walk);
  });

  it('the pending batches drain into the CARD before it closes', () => {
    // Anything still buffered belongs to this subtree; flushed after the close it would land in the
    // scene, on top of the write-back instead of inside it.
    const body = arrowBody(jaui, '_render');
    const close = body.indexOf('(r2 as WebGL2Renderer).EndCardComposite();');
    const flush = body.lastIndexOf('flushText();', close);
    expect(flush).toBeGreaterThan(-1);
    expect(flush).toBeLessThan(close);
  });

  it('only a node that can put INK down pushes a direct-scene footprint', () => {
    // A container with a transparent background covers the page. Pushing its AABB would make every
    // surface on that page re-cut the snapshot for nothing.
    const body = arrowBody(jaui, '_render');
    expect(body).toContain('r2.NoteSceneFootprint(');
    expect(body).toContain('const _inked = node.EffectiveOpacity > 0.001 && (');
    expect(body).toContain('!r2.CardActive');
  });

  it('every pending write-back lands before the frame is presented', () => {
    const body = arrowBody(jaui, '_render');
    expect(body).toContain('this._renderer.FlushCardComposites();');
    expect(body.indexOf('FlushCardComposites')).toBeLessThan(body.indexOf('r.PresentScene()'));
  });
});

describe('nesting — a glass child reads its parent card, and nothing pretends otherwise', () => {
  const renderer = readRenderer();

  it('the sharp tap falls back to a COPY the moment the card has ink in it', () => {
    // The snapshot shortcut is only sound while the target still equals the snapshot over its
    // region. A nested surface's backdrop is its parent's card WITH the parent's fill and children
    // already down, and the snapshot holds none of that -- so `Dirty` gates it, not just the
    // earlier-cards test, which sees nothing because the parent is on the stack and not the queue.
    const body = arrowBody(renderer, '_cardSharpTap');
    expect(body).toContain('!card.Dirty');
    expect(arrowBody(renderer, '_noteSceneDraw')).toContain("if (this._boundTarget === 'card')");
  });

  it('a card is born clean, so the TOP-LEVEL probe still pays nothing', () => {
    // The probe runs between the fill's pyramid build and the fill's draw, so the card it reads has
    // had nothing drawn into it yet: on `glass-grid` all twenty take the free path.
    expect(arrowBody(renderer, 'BeginCardComposite')).toContain('Dirty: false,');
  });
});
