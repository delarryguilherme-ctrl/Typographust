import { Reader, Writer } from "./binary";

export interface NameRecord {
  platformID: number;
  encodingID: number;
  languageID: number;
  nameID: number;
  value: string;
}

function decodeUtf16Be(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
  }
  return s;
}

function decodeAscii(bytes: Uint8Array) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

export function parseName(table: Uint8Array | undefined): NameRecord[] {
  if (!table || table.length < 6) return [];
  const r = new Reader(table);
  r.u16(); // format
  const count = r.u16();
  const stringOffset = r.u16();

  const records: NameRecord[] = [];
  for (let i = 0; i < count; i++) {
    const platformID = r.u16();
    const encodingID = r.u16();
    const languageID = r.u16();
    const nameID = r.u16();
    const length = r.u16();
    const offset = r.u16();
    const start = stringOffset + offset;
    if (start + length > table.length) continue;
    const bytes = table.subarray(start, start + length);
    const isUtf16 = platformID === 3 || platformID === 0;
    records.push({
      platformID,
      encodingID,
      languageID,
      nameID,
      value: isUtf16 ? decodeUtf16Be(bytes) : decodeAscii(bytes),
    });
  }
  return records;
}

/** Picks the most usable string for a name ID, preferring Windows English. */
export function getName(records: NameRecord[], nameID: number): string | undefined {
  const windows = records.find(
    (r) => r.nameID === nameID && r.platformID === 3 && r.encodingID === 1 && r.languageID === 0x409,
  );
  if (windows) return windows.value;
  return records.find((r) => r.nameID === nameID)?.value;
}

const isAsciiOnly = (s: string) => /^[\x20-\x7e]*$/.test(s);

/** Writes a format-0 name table with Windows (and, where safe, Mac) records. */
export function buildName(entries: Map<number, string>): Uint8Array {
  const records: { platformID: number; encodingID: number; languageID: number; nameID: number; bytes: Uint8Array }[] =
    [];

  const ids = [...entries.keys()].sort((a, b) => a - b);
  for (const nameID of ids) {
    const value = entries.get(nameID)!;

    if (isAsciiOnly(value)) {
      const mac = new Uint8Array(value.length);
      for (let i = 0; i < value.length; i++) mac[i] = value.charCodeAt(i);
      records.push({ platformID: 1, encodingID: 0, languageID: 0, nameID, bytes: mac });
    }

    const utf16 = new Uint8Array(value.length * 2);
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      utf16[i * 2] = code >> 8;
      utf16[i * 2 + 1] = code & 0xff;
    }
    records.push({ platformID: 3, encodingID: 1, languageID: 0x409, nameID, bytes: utf16 });
  }

  // Records must be sorted by platform, encoding, language, then name ID.
  records.sort(
    (a, b) =>
      a.platformID - b.platformID ||
      a.encodingID - b.encodingID ||
      a.languageID - b.languageID ||
      a.nameID - b.nameID,
  );

  const storage = new Writer(1024);
  const offsets: number[] = [];
  for (const rec of records) {
    offsets.push(storage.length);
    storage.bytes(rec.bytes);
  }

  const stringOffset = 6 + records.length * 12;
  const w = new Writer(stringOffset + storage.length + 4);
  w.u16(0); // format
  w.u16(records.length);
  w.u16(stringOffset);
  records.forEach((rec, i) => {
    w.u16(rec.platformID);
    w.u16(rec.encodingID);
    w.u16(rec.languageID);
    w.u16(rec.nameID);
    w.u16(rec.bytes.length);
    w.u16(offsets[i]);
  });
  w.bytes(storage.toBytes());
  w.pad(4);
  return w.toBytes();
}

/** Strips characters that are illegal in a PostScript name. */
export function postScriptSafe(s: string) {
  return (
    s
      .replace(/[^\x21-\x7e]/g, "")
      .replace(/[[\]{}()<>/%]/g, "")
      .slice(0, 63) || "Font"
  );
}
