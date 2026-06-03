// Pill SDF vs SS Bezier — pixel-level overlay diff.
//
// Both shapes rasterized into the same ImageData. Red channel = SS hit,
// Blue+Green channels = SDF hit. Overlap shows as white. Red-only and
// cyan-only regions highlight the divergence.

// ─── SS's GeneratePillPath, reproduced in-canvas ───
// Copied from show-studio/ShowStudio.Web/src/Libraries/Jaui/Jiv/Jiv.ts
// — faithfully: we call this with the bounding box (x, y, w, h) and it
// draws its own Bezier endcaps with the exact same numbers SS uses.
function drawSSPillPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  const scaleY = h / 50;
  const endScale = (h / 2) / 25; // radius / 25
  const curveWidth = 42.5 * endScale;
  const lc = x + curveWidth;
  const rc = x + w - curveWidth;
  const y0 = y, y1 = y + 9 * scaleY, y2 = y + 18 * scaleY,
        y3 = y + 32 * scaleY, y4 = y + 41 * scaleY, y5 = y + h;
  const L = { cp1: -15.3, cp2: -27.2, curve: -34.85, tip: -42.5 };
  const R = { cp1: 15.3, cp2: 27.2, curve: 34.85, tip: 42.5 };

  ctx.beginPath();
  ctx.moveTo(lc, y0);
  ctx.bezierCurveTo(lc + L.cp1 * endScale, y0, lc + L.cp2 * endScale, y0, lc + L.curve * endScale, y1);
  ctx.bezierCurveTo(lc + L.tip * endScale, y2, lc + L.tip * endScale, y3, lc + L.curve * endScale, y4);
  ctx.bezierCurveTo(lc + L.cp2 * endScale, y5, lc + L.cp1 * endScale, y5, lc, y5);
  ctx.lineTo(rc, y5);
  ctx.bezierCurveTo(rc + R.cp1 * endScale, y5, rc + R.cp2 * endScale, y5, rc + R.curve * endScale, y4);
  ctx.bezierCurveTo(rc + R.tip * endScale, y3, rc + R.tip * endScale, y2, rc + R.curve * endScale, y1);
  ctx.bezierCurveTo(rc + R.cp2 * endScale, y0, rc + R.cp1 * endScale, y0, rc, y0);
  ctx.lineTo(lc, y0);
  ctx.closePath();
}

// ─── Our SDF — mirror of Jiv.Panel.frag ShapeSDF_inner for pill mode ───
// Same math, in JS. If we change the shader, we change this too. In a later
// iteration we'll bind the shader's source as the test target directly.
function sdfPillInside(px: number, py: number,
                       halfW: number, halfH: number,
                       rAx: number, rAy: number, n: number): boolean {
  const aX = Math.abs(px);
  const aY = Math.abs(py);
  const qx = aX - halfW + rAx;
  const qy = aY - halfH + rAy;

  // Flat interior
  if (qx <= 0 && qy <= 0) {
    // Inside if we're within half-size
    return aX <= halfW && aY <= halfH;
  }

  // Corner region — use same approximate SDF as shader
  const qcX = Math.max(qx, 0);
  const qcY = Math.max(qy, 0);
  const u = qcX / rAx;
  const v = qcY / rAy;
  const eps = 1e-5;
  const uE = Math.max(u, eps);
  const vE = Math.max(v, eps);
  const L = Math.pow(Math.pow(uE, n) + Math.pow(vE, n), 1 / n);
  return L <= 1;
}

// ─── Main rendering ───
const canvas = document.getElementById('c') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const CANVAS_W = canvas.width, CANVAS_H = canvas.height;

const wIn = document.getElementById('w') as HTMLInputElement;
const hIn = document.getElementById('h') as HTMLInputElement;
const raIn = document.getElementById('ra') as HTMLInputElement;
const nIn = document.getElementById('n') as HTMLInputElement;
const fillIn = document.getElementById('fill') as HTMLInputElement;
const wOut = document.getElementById('wOut') as HTMLOutputElement;
const hOut = document.getElementById('hOut') as HTMLOutputElement;
const raOut = document.getElementById('raOut') as HTMLOutputElement;
const nOut = document.getElementById('nOut') as HTMLOutputElement;

function render(): void {
  const W = parseFloat(wIn.value);
  const H = parseFloat(hIn.value);
  const raRatio = parseFloat(raIn.value);
  const n = parseFloat(nIn.value);
  const fillBbox = fillIn.checked;

  wOut.textContent = W.toFixed(0);
  hOut.textContent = H.toFixed(0);
  raOut.textContent = raRatio.toFixed(4);
  nOut.textContent = n.toFixed(2);

  // Pill centered in canvas
  const bx = (CANVAS_W - W) / 2;
  const by = (CANVAS_H - H) / 2;
  const cx = CANVAS_W / 2;
  const cy = CANVAS_H / 2;
  const halfW = W / 2;
  const halfH = H / 2;

  // ─── Pass 1: rasterize SS path to a mask ───
  ctx.save();
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
  drawSSPillPath(ctx, bx, by, W, H);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  const ssData = ctx.getImageData(0, 0, CANVAS_W, CANVAS_H);
  ctx.restore();

  // ─── Pass 2: rasterize SDF to a mask ───
  // rx, ry in physical px. For horizontal pill: rx = raRatio * halfH, ry = halfH
  // (and SDF uses those as corner-box semi-axes).
  const rx = fillBbox
    ? raRatio * halfH
    : (42.5 / 25) * halfH; // SS's raw curveWidth / halfY (1.7× not fill)
  const ry = halfH;

  const sdfData = ctx.createImageData(CANVAS_W, CANVAS_H);
  for (let y = 0; y < CANVAS_H; y++) {
    for (let x = 0; x < CANVAS_W; x++) {
      const inside = sdfPillInside(x - cx, y - cy, halfW, halfH, rx, ry, n);
      if (inside) {
        const idx = (y * CANVAS_W + x) * 4;
        sdfData.data[idx + 3] = 255;
      }
    }
  }

  // ─── Pass 3: combine into diff view ───
  // R channel = SS hit, G+B channels = SDF hit
  // Overlap = white, SS-only = red, SDF-only = cyan
  const out = ctx.createImageData(CANVAS_W, CANVAS_H);
  let mismatch = 0;
  for (let i = 0; i < ssData.data.length; i += 4) {
    const ssHit = ssData.data[i + 3] > 128 ? 1 : 0;
    const sdfHit = sdfData.data[i + 3] > 128 ? 1 : 0;
    if (ssHit !== sdfHit) mismatch++;
    out.data[i + 0] = ssHit * 255;          // R = SS
    out.data[i + 1] = sdfHit * 255;          // G = SDF
    out.data[i + 2] = sdfHit * 255;          // B = SDF (G+B = cyan)
    out.data[i + 3] = (ssHit || sdfHit) ? 255 : 0;
  }
  ctx.putImageData(out, 0, 0);

  // Mismatch readout
  const totalShapePixels = Math.max(1, Math.round(W * H));
  const mmPct = (mismatch / totalShapePixels * 100).toFixed(2);
  ctx.fillStyle = '#888';
  ctx.font = '12px ui-monospace, Menlo, monospace';
  ctx.fillText(`mismatch: ${mismatch} px (${mmPct}% of shape area)`, 12, CANVAS_H - 12);
}

[wIn, hIn, raIn, nIn, fillIn].forEach(el => el.addEventListener('input', render));
render();

console.log('[PillTest] drag the sliders to tune; goal: no pure red or cyan, only white');
