import { Reader, Writer } from "./binary";
import type { TableMap } from "./sfnt";
import { writeGlyph, type Glyph, type Point } from "./glyf";

/**
 * Unwraps whatever the user dropped into plain sfnt table maps.
 *
 * Every modern container is a different packaging of the same tables: WOFF
 * zlib-compresses each one, WOFF2 Brotli-compresses them all together and
 * re-encodes `glyf`/`loca`/`hmtx`, and a collection shares tables between
 * several fonts. Everything downstream only ever sees the unwrapped tables.
 */

export type Outlines = "glyf" | "CFF" | "CFF2";

export interface RawFace {
  tables: TableMap;
  outlines: Outlines;
  /** Human-readable packaging, e.g. "WOFF2 · CFF". */
  format: string;
  /** Position inside a collection, and how many fonts it holds (1 for a plain font). */
  index: number;
  count: number;
}

const SFNT_TRUETYPE = 0x00010000;
const SFNT_TRUE = 0x74727565; // 'true' — old Apple TrueType
const SFNT_OTTO = 0x4f54544f; // 'OTTO' — CFF outlines
const TTCF = 0x74746366; // 'ttcf'
const WOFF = 0x774f4646; // 'wOFF'
const WOFF2 = 0x774f4632; // 'wOF2'

export async function unpackFontFile(data: Uint8Array): Promise<RawFace[]> {
  if (data.length < 12) throw new Error("This file is too small to be a font.");
  const signature = new Reader(data).u32();

  switch (signature) {
    case SFNT_TRUETYPE:
    case SFNT_TRUE:
    case SFNT_OTTO:
      return [face(readTableDirectory(data, 0), "", 0, 1)];
    case TTCF:
      return readCollection(data);
    case WOFF:
      return [await readWoff(data)];
    case WOFF2:
      return readWoff2(data);
    default:
      throw new Error(
        "Not a font this editor can read. Supported: .ttf, .otf, .woff, .woff2, .ttc and .otc.",
      );
  }
}

function face(tables: TableMap, container: string, index: number, count: number): RawFace {
  const outlines: Outlines = tables.has("glyf") ? "glyf" : tables.has("CFF2") ? "CFF2" : tables.has("CFF ") ? "CFF" : "glyf";
  if (!tables.has("glyf") && !tables.has("CFF ") && !tables.has("CFF2")) {
    throw new Error(
      "This font has no outlines — it is bitmap- or SVG-only, so there is nothing to make variable.",
    );
  }
  const kind = outlines === "glyf" ? "TrueType" : outlines;
  return { tables, outlines, format: container ? `${container} · ${kind}` : kind, index, count };
}

/** Reads one sfnt table directory. Table offsets are absolute within `data`. */
export function readTableDirectory(data: Uint8Array, offset: number): TableMap {
  const r = new Reader(data, offset);
  const version = r.u32();
  if (version !== SFNT_TRUETYPE && version !== SFNT_TRUE && version !== SFNT_OTTO) {
    throw new Error("Not a recognised OpenType font file.");
  }

  const numTables = r.u16();
  r.skip(6); // searchRange, entrySelector, rangeShift

  const tables: TableMap = new Map();
  for (let i = 0; i < numTables; i++) {
    const tag = r.tag();
    r.u32(); // checksum, recomputed on write
    const tableOffset = r.u32();
    const length = r.u32();
    if (tableOffset + length > data.length) {
      throw new Error(`Table '${tag}' is truncated — the file looks corrupt.`);
    }
    tables.set(tag, data.subarray(tableOffset, tableOffset + length));
  }
  return tables;
}

function readCollection(data: Uint8Array): RawFace[] {
  const r = new Reader(data);
  r.skip(4); // 'ttcf'
  r.skip(4); // major, minor version
  const numFonts = r.u32();
  if (numFonts === 0 || numFonts > 1024) throw new Error("This collection lists no usable fonts.");

  const offsets: number[] = [];
  for (let i = 0; i < numFonts; i++) offsets.push(r.u32());

  return offsets.map((offset, i) => {
    const tables = readTableDirectory(data, offset);
    const otc = tables.has("CFF ") || tables.has("CFF2");
    return face(tables, otc ? "OTC" : "TTC", i, numFonts);
  });
}

