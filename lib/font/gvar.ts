import { Writer } from "./binary";
import type { Glyph } from "./glyf";

/** One synthetic master: a region in normalised axis space, plus its glyphs. */
export interface Master {
  /** Normalised coordinates (-1..1), one per axis, in fvar axis order. */
  peak: number[];
  /** Where this master starts contributing. */
  start: number[];
  /** Where it stops contributing. */
  end: number[];
  glyphs: Glyph[];
}

const INTERMEDIATE_REGION = 0x4000;
const PRIVATE_POINT_NUMBERS = 0x2000;

/**
 * A region only needs to be spelled out when it differs from the one implied
 * by the peak alone, which is `min(peak, 0) .. max(peak, 0)`.
 */
function needsIntermediate(master: Master, axisCount: number) {
  for (let a = 0; a < axisCount; a++) {
    const peak = master.peak[a] ?? 0;
    if ((master.start[a] ?? 0) !== Math.min(peak, 0)) return true;
    if ((master.end[a] ?? 0) !== Math.max(peak, 0)) return true;
  }
  return false;
}

const DELTAS_ARE_ZERO = 0x80;
const DELTAS_ARE_WORDS = 0x40;

/** Packs a delta run using the gvar run-length format. */
function packDeltas(deltas: number[]): Uint8Array {
  const w = new Writer(deltas.length * 2 + 16);
  let i = 0;

  while (i < deltas.length) {
    if (deltas[i] === 0) {
      let run = 0;
      while (i + run < deltas.length && deltas[i + run] === 0 && run < 64) run++;
      w.u8(DELTAS_ARE_ZERO | (run - 1));
      i += run;
      continue;
    }

    const needsWord = (v: number) => v < -128 || v > 127;
    if (needsWord(deltas[i])) {
      let run = 0;
      while (i + run < deltas.length && deltas[i + run] !== 0 && needsWord(deltas[i + run]) && run < 64) run++;
      w.u8(DELTAS_ARE_WORDS | (run - 1));
      for (let k = 0; k < run; k++) w.i16(deltas[i + k]);
      i += run;
      continue;
    }

    let run = 0;
    while (i + run < deltas.length && deltas[i + run] !== 0 && !needsWord(deltas[i + run]) && run < 64) run++;
    w.u8(run - 1);
    for (let k = 0; k < run; k++) w.i8(deltas[i + k]);
    i += run;
  }
  return w.toBytes();
}

/**
 * Deltas cover the glyph's own points plus the four phantom points, which is
 * how advance width and sidebearings vary along an axis.
 */
function glyphDeltas(base: Glyph, master: Glyph) {
  const n = base.points.length;
  const xs = new Array<number>(n + 4).fill(0);
  const ys = new Array<number>(n + 4).fill(0);

  for (let i = 0; i < n; i++) {
    xs[i] = Math.round(master.points[i].x) - Math.round(base.points[i].x);
    ys[i] = Math.round(master.points[i].y) - Math.round(base.points[i].y);
  }

  // p0: left sidebearing point, p1: advance point, p2/p3: vertical phantoms.
  xs[n] = 0;
  xs[n + 1] = Math.round(master.advance) - Math.round(base.advance);

  const allZero = xs.every((v) => v === 0) && ys.every((v) => v === 0);
  return { xs, ys, allZero };
}

/** Builds the gvar table from a default master and a list of synthetic masters. */
export function buildGvar(base: Glyph[], masters: Master[], axisCount: number): Uint8Array {
  const glyphCount = base.length;
  const perGlyph: Uint8Array[] = [];

  if (masters.length > 0x0fff) {
    throw new Error("Too many masters — a font can reference at most 4095 variation regions.");
  }

  const intermediate = masters.map((m) => needsIntermediate(m, axisCount));

  // Peaks go in the shared tuple array and headers reference them by index.
  // Embedding the peak in each header is legal but is not what shaping engines
  // are exercised against, and it costs `axisCount` extra words per glyph.
  const sharedTuples = masters.map((m) => m.peak);

  for (let gid = 0; gid < glyphCount; gid++) {
    const tuples: { index: number; intermediate: boolean; master: Master; data: Uint8Array }[] = [];

    masters.forEach((master, index) => {
      const { xs, ys, allZero } = glyphDeltas(base[gid], master.glyphs[gid]);
      if (allZero) return;

      const body = new Writer(xs.length * 3 + 32);
      body.u8(0); // packed point numbers: 0 = every point in the glyph
      body.bytes(packDeltas(xs));
      body.bytes(packDeltas(ys));
      tuples.push({ index, intermediate: intermediate[index], master, data: body.toBytes() });
    });

    if (tuples.length === 0) {
      perGlyph.push(new Uint8Array(0));
      continue;
    }

    let headerSize = 4;
    for (const t of tuples) headerSize += 4 + (t.intermediate ? axisCount * 4 : 0);

    const g = new Writer(headerSize + 256);
    g.u16(tuples.length);
    g.u16(headerSize); // dataOffset, relative to the start of this table

    for (const t of tuples) {
      g.u16(t.data.length);
      g.u16(t.index | PRIVATE_POINT_NUMBERS | (t.intermediate ? INTERMEDIATE_REGION : 0));
      if (t.intermediate) {
        for (let a = 0; a < axisCount; a++) g.f2dot14(t.master.start[a] ?? 0);
        for (let a = 0; a < axisCount; a++) g.f2dot14(t.master.end[a] ?? 0);
      }
    }
    for (const t of tuples) g.bytes(t.data);
    g.pad(2);
    perGlyph.push(g.toBytes());
  }

  const sharedTuplesOffset = 20 + (glyphCount + 1) * 4;
  const dataArrayOffset = sharedTuplesOffset + sharedTuples.length * axisCount * 2;

  const w = new Writer(dataArrayOffset + 4096);
  w.u16(1); // majorVersion
  w.u16(0); // minorVersion
  w.u16(axisCount);
  w.u16(sharedTuples.length);
  w.u32(sharedTuplesOffset);
  w.u16(glyphCount);
  w.u16(1); // flags: long (32-bit) offsets
  w.u32(dataArrayOffset);

  let running = 0;
  for (const g of perGlyph) {
    w.u32(running);
    running += g.length;
  }
  w.u32(running);

  for (const peak of sharedTuples) {
    for (let a = 0; a < axisCount; a++) w.f2dot14(peak[a] ?? 0);
  }

  for (const g of perGlyph) w.bytes(g);
  w.pad(4);
  return w.toBytes();
}
