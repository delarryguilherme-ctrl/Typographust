import { Reader, Writer } from "./binary";
import type { TableMap } from "./sfnt";

export interface Point {
  x: number;
  y: number;
  /** True for on-curve points, false for quadratic control points. */
  on: boolean;
}

export interface Glyph {
  /** Index of the last point of each contour. */
  endPts: number[];
  points: Point[];
  advance: number;
  lsb: number;
}

const ARG_1_AND_2_ARE_WORDS = 0x0001;
const ARGS_ARE_XY_VALUES = 0x0002;
const WE_HAVE_A_SCALE = 0x0008;
const MORE_COMPONENTS = 0x0020;
const WE_HAVE_AN_X_AND_Y_SCALE = 0x0040;
const WE_HAVE_A_TWO_BY_TWO = 0x0080;
const WE_HAVE_INSTRUCTIONS = 0x0100;

const ON_CURVE = 0x01;
const X_SHORT = 0x02;
const Y_SHORT = 0x04;
const REPEAT_FLAG = 0x08;
const X_SAME_OR_POSITIVE = 0x10;
const Y_SAME_OR_POSITIVE = 0x20;

export interface FontMetrics {
  unitsPerEm: number;
  numGlyphs: number;
  ascender: number;
  descender: number;
}

/** Reads head/maxp/hhea fields needed to interpret the outline tables. */
export function readMetrics(tables: TableMap): FontMetrics & { indexToLocFormat: number } {
  const head = tables.get("head");
  const maxp = tables.get("maxp");
  const hhea = tables.get("hhea");
  if (!head || !maxp || !hhea) throw new Error("Font is missing head, maxp or hhea.");

  const h = new Reader(head);
  h.seek(18);
  const unitsPerEm = h.u16();
  h.seek(50);
  const indexToLocFormat = h.i16();

  const m = new Reader(maxp);
  m.seek(4);
  const numGlyphs = m.u16();

  const a = new Reader(hhea);
  a.seek(4);
  const ascender = a.i16();
  const descender = a.i16();

  return { unitsPerEm, numGlyphs, ascender, descender, indexToLocFormat };
}

function readLoca(tables: TableMap, numGlyphs: number, indexToLocFormat: number) {
  const loca = tables.get("loca");
  if (!loca) throw new Error("Font has no 'loca' table (not a TrueType outline font).");
  const r = new Reader(loca);
  const offsets: number[] = [];
  for (let i = 0; i <= numGlyphs; i++) {
    offsets.push(indexToLocFormat === 0 ? r.u16() * 2 : r.u32());
  }
  return offsets;
}

function readHmtx(tables: TableMap, numGlyphs: number) {
  const hhea = tables.get("hhea")!;
  const hr = new Reader(hhea);
  hr.seek(34);
  const numberOfHMetrics = hr.u16();

  const hmtx = tables.get("hmtx");
  const advances = new Array<number>(numGlyphs).fill(0);
  const lsbs = new Array<number>(numGlyphs).fill(0);
  if (!hmtx) return { advances, lsbs };

  const r = new Reader(hmtx);
  let last = 0;
  for (let i = 0; i < numGlyphs; i++) {
    if (i < numberOfHMetrics) {
      last = r.u16();
      advances[i] = last;
      lsbs[i] = r.i16();
    } else {
      advances[i] = last;
      lsbs[i] = r.pos + 2 <= hmtx.length ? r.i16() : 0;
    }
  }
  return { advances, lsbs };
}

/**
 * Parses every glyph, decomposing composites into plain contours.
 *
 * Decomposition is what makes the rest of the pipeline tractable: gvar deltas
 * must line up point-for-point across masters, and outline transforms only
 * preserve that structure on simple glyphs.
 */