// --- WOFF 1 -----------------------------------------------------------------

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  // WOFF uses zlib-wrapped deflate, which is what the "deflate" format means
  // here ("deflate-raw" is the unwrapped one).
  const stream = new Blob([bytes.slice().buffer as ArrayBuffer]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readWoff(data: Uint8Array): Promise<RawFace> {
  const r = new Reader(data);
  r.skip(4); // signature
  r.u32(); // flavor
  r.u32(); // length
  const numTables = r.u16();
  r.skip(2 + 4 + 4 + 4 * 5); // reserved, totalSfntSize, version, meta/private blocks

  const entries: { tag: string; offset: number; compLength: number; origLength: number }[] = [];
  for (let i = 0; i < numTables; i++) {
    const tag = r.tag();
    const offset = r.u32();
    const compLength = r.u32();
    const origLength = r.u32();
    r.u32(); // origChecksum
    if (offset + compLength > data.length) throw new Error(`WOFF table '${tag}' is truncated.`);
    entries.push({ tag, offset, compLength, origLength });
  }

  const tables: TableMap = new Map();
  for (const e of entries) {
    const stored = data.subarray(e.offset, e.offset + e.compLength);
    // A table is stored uncompressed whenever compressing would not have helped.
    const bytes = e.compLength < e.origLength ? await inflate(stored) : stored;
    if (bytes.length !== e.origLength) throw new Error(`WOFF table '${e.tag}' did not decompress to its declared size.`);
    tables.set(e.tag, bytes);
  }
  return face(tables, "WOFF", 0, 1);
}

// --- WOFF 2 -----------------------------------------------------------------

/** Tags WOFF2 can name by a 6-bit index instead of spelling out. Order is normative. */
export const WOFF2_KNOWN_TAGS = [
  "cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf", "loca", "prep",
  "CFF ", "VORG", "EBDT", "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE",
  "GDEF", "GPOS", "GSUB", "EBSC", "JSTF", "MATH", "CBDT", "CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt",
  "avar", "bdat", "bloc", "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar", "gvar", "hsty", "just", "lcar",
  "mort", "morx", "opbd", "prop", "trak", "Zapf", "Silf", "Glat", "Gloc", "Feat", "Sill",
];

function uintBase128(r: Reader) {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const byte = r.u8();
    if (i === 0 && byte === 0x80) throw new Error("WOFF2: malformed number (leading zero).");
    if (value & 0xfe000000) throw new Error("WOFF2: number overflows 32 bits.");
    value = (value << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) return value >>> 0;
  }
  throw new Error("WOFF2: number longer than five bytes.");
}

function uint255(r: Reader) {
  const code = r.u8();
  if (code === 253) return r.u16();
  if (code === 255) return r.u8() + 253;
  if (code === 254) return r.u8() + 506;
  return code;
}

interface Woff2Entry {
  tag: string;
  transformed: boolean;
  origLength: number;
  length: number;
  offset: number;
}

async function brotli(bytes: Uint8Array, outSize: number): Promise<Uint8Array> {
  // Loaded on demand: the decoder carries its own dictionary, and nothing else
  // in the app needs it.
  const { decompress } = await import("brotli/decompress");
  const out = decompress(bytes, outSize);
  if (!out || out.length !== outSize) throw new Error("WOFF2: the compressed data did not decode to its declared size.");
  return out;
}

async function readWoff2(data: Uint8Array): Promise<RawFace[]> {
  const r = new Reader(data);
  r.skip(4); // signature
  const flavor = r.u32();
  r.u32(); // length
  const numTables = r.u16();
  r.u16(); // reserved
  r.u32(); // totalSfntSize
  const totalCompressedSize = r.u32();
  r.skip(4 + 4 * 5); // version, meta and private blocks

  const entries: Woff2Entry[] = [];
  let streamOffset = 0;
  for (let i = 0; i < numTables; i++) {
    const flags = r.u8();
    const tagIndex = flags & 0x3f;
    const tag = tagIndex === 63 ? r.tag() : WOFF2_KNOWN_TAGS[tagIndex];
    if (!tag) throw new Error("WOFF2: unknown table index.");
    const version = (flags >> 6) & 3;
    const origLength = uintBase128(r);
    // glyf/loca use version 0 for "transformed"; every other table uses 0 for "as is".
    const transformed = tag === "glyf" || tag === "loca" ? version === 0 : version !== 0;
    const length = transformed ? uintBase128(r) : origLength;
    entries.push({ tag, transformed, origLength, length, offset: streamOffset });
    streamOffset += length;
  }

  // A collection lists which of the shared tables each font uses.
  let fonts: number[][] = [entries.map((_, i) => i)];
  if (flavor === TTCF) {
    r.u32(); // collection version
    const numFonts = uint255(r);
    fonts = [];
    for (let f = 0; f < numFonts; f++) {
      const count = uint255(r);
      r.u32(); // flavor
      const indices: number[] = [];
      for (let i = 0; i < count; i++) indices.push(uint255(r));
      fonts.push(indices);
    }
  }

  if (r.pos + totalCompressedSize > data.length) throw new Error("WOFF2: the compressed stream is truncated.");
  const stream = await brotli(data.subarray(r.pos, r.pos + totalCompressedSize), streamOffset);
  const raw = (e: Woff2Entry) => stream.subarray(e.offset, e.offset + e.length);

  // Transformed tables can be shared between fonts in a collection, so each is
  // reconstructed once.
  const glyfCache = new Map<number, GlyfReconstruction>();

  return fonts.map((indices, fontIndex) => {
    const own = indices.map((i) => entries[i]);
    const byTag = new Map(own.map((e) => [e.tag, e]));
    const tables: TableMap = new Map();

    for (const e of own) {
      if (!e.transformed) tables.set(e.tag, raw(e));
    }

    const glyf = byTag.get("glyf");
    if (glyf?.transformed) {
      const index = entries.indexOf(glyf);
      let rebuilt = glyfCache.get(index);
      if (!rebuilt) {
        rebuilt = reconstructGlyf(raw(glyf));
        glyfCache.set(index, rebuilt);
      }
      tables.set("glyf", rebuilt.glyf);
      tables.set("loca", rebuilt.loca);

      // The rebuilt loca is always the long format.
      const head = tables.get("head");
      if (head) {
        const copy = head.slice();
        new DataView(copy.buffer).setInt16(50, 1);
        tables.set("head", copy);
      }

      const hmtx = byTag.get("hmtx");
      if (hmtx?.transformed) tables.set("hmtx", reconstructHmtx(raw(hmtx), tables, rebuilt.xMins));
    } else {
      const hmtx = byTag.get("hmtx");
      if (hmtx?.transformed) throw new Error("WOFF2: hmtx is transformed but glyf is not.");
    }

    const container = flavor === TTCF ? "WOFF2 collection" : "WOFF2";
    return face(tables, container, fontIndex, fonts.length);
  });
}

