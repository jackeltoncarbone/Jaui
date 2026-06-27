/**
 * Earcut — robust polygon triangulation with hole support (linked-list ear clipping). Adapted
 * from mapbox/earcut (ISC), trimmed of the z-order hashing optimisation (unnecessary for the
 * modest polygon sizes here — SVG letter outlines, field shapes). Handles holes via bridging,
 * so letter counters (O/D/R/B/S) render as actual holes instead of filled blobs.
 *
 * Earcut(data, holeIndices): `data` is a flat [x0,y0,x1,y1,…] vertex list — the outer ring first,
 * then each hole's vertices appended; `holeIndices` gives the VERTEX index where each hole begins.
 * Returns triangle vertex indices (into `data`), 3 per triangle.
 */

interface ENode {
  i: number; x: number; y: number;
  prev: ENode; next: ENode;
  steiner: boolean;
}

export function Earcut(data: number[], holeIndices: number[] = []): number[] {
  const hasHoles = holeIndices.length > 0;
  const outerLen = hasHoles ? holeIndices[0] * 2 : data.length;
  let outerNode = linkedList(data, 0, outerLen, true);
  const triangles: number[] = [];
  if (!outerNode || outerNode.next === outerNode.prev) return triangles;
  if (hasHoles) outerNode = eliminateHoles(data, holeIndices, outerNode);
  if (outerNode) earcutLinked(outerNode, triangles, 0);
  return triangles;
}

function linkedList(data: number[], start: number, end: number, clockwise: boolean): ENode | null {
  let last: ENode | null = null;
  if (clockwise === (signedArea(data, start, end) > 0)) {
    for (let i = start; i < end; i += 2) last = insertNode(i, data[i], data[i + 1], last);
  } else {
    for (let i = end - 2; i >= start; i -= 2) last = insertNode(i, data[i], data[i + 1], last);
  }
  if (last && equals(last, last.next)) { removeNode(last); last = last.next; }
  return last;
}

function filterPoints(start: ENode, end?: ENode): ENode {
  let e = end ?? start;
  let p = start, again: boolean;
  do {
    again = false;
    if (!p.steiner && (equals(p, p.next) || area(p.prev, p, p.next) === 0)) {
      removeNode(p);
      p = e = p.prev;
      if (p === p.next) break;
      again = true;
    } else {
      p = p.next;
    }
  } while (again || p !== e);
  return e;
}

function earcutLinked(ear: ENode, triangles: number[], pass: number): void {
  let e: ENode | null = filterPoints(ear);
  let stop = e;
  while (e && e.prev !== e.next) {
    const prev: ENode = e.prev, next: ENode = e.next;
    if (isEar(e)) {
      triangles.push(prev.i / 2, e.i / 2, next.i / 2);
      removeNode(e);
      e = next.next;
      stop = next.next;
      continue;
    }
    e = next;
    if (e === stop) {
      // No ear found in a full pass — try harder.
      if (pass === 0) { earcutLinked(filterPoints(e), triangles, 1); return; }
      if (pass === 1) { e = cureLocalIntersections(filterPoints(e), triangles); earcutLinked(e, triangles, 2); return; }
      if (pass === 2) { splitEarcut(e, triangles); return; }
      return;
    }
  }
}

function isEar(ear: ENode): boolean {
  const a = ear.prev, b = ear, c = ear.next;
  if (area(a, b, c) >= 0) return false; // reflex
  let p = c.next;
  while (p !== a) {
    if (pointInTriangle(a.x, a.y, b.x, b.y, c.x, c.y, p.x, p.y) && area(p.prev, p, p.next) >= 0) return false;
    p = p.next;
  }
  return true;
}

function cureLocalIntersections(start: ENode, triangles: number[]): ENode {
  let p = start;
  do {
    const a = p.prev, b = p.next.next;
    if (!equals(a, b) && intersects(a, p, p.next, b) && locallyInside(a, b) && locallyInside(b, a)) {
      triangles.push(a.i / 2, p.i / 2, b.i / 2);
      removeNode(p); removeNode(p.next);
      p = start = b;
    }
    p = p.next;
  } while (p !== start);
  return filterPoints(p);
}

