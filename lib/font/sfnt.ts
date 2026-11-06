import { Writer } from "./binary";

export type TableMap = Map<string, Uint8Array>;

function checksum(bytes: Uint8Array) {
  let sum = 0;
  const full = Math.floor(bytes.length / 4) * 4;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < full; i += 4) sum = (sum + view.getUint32(i)) >>> 0;

  // Trailing bytes are treated as if the table were zero-padded to 4 bytes.
  if (full < bytes.length) {
    let tail = 0;
    for (let i = 0; i < 4; i++) {
      tail = (tail << 8) | (full + i < bytes.length ? bytes[full + i] : 0);
    }
    sum = (sum + tail) >>> 0;
  }
  return sum;
}

/**
 * Serialises tables back into a font file, recomputing every table checksum
 * and `head.checkSumAdjustment`.
 */
export function buildSfnt(tables: TableMap): Uint8Array {
  // Tag order must be ascending in the directory.
  const tags = [...tables.keys()].sort();
  const numTables = tags.length;

  const entrySelector = Math.floor(Math.log2(numTables));
  const searchRange = 2 ** entrySelector * 16;
  const rangeShift = numTables * 16 - searchRange;

  const w = new Writer(1 << 20);
  w.u32(0x00010000);
  w.u16(numTables);
  w.u16(searchRange);
  w.u16(entrySelector);
  w.u16(rangeShift);

  const dirEntryAt = new Map<string, number>();
  for (const tag of tags) {
    dirEntryAt.set(tag, w.length);
    w.tag(tag);
    w.u32(0); // checksum
    w.u32(0); // offset
    w.u32(0); // length
  }

  let headOffset = -1;
  for (const tag of tags) {
    w.pad(4);
    const offset = w.length;
    const bytes = tables.get(tag)!;
    if (tag === "head") headOffset = offset;
    w.bytes(bytes);

    const entry = dirEntryAt.get(tag)!;
    w.patchU32(entry + 4, checksum(bytes));
    w.patchU32(entry + 8, offset);
    w.patchU32(entry + 12, bytes.length);
  }
  w.pad(4);

  const out = w.toBytes();

  if (headOffset >= 0) {
    // checkSumAdjustment must be zeroed before the whole-file checksum is taken.
    const outView = new DataView(out.buffer, out.byteOffset, out.byteLength);
    outView.setUint32(headOffset + 8, 0);
    const adjustment = (0xb1b0afba - checksum(out)) >>> 0;
    outView.setUint32(headOffset + 8, adjustment);
  }
  return out;
}
