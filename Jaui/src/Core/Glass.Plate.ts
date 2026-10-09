/**
 * GLASS NEVER SAMPLES GLASS BESIDE OR UNDER IT, ONLY GLASS IT IS PRESENTED OVER (Drill Sentences lanes WW1, follow up
 * three, and GL5). Pure, so the rule is spec'd (`Glass.Plate.test.ts`).
 *
 * Jack: "we keep stacking them and they keep getting more grey and like darker and more opaque". Measured live on a
 * phone: the field rgb(71, 86, 54), the sheet over it rgb(35, 41, 30), a menu over the sheet rgb(27, 30, 26). Every glass
 * surface built its backdrop from the scene as painted so far, so a menu over the sheet blurred and tinted the sheet's
 * already blurred, already tinted face, and each layer darkened and greyed the one below. A sheet, a bar, a toast read
 * the content under them, not each other; glass presented over glass is the one case that reads it (below).
 *
 * So the walk keeps a PLATE: the scene as it stands with no glass face in it. Before a glass surface draws, the plate is
 * brought up to date from the scene over the surface's sample region, everywhere except where an earlier glass face
 * stands (`PlateSyncRects`); there the plate keeps what was under that face when it drew. The surface's backdrop (its
 * pyramid, its sharp tap, its shadow probe) is built from the plate. A glass face excludes its box and the reach of its
 * own drop shadow (`GlassFaceExclusion`), held to the region it synced, so no lower glass's face, rim or shadow is ever
 * read by an upper one: where glass touches glass the upper simply replaces the lower, one rim and one shadow.
 *
 * A glass may read its SURFACE instead (`GlassReads: Surface`): a sheet's own bar buttons stand in the sheet's toolbar
 * layer over its glass, as iOS 26 draws them, and a held toggle's clear knob refracts its track. Those read the scene as
 * drawn, the glass under them included.
 *
 * A veil (`GlassSeesThrough`, a sheet's dimming view) is kept out of the plate the same way a glass face is: the plate
 * takes what lies under it before it draws, so an alert's glass over the dim is the same glass as every popover's.
 *
 * GLASS PRESENTED OVER GLASS READS IT (Drill Sentences lane GL5, `GlassReadsComposite`). The plate held one limit: content
 * drawn ON a glass face after it (a sheet's own sentences) is under that face's exclusion, so a menu over the sheet saw
 * the field beneath both and none of the sheet, and read as an opaque card (blind round 30: "only the elevated face and a
 * hairline rim mark it"). On iOS 26 a menu over a sheet carries the sheet's rows through it as a soft blur, lensed at its
 * edges; that is what reads as glass (Jwift/Apple/LiquidGlass.md 8.1: a menu's CABackdropLayer captures the sheet). So a
 * glass face that stands over earlier glass faces (its elevation above 0, `GlassCoveredShare`) builds its backdrop from
 * the scene as drawn: the lower glass's final pixels and everything drawn on them. Layer order drew all of that first.
 *
 * Why that cannot compound, as the old every-glass-reads-the-scene did: the upper face is applied ONCE, to final pixels.
 * Nothing re-runs the lower glass's recipe; the lower glass never reads the upper; and the upper wears the presented face
 * (Core/Glass.Pipeline.ts, `GLASS_FACE_APPLE_DARK_ELEVATED`), whose line lifts the lower glass's tone rather than pulling
 * it toward the dark face's fixed point and holds its chroma rather than taking 0.6 of it again. So each level stands a
 * step lighter than the one under it and no greyer, never the field (71, 86, 54), sheet (35, 41, 30), menu (27, 30, 26)
 * slide. Controls inside glass stay vibrant fills, never glass, so nothing inside a level adds a face of its own.
 * Every other glass face still reads the plate: a sheet over the tab bar, a bar beside a sheet, a menu over the field.
 */

/** A rect in device px, y down. */
export interface PlateRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** The most pieces one sync is cut into. Past it the remaining exclusions are not cut (they are taken from the scene). */
export const PLATE_PIECES_MAX = 64;

const Intersect = (a: PlateRect, b: PlateRect): PlateRect | null => {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
};

/** `r` less `cut`: up to four rects (above, below, left, right of the cut), or `r` itself when they miss. */
const Subtract = (r: PlateRect, cut: PlateRect): PlateRect[] => {
  const hit = Intersect(r, cut);
  if (hit === null) return [r];
  const out: PlateRect[] = [];
  if (hit.y > r.y) out.push({ x: r.x, y: r.y, w: r.w, h: hit.y - r.y });
  if (hit.y + hit.h < r.y + r.h) out.push({ x: r.x, y: hit.y + hit.h, w: r.w, h: r.y + r.h - (hit.y + hit.h) });
  if (hit.x > r.x) out.push({ x: r.x, y: hit.y, w: hit.x - r.x, h: hit.h });
  if (hit.x + hit.w < r.x + r.w) out.push({ x: hit.x + hit.w, y: hit.y, w: r.x + r.w - (hit.x + hit.w), h: hit.h });
  return out;
};

/** What of `region` the plate takes from the scene before a glass surface draws: the region less every earlier glass
 *  face's exclusion, as disjoint rects. */
export function PlateSyncRects(region: PlateRect, faces: readonly PlateRect[]): PlateRect[] {
  let pieces: PlateRect[] = region.w > 0 && region.h > 0 ? [region] : [];
  for (const face of faces) {
    const next: PlateRect[] = [];
    for (const p of pieces) for (const q of Subtract(p, face)) next.push(q);
    if (next.length > PLATE_PIECES_MAX) break;
    pieces = next;
  }
  return pieces;
}

/** What a glass face keeps out of every later sync: its box grown by its drop shadow's reach (`shadowPx`), held to the
 *  region it synced, so all of it holds what lay under the face when it drew. */
export function GlassFaceExclusion(face: PlateRect, shadowPx: number, synced: PlateRect): PlateRect | null {
  const grown: PlateRect = { x: face.x - shadowPx, y: face.y - shadowPx, w: face.w + 2 * shadowPx, h: face.h + 2 * shadowPx };
  return Intersect(grown, synced);
}

/**
 * GLASS PRESENTED OVER GLASS (Drill Sentences lane GL3). The share of a glass face's box, 0 to 1, that stands over the
 * boxes of glass faces drawn before it this frame (their faces alone, not their shadows or a veil). It is what lifts a
 * menu over a sheet one step (Core/Glass.Pipeline.ts, `GlassElevationOf`), as Apple's menu over a sheet reads one
 * (Jwift/Apple/LiquidGlass.md 8.1), and what makes it read the sheet (`GlassReadsComposite`).
 */
export function GlassCoveredShare(face: PlateRect, below: readonly PlateRect[]): number {
  const area = face.w * face.h;
  if (!(area > 0) || below.length === 0) return 0;
  let open = 0;
  for (const p of PlateSyncRects(face, below)) open += p.w * p.h;
  return Math.max(0, Math.min(1, 1 - open / area));
}

/** Whether a glass face of elevation `elevation` (`GlassElevationOf`) reads the scene as drawn, the glass under it
 *  included, rather than the plate: exactly when it is presented over glass, so the step and the read go together. */
export const GlassReadsComposite = (elevation: number): boolean => elevation > 0;