interface GlyfReconstruction {
  glyf: Uint8Array;
  loca: Uint8Array;
  xMins: number[];
}

const ARG_1_AND_2_ARE_WORDS = 0x0001;
const WE_HAVE_A_SCALE = 0x0008;
const MORE_COMPONENTS = 0x0020;
const WE_HAVE_AN_X_AND_Y_SCALE = 0x0040;
const WE_HAVE_A_TWO_BY_TWO = 0x0080;
const WE_HAVE_INSTRUCTIONS = 0x0100;

/**
 * Rebuilds plain glyf/loca from WOFF2's transformed glyf, which splits the
 * table into parallel streams and packs coordinates as variable-length
 * triplets. Instructions are dropped — the editor discards hinting anyway.
 */
function reconstructGlyf(data: Uint8Array): GlyfReconstruction {
  const r = new Reader(data);
  r.u16(); // reserved
  const optionFlags = r.u16();
  const numGlyphs = r.u16();
  r.u16(); // indexFormat — the rebuilt loca is always long
  const sizes: number[] = [];
  for (let i = 0; i < 7; i++) sizes.push(r.u32());

  let at = r.pos;
  const slice = (n: number) => {
    if (at + n > data.length) throw new Error("WOFF2: transformed glyf is truncated.");
    const s = data.subarray(at, at + n);
    at += n;
    return s;
  };
  const nContour = new Reader(slice(sizes[0]));
  const nPoints = new Reader(slice(sizes[1]));
  const flagStream = slice(sizes[2]);
  const glyphStream = new Reader(slice(sizes[3]));
  const composite = new Reader(slice(sizes[4]));
  const bboxStream = slice(sizes[5]);
  const instructions = new Reader(slice(sizes[6]));
  void optionFlags; // the overlap bitmap, if present, is not needed

  const bitmapLength = 4 * Math.floor((numGlyphs + 31) / 32);
  const bboxBitmap = bboxStream.subarray(0, bitmapLength);
  const bbox = new Reader(bboxStream, bitmapLength);
  let flagPos = 0;

  const glyf = new Writer(data.length * 2);
  const offsets: number[] = [];
  const xMins: number[] = [];

  for (let gid = 0; gid < numGlyphs; gid++) {
    offsets.push(glyf.length);
    const contours = nContour.i16();
    const hasBbox = (bboxBitmap[gid >> 3] & (0x80 >> (gid & 7))) !== 0;

    if (contours === 0) {
      xMins.push(0);
      continue;
    }

    if (contours < 0) {
      // Composite: component records are copied verbatim, the bbox is explicit.
      const start = composite.pos;
      let flags = MORE_COMPONENTS;
      let hasInstructions = false;
      while (flags & MORE_COMPONENTS) {
        flags = composite.u16();
        composite.u16(); // glyphIndex
        composite.skip(flags & ARG_1_AND_2_ARE_WORDS ? 4 : 2);
        if (flags & WE_HAVE_A_SCALE) composite.skip(2);
        else if (flags & WE_HAVE_AN_X_AND_Y_SCALE) composite.skip(4);
        else if (flags & WE_HAVE_A_TWO_BY_TWO) composite.skip(8);
        if (flags & WE_HAVE_INSTRUCTIONS) hasInstructions = true;
      }
      const records = composite.data.subarray(start, composite.pos);
      if (!hasBbox) throw new Error("WOFF2: a composite glyph has no bounding box.");
      const box = [bbox.i16(), bbox.i16(), bbox.i16(), bbox.i16()];

      glyf.i16(-1);
      for (const v of box) glyf.i16(v);
      glyf.bytes(records);
      if (hasInstructions) {
        const length = uint255(glyphStream);
        glyf.u16(length);
        glyf.bytes(instructions.bytes(length));
      }
      glyf.pad(4);
      xMins.push(box[0]);
      continue;
    }

    const endPts: number[] = [];
    let total = 0;
    for (let c = 0; c < contours; c++) {
      total += uint255(nPoints);
      endPts.push(total - 1);
    }

    const points: Point[] = [];
    let x = 0;
    let y = 0;
    for (let i = 0; i < total; i++) {
      const raw = flagStream[flagPos++];
      const on = (raw & 0x80) === 0;
      const flag = raw & 0x7f;
      let dx: number;
      let dy: number;
      if (flag < 10) {
        dx = 0;
        dy = withSign(flag, ((flag & 14) << 7) + glyphStream.u8());
      } else if (flag < 20) {
        dx = withSign(flag, (((flag - 10) & 14) << 7) + glyphStream.u8());
        dy = 0;
      } else if (flag < 84) {
        const b0 = flag - 20;
        const b1 = glyphStream.u8();
        dx = withSign(flag, 1 + (b0 & 0x30) + (b1 >> 4));
        dy = withSign(flag >> 1, 1 + ((b0 & 0x0c) << 2) + (b1 & 0x0f));
      } else if (flag < 120) {
        const b0 = flag - 84;
        const b1 = glyphStream.u8();
        const b2 = glyphStream.u8();
        dx = withSign(flag, 1 + (Math.floor(b0 / 12) << 8) + b1);
        dy = withSign(flag >> 1, 1 + (((b0 % 12) >> 2) << 8) + b2);
      } else if (flag < 124) {
        const b1 = glyphStream.u8();
        const b2 = glyphStream.u8();
        const b3 = glyphStream.u8();
        dx = withSign(flag, (b1 << 4) + (b2 >> 4));
        dy = withSign(flag >> 1, ((b2 & 0x0f) << 8) + b3);
      } else {
        const b1 = glyphStream.u8();
        const b2 = glyphStream.u8();
        const b3 = glyphStream.u8();
        const b4 = glyphStream.u8();
        dx = withSign(flag, (b1 << 8) + b2);
        dy = withSign(flag >> 1, (b3 << 8) + b4);
      }
      x += dx;
      y += dy;
      points.push({ x, y, on });
    }

    const instructionLength = uint255(glyphStream);
    instructions.skip(instructionLength);
    if (hasBbox) bbox.skip(8);

    const glyph: Glyph = { endPts, points, advance: 0, lsb: 0 };
    glyf.bytes(writeGlyph(glyph));
    glyf.pad(4);
    xMins.push(points.length ? Math.min(...points.map((p) => p.x)) : 0);
  }
  offsets.push(glyf.length);

  const loca = new Writer(offsets.length * 4);
  for (const o of offsets) loca.u32(o);
  return { glyf: glyf.toBytes(), loca: loca.toBytes(), xMins };
}

