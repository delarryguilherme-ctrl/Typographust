import type { Glyph, Point } from "./glyf";

/**
 * Outlines as segments, for the two jobs that need more than a point list:
 *
 * 1. **Compatibility across masters.** Two weights of one family often draw
 *    the same contour with different point patterns — a CFF optimiser turns
 *    a flat curve into a line in one weight but not the other, or TrueType
 *    leaves an on-curve point implied in one and explicit in the other. At
 *    the segment level those are the same shape: a line is a degenerate
 *    curve. Promoting segments to the highest degree any master uses makes
 *    the masters point-compatible again.
 * 2. **Cubic → quadratic.** TrueType is quadratic, so every cubic segment is
 *    split into `n` pieces with one quadratic each. All masters must split a
 *    segment the same number of times, so the piece count is the largest any
 *    of them needs.
 */

interface P {
  x: number;
  y: number;
}

export interface Segment {
  start: P;
  /** 0 controls: line. 1: quadratic. 2: cubic. */
  controls: P[];
}

/** Closed: segment i ends where segment i + 1 starts. */
export type Contour = Segment[];

const mid = (a: P, b: P): P => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const lerp = (a: P, b: P, t: number): P => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** Splits a glyph into segment contours. Returns null on a malformed cubic contour. */
export function toContours(glyph: Glyph, cubic: boolean): Contour[] | null {
  const out: Contour[] = [];
  let start = 0;
  for (const end of glyph.endPts) {
    const pts = glyph.points.slice(start, end + 1);
    start = end + 1;
    if (pts.length === 0) continue;
    const contour = cubic ? cubicContour(pts) : quadraticContour(pts);
    if (!contour) return null;
    if (contour.length > 0) out.push(contour);
  }
  return out;
}

function cubicContour(pts: Point[]): Contour | null {
  if (!pts[0].on) return null;
  const n = pts.length;
  const segs: Contour = [];
  let i = 0;
  while (i < n) {
    const at = (k: number) => pts[(i + k) % n];
    if (at(1).on || n === 1) {
      segs.push({ start: at(0), controls: [] });
      i += 1;
    } else {
      if (at(2).on) return null;
      segs.push({ start: at(0), controls: [at(1), at(2)] });
      i += 3;
    }
  }
  return i === n ? segs : null;
}

function quadraticContour(pts: Point[]): Contour {
  const n = pts.length;
  let first = pts.findIndex((p) => p.on);
  // An all-off-curve contour (a legal TrueType circle) starts at an implied point.
  let ring: Point[];
  if (first < 0) {
    ring = [{ ...mid(pts[0], pts[1 % n]), on: true }, ...pts.slice(1), pts[0]];
    first = 0;
  } else {
    ring = [...pts.slice(first), ...pts.slice(0, first)];
  }

  const segs: Contour = [];
  const m = ring.length;
  let i = 0;
  while (i < m) {
    const startPoint = ring[i];
    // Collect off-curve points up to the next on-curve point (wrapping).
    const offs: Point[] = [];
    let j = i + 1;
    while (j < m && !ring[j].on) offs.push(ring[j++]);
    if (offs.length === 0) {
      segs.push({ start: startPoint, controls: [] });
    } else {
      let s: P = startPoint;
      for (let k = 0; k < offs.length; k++) {
        segs.push({ start: s, controls: [offs[k]] });
        if (k < offs.length - 1) s = mid(offs[k], offs[k + 1]);
      }
    }
    i = j;
  }
  return segs;
}

