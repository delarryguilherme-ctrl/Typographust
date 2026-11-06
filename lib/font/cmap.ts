import { Reader } from "./binary";

/**
 * Reads the font's Unicode mapping (code point → glyph id).
 *
 * Only one subtable is needed: the most complete Unicode one, falling back to
 * BMP-only, then symbol, then the old Mac Roman table.
 */
export function parseCmap(table: Uint8Array | undefined): Map<number, number> {
  const out = new Map<number, number>();
  if (!table || table.length < 4) return out;

  const r = new Reader(table);
  r.u16(); // version
  const count = r.u16();
  const records: { platform: number; encoding: number; offset: number }[] = [];
  for (let i = 0; i < count; i++) {
    records.push({ platform: r.u16(), encoding: r.u16(), offset: r.u32() });
  }

  const rank = (p: number, e: number) => {
    if ((p === 3 && e === 10) || (p === 0 && (e === 4 || e === 6))) return 0;
    if ((p === 3 && e === 1) || (p === 0 && e <= 3)) return 1;
    if (p === 3 && e === 0) return 2;
    if (p === 1 && e === 0) return 3;
    return 9;
  };

  const usable = records
    .filter((rec) => rec.offset + 2 <= table.length && rank(rec.platform, rec.encoding) < 9)
    .sort((a, b) => rank(a.platform, a.encoding) - rank(b.platform, b.encoding));

  for (const rec of usable) {
    try {
      readSubtable(table, rec.offset, out);
    } catch {
      continue;
    }
    if (out.size > 0) {
      // Symbol fonts map their glyphs into U+F0xx; mirror them at their
      // ASCII positions so digits and letters can still be found.
      if (rec.platform === 3 && rec.encoding === 0) {
        for (const [cp, gid] of [...out]) {
          if (cp >= 0xf020 && cp <= 0xf0ff && !out.has(cp - 0xf000)) out.set(cp - 0xf000, gid);
        }
      }
      return out;
    }
  }
  return out;
}

function readSubtable(table: Uint8Array, offset: number, out: Map<number, number>) {
  const r = new Reader(table, offset);
  const format = r.u16();

  if (format === 4) {
    r.u16(); // length
    r.u16(); // language
    const segCount = r.u16() / 2;
    r.skip(6);
    const ends: number[] = [];
    for (let i = 0; i < segCount; i++) ends.push(r.u16());
    r.u16(); // reservedPad
    const starts: number[] = [];
    for (let i = 0; i < segCount; i++) starts.push(r.u16());
    const deltas: number[] = [];
    for (let i = 0; i < segCount; i++) deltas.push(r.i16());
    const rangeOffsetsAt = r.pos;
    const rangeOffsets: number[] = [];
    for (let i = 0; i < segCount; i++) rangeOffsets.push(r.u16());

    for (let s = 0; s < segCount; s++) {
      for (let c = starts[s]; c <= ends[s] && c !== 0xffff; c++) {
        let gid: number;
        if (rangeOffsets[s] === 0) {
          gid = (c + deltas[s]) & 0xffff;
        } else {
          const at = rangeOffsetsAt + s * 2 + rangeOffsets[s] + (c - starts[s]) * 2;
          if (at + 2 > table.length) continue;
          gid = new Reader(table, at).u16();
          if (gid !== 0) gid = (gid + deltas[s]) & 0xffff;
        }
        if (gid !== 0) out.set(c, gid);
      }
    }
  } else if (format === 12 || format === 13) {
    r.u16(); // reserved
    r.u32(); // length
    r.u32(); // language
    const groups = r.u32();
    for (let g = 0; g < groups; g++) {
      const start = r.u32();
      const end = r.u32();
      const first = r.u32();
      if (end - start > 0x10ffff) continue;
      for (let c = start; c <= end; c++) {
        const gid = format === 12 ? first + (c - start) : first;
        if (gid !== 0) out.set(c, gid);
      }
    }
  } else if (format === 6) {
    r.u16(); // length
    r.u16(); // language
    const first = r.u16();
    const entries = r.u16();
    for (let i = 0; i < entries; i++) {
      const gid = r.u16();
      if (gid !== 0) out.set(first + i, gid);
    }
  } else if (format === 0) {
    r.u16(); // length
    r.u16(); // language
    for (let c = 0; c < 256; c++) {
      const gid = r.u8();
      if (gid !== 0) out.set(c, gid);
    }
  }
}