function withSign(flag: number, value: number) {
  return flag & 1 ? value : -value;
}

/** Rebuilds hmtx, filling in sidebearings WOFF2 dropped because they equal xMin. */
function reconstructHmtx(data: Uint8Array, tables: TableMap, xMins: number[]): Uint8Array {
  const hhea = tables.get("hhea");
  const maxp = tables.get("maxp");
  if (!hhea || !maxp) throw new Error("WOFF2: hmtx is transformed but hhea or maxp is missing.");
  const numHMetrics = new Reader(hhea, 34).u16();
  const numGlyphs = new Reader(maxp, 4).u16();

  const r = new Reader(data);
  const flags = r.u8();
  const advances: number[] = [];
  for (let i = 0; i < numHMetrics; i++) advances.push(r.u16());

  const lsbs: number[] = [];
  for (let i = 0; i < numHMetrics; i++) lsbs.push(flags & 1 ? (xMins[i] ?? 0) : r.i16());
  for (let i = numHMetrics; i < numGlyphs; i++) lsbs.push(flags & 2 ? (xMins[i] ?? 0) : r.i16());

  const w = new Writer(numGlyphs * 4);
  for (let i = 0; i < numGlyphs; i++) {
    if (i < numHMetrics) w.u16(advances[i]);
    w.i16(lsbs[i]);
  }
  return w.toBytes();
}