export function parseGlyphs(tables: TableMap): { glyphs: Glyph[]; metrics: FontMetrics } {
  const { unitsPerEm, numGlyphs, ascender, descender, indexToLocFormat } = readMetrics(tables);
  const loca = readLoca(tables, numGlyphs, indexToLocFormat);
  const glyf = tables.get("glyf");
  if (!glyf) throw new Error("Font has no 'glyf' table (not a TrueType outline font).");
  const { advances, lsbs } = readHmtx(tables, numGlyphs);

  const cache = new Map<number, { endPts: number[]; points: Point[] }>();

  const readOutline = (gid: number, depth: number): { endPts: number[]; points: Point[] } => {
    if (depth > 8) return { endPts: [], points: [] };
    const cached = cache.get(gid);
    if (cached) return cached;

    const start = loca[gid];
    const end = loca[gid + 1];
    if (gid >= numGlyphs || end <= start) {
      const empty = { endPts: [], points: [] };
      cache.set(gid, empty);
      return empty;
    }

    const r = new Reader(glyf, start);
    const numberOfContours = r.i16();
    r.skip(8); // bounding box, recomputed on write

    let result: { endPts: number[]; points: Point[] };
    if (numberOfContours >= 0) {
      result = readSimpleGlyph(r, numberOfContours);
    } else {
      result = readCompositeGlyph(r, depth, readOutline);
    }
    cache.set(gid, result);
    return result;
  };

  const glyphs: Glyph[] = [];
  for (let gid = 0; gid < numGlyphs; gid++) {
    const outline = readOutline(gid, 0);
    glyphs.push({
      endPts: outline.endPts.slice(),
      points: outline.points.map((p) => ({ ...p })),
      advance: advances[gid],
      lsb: lsbs[gid],
    });
  }

  return { glyphs, metrics: { unitsPerEm, numGlyphs, ascender, descender } };
}

function readSimpleGlyph(r: Reader, numberOfContours: number) {
  const endPts: number[] = [];
  for (let i = 0; i < numberOfContours; i++) endPts.push(r.u16());
  const numPoints = numberOfContours > 0 ? endPts[numberOfContours - 1] + 1 : 0;

  const instructionLength = r.u16();
  r.skip(instructionLength);

  const flags: number[] = [];
  while (flags.length < numPoints) {
    const flag = r.u8();
    flags.push(flag);
    if (flag & REPEAT_FLAG) {
      const repeat = r.u8();
      for (let i = 0; i < repeat; i++) flags.push(flag);
    }
  }

  const points: Point[] = [];
  let x = 0;
  for (let i = 0; i < numPoints; i++) {
    const flag = flags[i];
    if (flag & X_SHORT) {
      const d = r.u8();
      x += flag & X_SAME_OR_POSITIVE ? d : -d;
    } else if (!(flag & X_SAME_OR_POSITIVE)) {
      x += r.i16();
    }
    points.push({ x, y: 0, on: (flag & ON_CURVE) !== 0 });
  }

  let y = 0;
  for (let i = 0; i < numPoints; i++) {
    const flag = flags[i];
    if (flag & Y_SHORT) {
      const d = r.u8();
      y += flag & Y_SAME_OR_POSITIVE ? d : -d;
    } else if (!(flag & Y_SAME_OR_POSITIVE)) {
      y += r.i16();
    }
    points[i].y = y;
  }

  return { endPts: endPts.slice(0, numberOfContours), points };
}

function readCompositeGlyph(
  r: Reader,
  depth: number,
  readOutline: (gid: number, depth: number) => { endPts: number[]; points: Point[] },
) {
  const endPts: number[] = [];
  const points: Point[] = [];
  let flags = MORE_COMPONENTS;

  while (flags & MORE_COMPONENTS) {
    flags = r.u16();
    const glyphIndex = r.u16();

    let dx = 0;
    let dy = 0;
    if (flags & ARG_1_AND_2_ARE_WORDS) {
      const a1 = r.i16();
      const a2 = r.i16();
      if (flags & ARGS_ARE_XY_VALUES) {
        dx = a1;
        dy = a2;
      }
    } else {
      const a1 = r.i8();
      const a2 = r.i8();
      if (flags & ARGS_ARE_XY_VALUES) {
        dx = a1;
        dy = a2;
      }
    }

    let a = 1;
    let b = 0;
    let c = 0;
    let d = 1;
    if (flags & WE_HAVE_A_SCALE) {
      a = d = r.f2dot14();
    } else if (flags & WE_HAVE_AN_X_AND_Y_SCALE) {
      a = r.f2dot14();
      d = r.f2dot14();
    } else if (flags & WE_HAVE_A_TWO_BY_TWO) {
      a = r.f2dot14();
      b = r.f2dot14();
      c = r.f2dot14();
      d = r.f2dot14();
    }

    const sub = readOutline(glyphIndex, depth + 1);
    const base = points.length;
    for (const p of sub.points) {
      points.push({ x: a * p.x + c * p.y + dx, y: b * p.x + d * p.y + dy, on: p.on });
    }
    for (const e of sub.endPts) endPts.push(base + e);
  }

  if (flags & WE_HAVE_INSTRUCTIONS) {
    // Instructions are dropped: decomposed outlines can't run the original hints.
  }
  return { endPts, points };
}