function contourArea(c: Contour) {
  const poly: P[] = [];
  for (const s of c) poly.push(s.start, ...s.controls);
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

function reverseContour(c: Contour): Contour {
  const n = c.length;
  const out: Contour = [{ start: c[0].start, controls: [...c[n - 1].controls].reverse() }];
  for (let k = n - 1; k >= 1; k--) out.push({ start: c[k].start, controls: [...c[k - 1].controls].reverse() });
  return out;
}

export interface Frame {
  xMin: number;
  yMin: number;
  w: number;
  h: number;
  /** tan of the italic angle, removed before comparing so slanted masters line up. */
  shear: number;
}

export function frameOf(glyph: Glyph, italicAngle: number): Frame {
  const shear = Math.tan((italicAngle * Math.PI) / 180);
  let xMin = Infinity;
  let yMin = Infinity;
  let xMax = -Infinity;
  let yMax = -Infinity;
  for (const p of glyph.points) {
    const x = p.x + shear * p.y;
    xMin = Math.min(xMin, x);
    xMax = Math.max(xMax, x);
    yMin = Math.min(yMin, p.y);
    yMax = Math.max(yMax, p.y);
  }
  if (!Number.isFinite(xMin)) return { xMin: 0, yMin: 0, w: 1, h: 1, shear };
  return { xMin, yMin, w: Math.max(1, xMax - xMin), h: Math.max(1, yMax - yMin), shear };
}

const norm = (p: P, f: Frame): P => ({ x: (p.x + f.shear * p.y - f.xMin) / f.w, y: (p.y - f.yMin) / f.h });

interface ContourStats {
  /** Point count (or segment count) — only equal counts can pair. */
  size: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
  /** Winding: outer contours and counters wind opposite ways. */
  sign: number;
}

function statsOf(points: P[], area: number, size: number, f: Frame): ContourStats {
  let xMin = Infinity;
  let yMin = Infinity;
  let xMax = -Infinity;
  let yMax = -Infinity;
  for (const p of points) {
    const q = norm(p, f);
    xMin = Math.min(xMin, q.x);
    xMax = Math.max(xMax, q.x);
    yMin = Math.min(yMin, q.y);
    yMax = Math.max(yMax, q.y);
  }
  return { size, cx: (xMin + xMax) / 2, cy: (yMin + yMax) / 2, w: xMax - xMin, h: yMax - yMin, sign: Math.sign(area) };
}

/**
 * Pairs contours across two masters. Position alone is not enough — the
 * outside of an "o" and its counter share a centre — so size and winding
 * count too. Returns, for each base contour, the index of its partner.
 */
function pairContours(a: ContourStats[], b: ContourStats[]): number[] | null {
  const pairs: { i: number; j: number; d: number }[] = [];
  a.forEach((p, i) =>
    b.forEach((q, j) => {
      if (p.size !== q.size) return;
      const d =
        Math.hypot(p.cx - q.cx, p.cy - q.cy) +
        0.5 * (Math.abs(p.w - q.w) + Math.abs(p.h - q.h)) +
        (p.sign !== q.sign ? 10 : 0) +
        (i === j ? -1e-6 : 0); // prefer the original order on ties
      pairs.push({ i, j, d });
    }),
  );
  pairs.sort((x, y) => x.d - y.d);
  const assigned = new Array<number>(a.length).fill(-1);
  const used = new Set<number>();
  for (const p of pairs) {
    if (assigned[p.i] >= 0 || used.has(p.j)) continue;
    assigned[p.i] = p.j;
    used.add(p.j);
  }
  return assigned.some((j) => j < 0) ? null : assigned;
}

/** Mean distance between two contours' segment starts, with `other` rotated by `r`. */
function rotationCost(a: P[], b: P[], r: number) {
  let sum = 0;
  const n = a.length;
  for (let i = 0; i < n; i++) {
    const p = a[i];
    const q = b[(i + r) % n];
    sum += Math.hypot(p.x - q.x, p.y - q.y);
  }
  return sum / n;
}

/** Above this mean normalised distance the "same" contour is a different drawing. */
const MAX_DRIFT = 0.35;

/**
 * Reorders `other`'s contours, start points and directions to correspond to
 * `base`. Returns null when the two cannot be matched segment for segment.
 */
export function alignContours(base: Contour[], baseFrame: Frame, other: Contour[], otherFrame: Frame): Contour[] | null {
  if (base.length !== other.length) return null;

  const stats = (c: Contour, f: Frame) =>
    statsOf(
      c.flatMap((seg) => [seg.start, ...seg.controls]),
      contourArea(c),
      c.length,
      f,
    );
  const assigned = pairContours(
    base.map((c) => stats(c, baseFrame)),
    other.map((c) => stats(c, otherFrame)),
  );
  if (!assigned) return null;

  const out: Contour[] = [];
  for (let i = 0; i < base.length; i++) {
    let o = other[assigned[i]];
    if (Math.sign(contourArea(o)) !== Math.sign(contourArea(base[i])) && contourArea(o) !== 0) o = reverseContour(o);

    const a = base[i].map((s) => norm(s.start, baseFrame));
    const b = o.map((s) => norm(s.start, otherFrame));
    let best = 0;
    let bestCost = rotationCost(a, b, 0);
    if (bestCost > 0.02) {
      for (let r = 1; r < a.length; r++) {
        const cost = rotationCost(a, b, r);
        if (cost < bestCost - 1e-9) {
          best = r;
          bestCost = cost;
        }
      }
    }
    if (bestCost > MAX_DRIFT) return null;
    out.push([...o.slice(best), ...o.slice(0, best)]);
  }
  return out;
}

function elevate(seg: Segment, end: P, degree: number): Segment {
  const have = seg.controls.length + 1;
  if (have >= degree) return seg;
  const p0 = seg.start;
  if (have === 1) {
    if (degree === 2) return { start: p0, controls: [mid(p0, end)] };
    return { start: p0, controls: [lerp(p0, end, 1 / 3), lerp(p0, end, 2 / 3)] };
  }
  // Quadratic → cubic is exact.
  const q = seg.controls[0];
  return { start: p0, controls: [lerp(p0, q, 2 / 3), lerp(end, q, 2 / 3)] };
}

/** Promotes every segment to the highest degree any of the sets uses there. */
export function harmonize(sets: Contour[][]): Contour[][] {
  return sets.map((set) =>
    set.map((contour, c) =>
      contour.map((seg, s) => {
        let degree = 1;
        for (const other of sets) degree = Math.max(degree, other[c][s].controls.length + 1);
        const end = contour[(s + 1) % contour.length].start;
        return elevate(seg, end, degree);
      }),
    ),
  );
}

/** Error bound of one quadratic standing in for a cubic: √3/36·|p0 − 3p1 + 3p2 − p3|. */
function piecesFor(p0: P, p1: P, p2: P, p3: P, tolerance: number) {
  const x = p0.x - 3 * p1.x + 3 * p2.x - p3.x;
  const y = p0.y - 3 * p1.y + 3 * p2.y - p3.y;
  const error = (Math.sqrt(3) / 36) * Math.hypot(x, y);
  if (error <= tolerance) return 1;
  return Math.min(16, Math.ceil(Math.cbrt(error / tolerance)));
}

/** The part of a cubic between t0 and t1. */
function subCubic(p0: P, p1: P, p2: P, p3: P, t0: number, t1: number): [P, P, P, P] {
  const split = (a: P, b: P, c: P, d: P, t: number) => {
    const ab = lerp(a, b, t);
    const bc = lerp(b, c, t);
    const cd = lerp(c, d, t);
    const abc = lerp(ab, bc, t);
    const bcd = lerp(bc, cd, t);
    const m = lerp(abc, bcd, t);
    return { left: [a, ab, abc, m] as [P, P, P, P], right: [m, bcd, cd, d] as [P, P, P, P] };
  };
  const right = t0 > 0 ? split(p0, p1, p2, p3, t0).right : ([p0, p1, p2, p3] as [P, P, P, P]);
  if (t1 >= 1) return right;
  return split(right[0], right[1], right[2], right[3], (t1 - t0) / (1 - t0)).left;
}

/**
 * Writes harmonised contour sets back out as quadratic glyph outlines with
 * identical structure. Cubic segments are split as finely as the most curved
 * master needs.
 */
export function emitTogether(sets: Contour[][], tolerance: number): { endPts: number[]; points: Point[] }[] {
  const first = sets[0];
  const pieces = first.map((contour, c) =>
    contour.map((seg, s) => {
      if (seg.controls.length < 2) return 1;
      let n = 1;
      for (const set of sets) {
        const cs = set[c];
        const sg = cs[s];
        n = Math.max(n, piecesFor(sg.start, sg.controls[0], sg.controls[1], cs[(s + 1) % cs.length].start, tolerance));
      }
      return n;
    }),
  );

  return sets.map((set) => {
    const points: Point[] = [];
    const endPts: number[] = [];
    set.forEach((contour, c) => {
      contour.forEach((seg, s) => {
        const end = contour[(s + 1) % contour.length].start;
        points.push({ x: seg.start.x, y: seg.start.y, on: true });
        if (seg.controls.length === 1) {
          points.push({ x: seg.controls[0].x, y: seg.controls[0].y, on: false });
        } else if (seg.controls.length === 2) {
          const count = pieces[c][s];
          for (let k = 0; k < count; k++) {
            const [a, b, cc, d] = subCubic(seg.start, seg.controls[0], seg.controls[1], end, k / count, (k + 1) / count);
            points.push({ x: (3 * (b.x + cc.x) - (a.x + d.x)) / 4, y: (3 * (b.y + cc.y) - (a.y + d.y)) / 4, on: false });
            if (k < count - 1) points.push({ x: d.x, y: d.y, on: true });
          }
        }
      });
      endPts.push(points.length - 1);
    });
    return { endPts, points: points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y), on: p.on })) };
  });
}

