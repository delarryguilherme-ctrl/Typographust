/**
 * A minimal ZIP writer using the "stored" method — no compression.
 *
 * Fonts are already dense and this is a local download, so the few hundred
 * kilobytes deflate would save are not worth pulling in a compression library.
 * Everything here is little-endian, unlike the rest of the font code.
 */

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS date and time, which is what a ZIP entry stores. */
function dosStamp(date: Date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

class LittleEndian {
  private parts: Uint8Array[] = [];
  length = 0;

  u16(v: number) {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v & 0xffff, true);
    return this.push(b);
  }

  u32(v: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, true);
    return this.push(b);
  }

  bytes(b: Uint8Array) {
    return this.push(b);
  }

  private push(b: Uint8Array) {
    this.parts.push(b);
    this.length += b.length;
    return this;
  }

  concat() {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

export function buildZip(entries: ZipEntry[], now = new Date()): Uint8Array {
  const { time, day } = dosStamp(now);
  const encoder = new TextEncoder();

  const body = new LittleEndian();
  const central = new LittleEndian();

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const offset = body.length;

    body.u32(0x04034b50); // local file header
    body.u16(20); // version needed
    body.u16(0); // flags
    body.u16(0); // method: stored
    body.u16(time);
    body.u16(day);
    body.u32(crc);
    body.u32(entry.data.length);
    body.u32(entry.data.length);
    body.u16(name.length);
    body.u16(0); // extra length
    body.bytes(name);
    body.bytes(entry.data);

    central.u32(0x02014b50); // central directory header
    central.u16(20); // version made by
    central.u16(20); // version needed
    central.u16(0); // flags
    central.u16(0); // method
    central.u16(time);
    central.u16(day);
    central.u32(crc);
    central.u32(entry.data.length);
    central.u32(entry.data.length);
    central.u16(name.length);
    central.u16(0); // extra
    central.u16(0); // comment
    central.u16(0); // disk number
    central.u16(0); // internal attributes
    central.u32(0); // external attributes
    central.u32(offset);
    central.bytes(name);
  }

  const out = new LittleEndian();
  out.bytes(body.concat());
  const centralBytes = central.concat();
  out.bytes(centralBytes);

  out.u32(0x06054b50); // end of central directory
  out.u16(0); // this disk
  out.u16(0); // disk with central directory
  out.u16(entries.length);
  out.u16(entries.length);
  out.u32(centralBytes.length);
  out.u32(body.length);
  out.u16(0); // comment length

  return out.concat();
}