export function glyphBounds(g: Glyph) {
  if (g.points.length === 0) return { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
  let xMin = Infinity;
  let yMin = Infinity;
  let xMax = -Infinity;
  let yMax = -Infinity;
  for (const p of g.points) {
    if (p.x < xMin) xMin = p.x;
    if (p.y < yMin) yMin = p.y;
    if (p.x > xMax) xMax = p.x;
    if (p.y > yMax) yMax = p.y;
  }
  return { xMin: Math.round(xMin), yMin: Math.round(yMin), xMax: Math.round(xMax), yMax: Math.round(yMax) };
}

/** Serialises one glyph as a simple (non-composite) glyf entry. */
export function writeGlyph(g: Glyph): Uint8Array {
  if (g.points.length === 0 || g.endPts.length === 0) return new Uint8Array(0);

  const w = new Writer(g.points.length * 5 + 64);
  const bounds = glyphBounds(g);
  w.i16(g.endPts.length);
  w.i16(bounds.xMin);
  w.i16(bounds.yMin);
  w.i16(bounds.xMax);
  w.i16(bounds.yMax);
  for (const e of g.endPts) w.u16(e);
  w.u16(0); // instructionLength

  const coords = g.points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y), on: p.on }));

  const flags: number[] = [];
  const xs: number[] = [];
  const ys: number[] = [];
  let prevX = 0;
  let prevY = 0;

  for (const p of coords) {
    let flag = p.on ? ON_CURVE : 0;
    const dx = p.x - prevX;
    const dy = p.y - prevY;
    prevX = p.x;
    prevY = p.y;

    if (dx === 0) {
      flag |= X_SAME_OR_POSITIVE;
    } else if (dx >= -255 && dx <= 255) {
      flag |= X_SHORT;
      if (dx > 0) flag |= X_SAME_OR_POSITIVE;
      xs.push(Math.abs(dx));
    } else {
      xs.push(dx);
    }

    if (dy === 0) {
      flag |= Y_SAME_OR_POSITIVE;
    } else if (dy >= -255 && dy <= 255) {
      flag |= Y_SHORT;
      if (dy > 0) flag |= Y_SAME_OR_POSITIVE;
      ys.push(Math.abs(dy));
    } else {
      ys.push(dy);
    }
    flags.push(flag);
  }

  // Run-length encode identical consecutive flags.
  for (let i = 0; i < flags.length; ) {
    const flag = flags[i];
    let run = 1;
    while (i + run < flags.length && flags[i + run] === flag && run < 256) run++;
    if (run > 1) {
      w.u8(flag | REPEAT_FLAG);
      w.u8(run - 1);
    } else {
      w.u8(flag);
    }
    i += run;
  }

  let xi = 0;
  for (const flag of flags) {
    if (flag & X_SHORT) w.u8(xs[xi++]);
    else if (!(flag & X_SAME_OR_POSITIVE)) w.i16(xs[xi++]);
  }
  let yi = 0;
  for (const flag of flags) {
    if (flag & Y_SHORT) w.u8(ys[yi++]);
    else if (!(flag & Y_SAME_OR_POSITIVE)) w.i16(ys[yi++]);
  }

  w.pad(2);
  return w.toBytes();
}