function splitEarcut(start: ENode, triangles: number[]): void {
  let a = start;
  do {
    let b = a.next.next;
    while (b !== a.prev) {
      if (a.i !== b.i && isValidDiagonal(a, b)) {
        let c = splitPolygon(a, b);
        a = filterPoints(a, a.next);
        c = filterPoints(c, c.next);
        earcutLinked(a, triangles, 0);
        earcutLinked(c, triangles, 0);
        return;
      }
      b = b.next;
    }
    a = a.next;
  } while (a !== start);
}

function eliminateHoles(data: number[], holeIndices: number[], outerNode: ENode): ENode {
  const queue: ENode[] = [];
  for (let i = 0; i < holeIndices.length; i++) {
    const start = holeIndices[i] * 2;
    const end = i < holeIndices.length - 1 ? holeIndices[i + 1] * 2 : data.length;
    const list = linkedList(data, start, end, false);
    if (list) { if (list === list.next) list.steiner = true; queue.push(getLeftmost(list)); }
  }
  queue.sort((a, b) => a.x - b.x);
  let node = outerNode;
  for (const hole of queue) { node = eliminateHole(hole, node); }
  return node;
}

function eliminateHole(hole: ENode, outerNode: ENode): ENode {
  const bridge = findHoleBridge(hole, outerNode);
  if (!bridge) return outerNode;
  const bridgeReverse = splitPolygon(bridge, hole);
  filterPoints(bridgeReverse, bridgeReverse.next);
  return filterPoints(bridge, bridge.next);
}

function findHoleBridge(hole: ENode, outerNode: ENode): ENode | null {
  let p = outerNode;
  const hx = hole.x, hy = hole.y;
  let qx = -Infinity;
  let m: ENode | null = null;
  do {
    if (hy <= p.y && hy >= p.next.y && p.next.y !== p.y) {
      const x = p.x + ((hy - p.y) / (p.next.y - p.y)) * (p.next.x - p.x);
      if (x <= hx && x > qx) { qx = x; m = p.x < p.next.x ? p : p.next; if (x === hx) return m; }
    }
    p = p.next;
  } while (p !== outerNode);
  if (!m) return null;
  const stop = m;
  const mx = m.x, my = m.y;
  let tanMin = Infinity;
  p = m;
  do {
    if (hx >= p.x && p.x >= mx && hx !== p.x &&
        pointInTriangle(hy < my ? hx : qx, hy, mx, my, hy < my ? qx : hx, hy, p.x, p.y)) {
      const tan = Math.abs(hy - p.y) / (hx - p.x);
      if (locallyInside(p, hole) && (tan < tanMin || (tan === tanMin && (p.x > m!.x || (p.x === m!.x && sectorContainsSector(m!, p)))))) {
        m = p; tanMin = tan;
      }
    }
    p = p.next;
  } while (p !== stop);
  return m;
}

function sectorContainsSector(m: ENode, p: ENode): boolean {
  return area(m.prev, m, p.prev) < 0 && area(p.next, m, m.next) < 0;
}

function getLeftmost(start: ENode): ENode {
  let p = start, leftmost = start;
  do { if (p.x < leftmost.x || (p.x === leftmost.x && p.y < leftmost.y)) leftmost = p; p = p.next; } while (p !== start);
  return leftmost;
}

function pointInTriangle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, px: number, py: number): boolean {
  return (cx - px) * (ay - py) >= (ax - px) * (cy - py) &&
         (ax - px) * (by - py) >= (bx - px) * (ay - py) &&
         (bx - px) * (cy - py) >= (cx - px) * (by - py);
}