/** One cubic outline to quadratic. Malformed input keeps only its on-curve points. */
export function quadratize(glyph: Glyph, tolerance: number): Glyph {
  if (glyph.points.length === 0) return glyph;
  const contours = toContours(glyph, true);
  if (contours) {
    const [out] = emitTogether([contours], tolerance);
    return { ...glyph, ...out };
  }
  const points: Point[] = [];
  const endPts: number[] = [];
  let start = 0;
  for (const end of glyph.endPts) {
    const before = points.length;
    for (let i = start; i <= end; i++) if (glyph.points[i].on) points.push({ ...glyph.points[i] });
    if (points.length > before) endPts.push(points.length - 1);
    start = end + 1;
  }
  return { ...glyph, points, endPts };
}

/**
 * Reverses every contour while keeping its first point first. CFF draws outer
 * contours counter-clockwise; TrueType expects clockwise.
 */
export function reverseContours(glyph: Glyph): Glyph {
  const points: Point[] = [];
  let start = 0;
  for (const end of glyph.endPts) {
    const contour = glyph.points.slice(start, end + 1);
    points.push(contour[0], ...contour.slice(1).reverse());
    start = end + 1;
  }
  return { ...glyph, points };
}

/**
 * Point-level alignment for the common case: same contours, same point
 * pattern, possibly in another order or from another start point. Keeps the
 * source's own point structure, so nothing is added when it succeeds.
 */
