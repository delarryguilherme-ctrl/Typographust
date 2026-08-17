/**
 * Minimal big-endian binary reader/writer used by the SFNT parser and builder.
 */

export class Reader {
  readonly view: DataView;
  readonly data: Uint8Array;
  pos = 0;

  constructor(data: Uint8Array, offset = 0) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.pos = offset;
  }

  seek(pos: number) {
    this.pos = pos;
    return this;
  }

  skip(n: number) {
    this.pos += n;
    return this;
  }

  u8() {
    return this.view.getUint8(this.pos++);
  }

  i8() {
    return this.view.getInt8(this.pos++);
  }

  u16() {
    const v = this.view.getUint16(this.pos);
    this.pos += 2;
    return v;
  }

  i16() {
    const v = this.view.getInt16(this.pos);
    this.pos += 2;
    return v;
  }

  u32() {
    const v = this.view.getUint32(this.pos);
    this.pos += 4;
    return v;
  }

  i32() {
    const v = this.view.getInt32(this.pos);
    this.pos += 4;
    return v;
  }

  /** F2Dot14 fixed point, used by variation tuples and component scales. */
  f2dot14() {
    return this.i16() / 16384;
  }

  tag() {
    let s = "";
    for (let i = 0; i < 4; i++) s += String.fromCharCode(this.u8());
    return s;
  }

  bytes(n: number) {
    const out = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

export class Writer {
  private buf: Uint8Array;
  private view: DataView;
  private len = 0;

  constructor(capacity = 1024) {
    this.buf = new Uint8Array(capacity);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(extra: number) {
    if (this.len + extra <= this.buf.length) return;
    let next = this.buf.length * 2;
    while (next < this.len + extra) next *= 2;
    const grown = new Uint8Array(next);
    grown.set(this.buf.subarray(0, this.len));
    this.buf = grown;
    this.view = new DataView(grown.buffer);
  }

  get length() {
    return this.len;
  }

  u8(v: number) {
    this.ensure(1);
    this.view.setUint8(this.len++, v & 0xff);
    return this;
  }

  i8(v: number) {
    this.ensure(1);
    this.view.setInt8(this.len++, v);
    return this;
  }

  u16(v: number) {
    this.ensure(2);
    this.view.setUint16(this.len, v & 0xffff);
    this.len += 2;
    return this;
  }

  i16(v: number) {
    this.ensure(2);
    this.view.setInt16(this.len, v);
    this.len += 2;
    return this;
  }

  u32(v: number) {
    this.ensure(4);
    this.view.setUint32(this.len, v >>> 0);
    this.len += 4;
    return this;
  }

  i32(v: number) {
    this.ensure(4);
    this.view.setInt32(this.len, v);
    this.len += 4;
    return this;
  }

  /** 16.16 fixed point. */
  fixed(v: number) {
    return this.i32(Math.round(v * 65536));
  }

  f2dot14(v: number) {
    return this.i16(Math.round(v * 16384));
  }

  tag(t: string) {
    const padded = (t + "    ").slice(0, 4);
    for (let i = 0; i < 4; i++) this.u8(padded.charCodeAt(i));
    return this;
  }

  bytes(b: Uint8Array) {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
    return this;
  }

  /** Pads with zeros until the length is a multiple of `align`. */
  pad(align = 4) {
    while (this.len % align !== 0) this.u8(0);
    return this;
  }

  /** Overwrites a previously written uint32 (used for back-patched offsets). */
  patchU32(at: number, v: number) {
    this.view.setUint32(at, v >>> 0);
  }

  patchU16(at: number, v: number) {
    this.view.setUint16(at, v & 0xffff);
  }

  toBytes() {
    return this.buf.slice(0, this.len);
  }
}