function isValidDiagonal(a: ENode, b: ENode): boolean {
  return a.next.i !== b.i && a.prev.i !== b.i && !intersectsPolygon(a, b) &&
    ((locallyInside(a, b) && locallyInside(b, a) && middleInside(a, b) &&
      (area(a.prev, a, b.prev) !== 0 || area(a, b.prev, b) !== 0)) ||
      (equals(a, b) && area(a.prev, a, a.next) > 0 && area(b.prev, b, b.next) > 0));
}

function area(p: ENode, q: ENode, r: ENode): number {
  return (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
}
function equals(p1: ENode, p2: ENode): boolean { return p1.x === p2.x && p1.y === p2.y; }

function intersects(p1: ENode, q1: ENode, p2: ENode, q2: ENode): boolean {
  const o1 = sign(area(p1, q1, p2)), o2 = sign(area(p1, q1, q2)), o3 = sign(area(p2, q2, p1)), o4 = sign(area(p2, q2, q1));
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(p1, p2, q1)) return true;
  if (o2 === 0 && onSegment(p1, q2, q1)) return true;
  if (o3 === 0 && onSegment(p2, p1, q2)) return true;
  if (o4 === 0 && onSegment(p2, q1, q2)) return true;
  return false;
}
function onSegment(p: ENode, q: ENode, r: ENode): boolean {
  return q.x <= Math.max(p.x, r.x) && q.x >= Math.min(p.x, r.x) && q.y <= Math.max(p.y, r.y) && q.y >= Math.min(p.y, r.y);
}
function sign(n: number): number { return n > 0 ? 1 : n < 0 ? -1 : 0; }

function intersectsPolygon(a: ENode, b: ENode): boolean {
  let p = a;
  do {
    if (p.i !== a.i && p.next.i !== a.i && p.i !== b.i && p.next.i !== b.i && intersects(p, p.next, a, b)) return true;
    p = p.next;
  } while (p !== a);
  return false;
}
function locallyInside(a: ENode, b: ENode): boolean {
  return area(a.prev, a, a.next) < 0
    ? area(a, b, a.next) >= 0 && area(a, a.prev, b) >= 0
    : area(a, b, a.prev) < 0 || area(a, a.next, b) < 0;
}
function middleInside(a: ENode, b: ENode): boolean {
  let p = a, inside = false;
  const px = (a.x + b.x) / 2, py = (a.y + b.y) / 2;
  do {
    if (((p.y > py) !== (p.next.y > py)) && p.next.y !== p.y && (px < ((p.next.x - p.x) * (py - p.y)) / (p.next.y - p.y) + p.x)) inside = !inside;
    p = p.next;
  } while (p !== a);
  return inside;
}

function splitPolygon(a: ENode, b: ENode): ENode {
  const a2: ENode = { i: a.i, x: a.x, y: a.y, prev: null as unknown as ENode, next: null as unknown as ENode, steiner: false };
  const b2: ENode = { i: b.i, x: b.x, y: b.y, prev: null as unknown as ENode, next: null as unknown as ENode, steiner: false };
  const an = a.next, bp = b.prev;
  a.next = b; b.prev = a;
  a2.next = an; an.prev = a2;
  b2.next = a2; a2.prev = b2;
  bp.next = b2; b2.prev = bp;
  return b2;
}

function insertNode(i: number, x: number, y: number, last: ENode | null): ENode {
  const p: ENode = { i, x, y, prev: null as unknown as ENode, next: null as unknown as ENode, steiner: false };
  if (!last) { p.prev = p; p.next = p; }
  else { p.next = last.next; p.prev = last; last.next.prev = p; last.next = p; }
  return p;
}
function removeNode(p: ENode): void { p.next.prev = p.prev; p.prev.next = p.next; }

function signedArea(data: number[], start: number, end: number): number {
  let sum = 0;
  for (let i = start, j = end - 2; i < end; i += 2) { sum += (data[j] - data[i]) * (data[i + 1] + data[j + 1]); j = i; }
  return sum;
}