export function alignPoints(base: Glyph, baseFrame: Frame, other: Glyph, otherFrame: Frame): Glyph | null {
  if (base.points.length !== other.points.length || base.endPts.length !== other.endPts.length) return null;
  if (base.points.length === 0) return { ...other, endPts: [], points: [] };

  const split = (g: Glyph) => {
    const out: Point[][] = [];
    let s = 0;
    for (const e of g.endPts) {
      out.push(g.points.slice(s, e + 1));
      s = e + 1;
    }
    return out;
  };
  const a = split(base);
  const b = split(other);
  const pattern = (c: Point[]) => c.map((p) => (p.on ? "1" : "0")).join("");

  // Fast path: identical structure in identical order with small drift.
  const winding = (c: Point[]) => {
    let sum = 0;
    for (let k = 0; k < c.length; k++) sum += c[k].x * c[(k + 1) % c.length].y - c[(k + 1) % c.length].x * c[k].y;
    return Math.sign(sum);
  };
  const sameOrder = a.every(
    (c, i) => c.length === b[i].length && pattern(c) === pattern(b[i]) && winding(c) === winding(b[i]),
  );
  if (sameOrder) {
    let drift = 0;
    for (let i = 0; i < base.points.length; i++) {
      const p = norm(base.points[i], baseFrame);
      const q = norm(other.points[i], otherFrame);
      drift += Math.hypot(p.x - q.x, p.y - q.y);
    }
    if (drift / base.points.length < 0.08) return { ...other, endPts: base.endPts.slice(), points: other.points.map((p) => ({ ...p })) };
  }

  // Otherwise pair contours, then find each start point by rotation.
  const area = (c: Point[]) => {
    let sum = 0;
    for (let k = 0; k < c.length; k++) {
      const p = c[k];
      const q = c[(k + 1) % c.length];
      sum += p.x * q.y - q.x * p.y;
    }
    return sum;
  };
  const assigned = pairContours(
    a.map((c) => statsOf(c, area(c), c.length, baseFrame)),
    b.map((c) => statsOf(c, area(c), c.length, otherFrame)),
  );
  if (!assigned) return null;

  const points: Point[] = [];
  for (let i = 0; i < a.length; i++) {
    const ca = a[i];
    let cb = b[assigned[i]];
    const n = ca.length;
    if (Math.sign(area(cb)) !== Math.sign(area(ca)) && area(cb) !== 0) cb = [cb[0], ...cb.slice(1).reverse()];

    const pa = ca.map((p) => norm(p, baseFrame));
    const pb = cb.map((p) => norm(p, otherFrame));
    let best = -1;
    let bestCost = Infinity;
    for (let r = 0; r < n; r++) {
      let ok = true;
      for (let k = 0; k < n && ok; k++) ok = ca[k].on === cb[(k + r) % n].on;
      if (!ok) continue;
      const cost = rotationCost(pa, pb, r);
      if (cost < bestCost - 1e-9) {
        best = r;
        bestCost = cost;
      }
    }
    if (best < 0 || bestCost > MAX_DRIFT) return null;
    for (let k = 0; k < n; k++) points.push({ ...cb[(k + best) % n] });
  }
  return { ...other, endPts: base.endPts.slice(), points };
}
