import { Reader, Writer } from "./binary";
import { MAC_GLYPH_NAMES } from "./stdnames";

/**
 * Glyph names live in `post` format 2 (TrueType) or the CFF charset (`.otf`).
 * They are how glyphs are matched between the weights of a family, and they
 * are worth keeping in the export: type tools show them.
 */

const MAC_INDEX = new Map(MAC_GLYPH_NAMES.map((n, i) => [n, i]));

/** Glyph names from `post`, or null when the table carries none (format 3). */
export function parsePostNames(post: Uint8Array | undefined, numGlyphs: number): string[] | null {
  if (!post || post.length < 32) return null;
  const r = new Reader(post);
  const version = r.u32();

  if (version === 0x00010000) {
    return numGlyphs <= MAC_GLYPH_NAMES.length ? MAC_GLYPH_NAMES.slice(0, numGlyphs) : null;
  }
  if (version !== 0x00020000) return null;

  r.seek(32);
  const count = r.u16();
  const indices: number[] = [];
  for (let i = 0; i < count; i++) indices.push(r.u16());

  const custom: string[] = [];
  while (r.pos < post.length) {
    const length = r.u8();
    if (r.pos + length > post.length) break;
    custom.push(String.fromCharCode(...r.bytes(length)));
  }

  const names: string[] = [];
  for (let gid = 0; gid < numGlyphs; gid++) {
    const index = indices[gid];
    if (index === undefined) names.push(`glyph${gid}`);
    else if (index < 258) names.push(MAC_GLYPH_NAMES[index]);
    else names.push(custom[index - 258] ?? `glyph${gid}`);
  }
  return names;
}

/** `post.italicAngle` in degrees — negative leans right. */
export function italicAngle(post: Uint8Array | undefined): number {
  if (!post || post.length < 8) return 0;
  return new Reader(post, 4).i32() / 65536;
}

/** Writes `post` format 2 with these names, keeping the 32-byte header of `source`. */
export function buildPostWithNames(source: Uint8Array | undefined, names: string[]): Uint8Array {
  const w = new Writer(64 + names.length * 12);
  const header = new Uint8Array(32);
  if (source && source.length >= 32) header.set(source.subarray(0, 32));
  new DataView(header.buffer).setUint32(0, 0x00020000);
  w.bytes(header);

  w.u16(names.length);
  const custom: string[] = [];
  const customIndex = new Map<string, number>();
  for (const name of names) {
    const mac = MAC_INDEX.get(name);
    if (mac !== undefined) {
      w.u16(mac);
      continue;
    }
    let index = customIndex.get(name);
    if (index === undefined) {
      index = custom.length;
      custom.push(name);
      customIndex.set(name, index);
    }
    w.u16(258 + index);
  }
  for (const name of custom) {
    const ascii = name.replace(/[^\x21-\x7e]/g, "").slice(0, 63) || "glyph";
    w.u8(ascii.length);
    for (let i = 0; i < ascii.length; i++) w.u8(ascii.charCodeAt(i));
  }
  return w.toBytes();
}

/** Names that do not collide with any already in the font. */
export function uniqueNames(existing: string[], wanted: string[]): string[] {
  const taken = new Set(existing);
  return wanted.map((name) => {
    let candidate = name;
    for (let n = 1; taken.has(candidate); n++) candidate = `${name}.${n}`;
    taken.add(candidate);
    return candidate;
  });
}
