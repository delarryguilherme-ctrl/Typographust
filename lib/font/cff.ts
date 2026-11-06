import { Reader } from "./binary";
import type { Point } from "./glyf";
import { CFF_STANDARD_STRINGS, STANDARD_ENCODING } from "./stdnames";

/**
 * Reads CFF and CFF2 outlines (the `.otf` flavour) into cubic contours.
 *
 * The output uses the same point list as TrueType glyphs, except that every
 * off-curve point is a cubic control and they always come in pairs:
 * `on, off, off, on, …`. Contours are closed implicitly, exactly like glyf.
 * `curves.ts` turns these into quadratic TrueType outlines.
 *
 * CFF2 fonts are variable; only their default instance is read — `blend`
 * operands keep their default value and drop the deltas.
 */

export interface CubicOutline {
  endPts: number[];
  points: Point[];
}

export interface CffResult {
  outlines: CubicOutline[];
  /** Glyph names from the charset, or null for CFF2 (which has none). */
  names: string[] | null;
}

interface Index {
  items: Uint8Array[];
  end: number;
}

function readIndex(data: Uint8Array, pos: number, cff2: boolean): Index {
  const r = new Reader(data, pos);
  const count = cff2 ? r.u32() : r.u16();
  if (count === 0) return { items: [], end: r.pos };
  const offSize = r.u8();
  if (offSize < 1 || offSize > 4) throw new Error("CFF: invalid INDEX offset size.");

  const offsets: number[] = [];
  for (let i = 0; i <= count; i++) {
    let v = 0;
    for (let k = 0; k < offSize; k++) v = v * 256 + r.u8();
    offsets.push(v);
  }
  // Offsets are 1-based, relative to the byte before the object data.
  const base = r.pos - 1;
  const items: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const start = base + offsets[i];
    const end = base + offsets[i + 1];
    if (end > data.length || start > end) throw new Error("CFF: INDEX points outside the table.");
    items.push(data.subarray(start, end));
  }
  return { items, end: base + offsets[count] };
}

type Dict = Map<number, number[]>;

const REAL_NIBBLES = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "E", "E-", "", "-", ""];

function parseDict(bytes: Uint8Array): Dict {
  const dict: Dict = new Map();
  let operands: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i];
    if (b0 <= 21 || b0 === 23 || b0 === 24) {
      let op = b0;
      i++;
      if (b0 === 12) op = 1200 + bytes[i++];
      if (op === 23) {
        // CFF2 blend in a Private DICT. Only the values the editor reads
        // (Subrs) are never blended, so the blended operands are discarded.
        operands = [];
        continue;
      }
      dict.set(op, operands);
      operands = [];
    } else if (b0 === 28) {
      operands.push(((bytes[i + 1] << 24) >> 16) | bytes[i + 2]);
      i += 3;
    } else if (b0 === 29) {
      operands.push((bytes[i + 1] << 24) | (bytes[i + 2] << 16) | (bytes[i + 3] << 8) | bytes[i + 4]);
      i += 5;
    } else if (b0 === 30) {
      let s = "";
      i++;
      outer: while (i < bytes.length) {
        const b = bytes[i++];
        for (const nibble of [b >> 4, b & 15]) {
          if (nibble === 15) break outer;
          s += REAL_NIBBLES[nibble];
        }
      }
      operands.push(Number.parseFloat(s) || 0);
    } else if (b0 >= 32 && b0 <= 246) {
      operands.push(b0 - 139);
      i++;
    } else if (b0 >= 247 && b0 <= 250) {
      operands.push((b0 - 247) * 256 + bytes[i + 1] + 108);
      i += 2;
    } else if (b0 >= 251 && b0 <= 254) {
      operands.push(-(b0 - 251) * 256 - bytes[i + 1] - 108);
      i += 2;
    } else {
      i++; // reserved
    }
  }
  return dict;
}

function subrBias(count: number) {
  return count < 1240 ? 107 : count < 33900 ? 1131 : 32768;
}

interface PrivateInfo {
  subrs: Uint8Array[];
  vsindex: number;
}

function readPrivate(data: Uint8Array, size: number, offset: number, cff2: boolean): PrivateInfo {
  if (!size) return { subrs: [], vsindex: 0 };
  const dict = parseDict(data.subarray(offset, offset + size));
  const subrsOffset = dict.get(19)?.[0];
  const subrs = subrsOffset ? readIndex(data, offset + subrsOffset, cff2).items : [];
  return { subrs, vsindex: dict.get(22)?.[0] ?? 0 };
}

function readFdSelect(data: Uint8Array, pos: number, numGlyphs: number): Uint16Array {
  const r = new Reader(data, pos);
  const format = r.u8();
  const out = new Uint16Array(numGlyphs);
  if (format === 0) {
    for (let g = 0; g < numGlyphs; g++) out[g] = r.u8();
  } else if (format === 3 || format === 4) {
    const wide = format === 4;
    const nRanges = wide ? r.u32() : r.u16();
    let first = wide ? r.u32() : r.u16();
    for (let i = 0; i < nRanges; i++) {
      const fd = wide ? r.u16() : r.u8();
      const next = wide ? r.u32() : r.u16();
      for (let g = first; g < next && g < numGlyphs; g++) out[g] = fd;
      first = next;
    }
  } else {
    throw new Error(`CFF: unsupported FDSelect format ${format}.`);
  }
  return out;
}

function readCharset(data: Uint8Array, offset: number, numGlyphs: number, strings: Uint8Array[], cid: boolean): string[] {
  const name = (sid: number) => {
    if (cid) return sid === 0 ? ".notdef" : `cid${String(sid).padStart(5, "0")}`;
    if (sid < CFF_STANDARD_STRINGS.length) return CFF_STANDARD_STRINGS[sid];
    const bytes = strings[sid - CFF_STANDARD_STRINGS.length];
    return bytes ? String.fromCharCode(...bytes) : `glyph${sid}`;
  };

  const names = [".notdef"];
  if (offset <= 2) {
    // Predefined charsets. ISOAdobe (0) maps glyph n to SID n; the expert sets
    // are vanishingly rare in OpenType, so they fall back to the same rule.
    for (let g = 1; g < numGlyphs; g++) names.push(name(g));
    return names;
  }

  const r = new Reader(data, offset);
  const format = r.u8();
  if (format === 0) {
    while (names.length < numGlyphs) names.push(name(r.u16()));
  } else if (format === 1 || format === 2) {
    while (names.length < numGlyphs) {
      const first = r.u16();
      const left = format === 1 ? r.u8() : r.u16();
      for (let k = 0; k <= left && names.length < numGlyphs; k++) names.push(name(first + k));
    }
  } else {
    throw new Error(`CFF: unsupported charset format ${format}.`);
  }
  return names;
}

/** Number of variation regions each ItemVariationData in a CFF2 VariationStore blends over. */
function readRegionCounts(data: Uint8Array, offset: number): number[] {
  // The store is prefixed with its own uint16 length.
  const base = offset + 2;
  const r = new Reader(data, base);
  r.u16(); // format
  r.u32(); // regionListOffset
  const count = r.u16();
  const offsets: number[] = [];
  for (let i = 0; i < count; i++) offsets.push(r.u32());
  return offsets.map((o) => {
    const d = new Reader(data, base + o);
    d.u16(); // itemCount
    d.u16(); // wordDeltaCount
    return d.u16(); // regionIndexCount
  });
}

export function parseCff(table: Uint8Array): CffResult {
  const major = table[0];
  if (major === 2) return parseCff2(table);
  if (major !== 1) throw new Error(`CFF: unsupported version ${major}.`);

  const hdrSize = table[2];
  const names = readIndex(table, hdrSize, false);
  const topDicts = readIndex(table, names.end, false);
  const strings = readIndex(table, topDicts.end, false);
  const gsubrs = readIndex(table, strings.end, false).items;
  if (topDicts.items.length === 0) throw new Error("CFF: no Top DICT.");

  const top = parseDict(topDicts.items[0]);
  if ((top.get(1206)?.[0] ?? 2) !== 2) throw new Error("CFF: only Type 2 charstrings are supported.");
  const charStringsOffset = top.get(17)?.[0];
  if (charStringsOffset === undefined) throw new Error("CFF: no CharStrings.");
  const charStrings = readIndex(table, charStringsOffset, false).items;
  const numGlyphs = charStrings.length;

  const isCid = top.has(1230);
  let privates: PrivateInfo[];
  let fdSelect: Uint16Array | null = null;

  if (isCid) {
    const fdArray = readIndex(table, top.get(1236)![0], false).items;
    privates = fdArray.map((fd) => {
      const [size, offset] = parseDict(fd).get(18) ?? [0, 0];
      return readPrivate(table, size, offset, false);
    });
    fdSelect = readFdSelect(table, top.get(1237)![0], numGlyphs);
  } else {
    const [size, offset] = top.get(18) ?? [0, 0];
    privates = [readPrivate(table, size, offset, false)];
  }

  const glyphNames = readCharset(table, top.get(15)?.[0] ?? 0, numGlyphs, strings.items, isCid);
  const byName = new Map<string, number>();
  glyphNames.forEach((n, gid) => {
    if (!byName.has(n)) byName.set(n, gid);
  });

  const outlines: CubicOutline[] = [];
  const cache = new Map<number, CubicOutline>();

  const outlineOf = (gid: number, depth: number): CubicOutline => {
    const cached = cache.get(gid);
    if (cached) return cached;
    const priv = privates[fdSelect ? fdSelect[gid] : 0] ?? privates[0];
    const result = runCharstring(charStrings[gid], {
      gsubrs,
      lsubrs: priv.subrs,
      cff2: false,
      regionCount: () => 0,
      vsindex: 0,
      seac: (code) => {
        if (depth > 2) return null;
        const gidForCode = byName.get(STANDARD_ENCODING[code] ?? "");
        return gidForCode === undefined ? null : outlineOf(gidForCode, depth + 1);
      },
    });
    cache.set(gid, result);
    return result;
  };

  for (let gid = 0; gid < numGlyphs; gid++) outlines.push(outlineOf(gid, 0));
  return { outlines, names: glyphNames };
}

function parseCff2(table: Uint8Array): CffResult {
  const r = new Reader(table);
  r.u8(); // major
  r.u8(); // minor
  const headerSize = r.u8();
  const topDictLength = r.u16();
  const top = parseDict(table.subarray(headerSize, headerSize + topDictLength));
  const gsubrs = readIndex(table, headerSize + topDictLength, true).items;

  const charStringsOffset = top.get(17)?.[0];
  if (charStringsOffset === undefined) throw new Error("CFF2: no CharStrings.");
  const charStrings = readIndex(table, charStringsOffset, true).items;
  const numGlyphs = charStrings.length;

  const vstore = top.get(24)?.[0];
  const regionCounts = vstore ? readRegionCounts(table, vstore) : [];

  const fdArrayOffset = top.get(1236)?.[0];
  if (fdArrayOffset === undefined) throw new Error("CFF2: no FDArray.");
  const privates = readIndex(table, fdArrayOffset, true).items.map((fd) => {
    const [size, offset] = parseDict(fd).get(18) ?? [0, 0];
    return readPrivate(table, size, offset, true);
  });
  const fdSelectOffset = top.get(1237)?.[0];
  const fdSelect = fdSelectOffset !== undefined && privates.length > 1 ? readFdSelect(table, fdSelectOffset, numGlyphs) : null;

  const outlines: CubicOutline[] = [];
  for (let gid = 0; gid < numGlyphs; gid++) {
    const priv = privates[fdSelect ? fdSelect[gid] : 0] ?? privates[0];
    outlines.push(
      runCharstring(charStrings[gid], {
        gsubrs,
        lsubrs: priv.subrs,
        cff2: true,
        regionCount: (vsindex) => regionCounts[vsindex] ?? 0,
        vsindex: priv.vsindex,
        seac: () => null,
      }),
    );
  }
  return { outlines, names: null };
}

interface RunOptions {
  gsubrs: Uint8Array[];
  lsubrs: Uint8Array[];
  cff2: boolean;
  regionCount: (vsindex: number) => number;
  vsindex: number;
  /** Resolves a StandardEncoding code to an outline, for the deprecated `seac` accent form. */
  seac: (code: number) => CubicOutline | null;
}

class PathBuilder {
  contours: Point[][] = [];
  private current: Point[] | null = null;
  x = 0;
  y = 0;

  moveTo(dx: number, dy: number) {
    this.close();
    this.x += dx;
    this.y += dy;
    this.current = [{ x: this.x, y: this.y, on: true }];
  }

  lineTo(dx: number, dy: number) {
    if (!this.current) this.moveTo(0, 0);
    this.x += dx;
    this.y += dy;
    this.current!.push({ x: this.x, y: this.y, on: true });
  }

  curveTo(dx1: number, dy1: number, dx2: number, dy2: number, dx3: number, dy3: number) {
    if (!this.current) this.moveTo(0, 0);
    const c1x = this.x + dx1;
    const c1y = this.y + dy1;
    const c2x = c1x + dx2;
    const c2y = c1y + dy2;
    this.x = c2x + dx3;
    this.y = c2y + dy3;
    this.current!.push({ x: c1x, y: c1y, on: false }, { x: c2x, y: c2y, on: false }, { x: this.x, y: this.y, on: true });
  }

  close() {
    const c = this.current;
    this.current = null;
    if (!c || c.length < 2) return;
    // The path usually returns to its start explicitly; glyf closes implicitly.
    const first = c[0];
    const last = c[c.length - 1];
    if (c.length > 1 && last.on && last.x === first.x && last.y === first.y) c.pop();
    if (c.length >= 2) this.contours.push(c);
  }
}

function runCharstring(code: Uint8Array, opts: RunOptions): CubicOutline {
  const path = new PathBuilder();
  const stack: number[] = [];
  const transient: number[] = [];
  let nStems = 0;
  let haveWidth = opts.cff2; // CFF2 charstrings carry no width
  let vsindex = opts.vsindex;
  let done = false;
  let depth = 0;
  let seacParts: { adx: number; ady: number; base: number; accent: number } | null = null;

  const takeWidth = (evenWhenWidthPresent: boolean) => {
    if (!haveWidth && evenWhenWidthPresent) stack.shift();
    haveWidth = true;
  };
  const stems = () => {
    takeWidth(stack.length % 2 === 1);
    nStems += stack.length >> 1;
    stack.length = 0;
  };

  const exec = (bytes: Uint8Array) => {
    if (++depth > 12) throw new Error("CFF: subroutines nest too deeply.");
    let i = 0;
    while (i < bytes.length && !done) {
      const b0 = bytes[i++];
      if (b0 >= 32 || b0 === 28) {
        if (b0 === 28) {
          stack.push(((bytes[i] << 24) >> 16) | bytes[i + 1]);
          i += 2;
        } else if (b0 <= 246) {
          stack.push(b0 - 139);
        } else if (b0 <= 250) {
          stack.push((b0 - 247) * 256 + bytes[i++] + 108);
        } else if (b0 <= 254) {
          stack.push(-(b0 - 251) * 256 - bytes[i++] - 108);
        } else {
          const v = (bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3];
          stack.push(v / 65536);
          i += 4;
        }
        continue;
      }

      switch (b0) {
        case 1: // hstem
        case 3: // vstem
        case 18: // hstemhm
        case 23: // vstemhm
          stems();
          break;
        case 19: // hintmask
        case 20: // cntrmask
          // Arguments here are an implicit vstemhm.
          stems();
          i += (nStems + 7) >> 3;
          break;
        case 21: // rmoveto
          takeWidth(stack.length > 2);
          path.moveTo(stack[0], stack[1]);
          stack.length = 0;
          break;
        case 22: // hmoveto
          takeWidth(stack.length > 1);
          path.moveTo(stack[0], 0);
          stack.length = 0;
          break;
        case 4: // vmoveto
          takeWidth(stack.length > 1);
          path.moveTo(0, stack[0]);
          stack.length = 0;
          break;
        case 5: // rlineto
          for (let k = 0; k + 1 < stack.length; k += 2) path.lineTo(stack[k], stack[k + 1]);
          stack.length = 0;
          break;
        case 6: // hlineto
        case 7: {
          // vlineto
          let horizontal = b0 === 6;
          for (const v of stack) {
            if (horizontal) path.lineTo(v, 0);
            else path.lineTo(0, v);
            horizontal = !horizontal;
          }
          stack.length = 0;
          break;
        }
        case 8: // rrcurveto
          for (let k = 0; k + 5 < stack.length; k += 6) {
            path.curveTo(stack[k], stack[k + 1], stack[k + 2], stack[k + 3], stack[k + 4], stack[k + 5]);
          }
          stack.length = 0;
          break;
        case 24: {
          // rcurveline
          let k = 0;
          for (; k + 5 < stack.length - 2; k += 6) {
            path.curveTo(stack[k], stack[k + 1], stack[k + 2], stack[k + 3], stack[k + 4], stack[k + 5]);
          }
          path.lineTo(stack[k], stack[k + 1]);
          stack.length = 0;
          break;
        }
        case 25: {
          // rlinecurve
          let k = 0;
          for (; k + 1 < stack.length - 6; k += 2) path.lineTo(stack[k], stack[k + 1]);
          path.curveTo(stack[k], stack[k + 1], stack[k + 2], stack[k + 3], stack[k + 4], stack[k + 5]);
          stack.length = 0;
          break;
        }
        case 26: {
          // vvcurveto
          let k = 0;
          let dx1 = 0;
          if (stack.length % 2 === 1) dx1 = stack[k++];
          for (; k + 3 < stack.length; k += 4) {
            path.curveTo(dx1, stack[k], stack[k + 1], stack[k + 2], 0, stack[k + 3]);
            dx1 = 0;
          }
          stack.length = 0;
          break;
        }
        case 27: {
          // hhcurveto
          let k = 0;
          let dy1 = 0;
          if (stack.length % 2 === 1) dy1 = stack[k++];
          for (; k + 3 < stack.length; k += 4) {
            path.curveTo(stack[k], dy1, stack[k + 1], stack[k + 2], stack[k + 3], 0);
            dy1 = 0;
          }
          stack.length = 0;
          break;
        }
        case 30: // vhcurveto
        case 31: {
          // hvcurveto
          let horizontal = b0 === 31;
          let k = 0;
          while (k + 3 < stack.length) {
            const last = stack.length - (k + 4) === 1;
            const extra = last ? stack[k + 4] : 0;
            if (horizontal) path.curveTo(stack[k], 0, stack[k + 1], stack[k + 2], extra, stack[k + 3]);
            else path.curveTo(0, stack[k], stack[k + 1], stack[k + 2], stack[k + 3], extra);
            k += last ? 5 : 4;
            horizontal = !horizontal;
          }
          stack.length = 0;
          break;
        }
        case 10: // callsubr
        case 29: {
          // callgsubr
          const subrs = b0 === 10 ? opts.lsubrs : opts.gsubrs;
          const index = stack.pop()! + subrBias(subrs.length);
          const subr = subrs[index];
          if (!subr) throw new Error("CFF: call to a missing subroutine.");
          exec(subr);
          break;
        }
        case 11: // return
          depth--;
          return;
        case 14: // endchar
          if (!opts.cff2) {
            if (stack.length === 5 || stack.length === 1) takeWidth(true);
            if (stack.length === 4) {
              seacParts = { adx: stack[0], ady: stack[1], base: stack[2], accent: stack[3] };
            }
          }
          stack.length = 0;
          done = true;
          break;
        case 15: // vsindex (CFF2)
          vsindex = stack.pop() ?? 0;
          stack.length = 0;
          break;
        case 16: {
          // blend (CFF2): keep the n default values, drop the n×k deltas.
          const n = stack.pop() ?? 0;
          const k = opts.regionCount(vsindex);
          stack.splice(stack.length - n * k, n * k);
          break;
        }
        case 12: {
          const op = bytes[i++];
          escape(op);
          break;
        }
        default:
          // Reserved operators clear the stack, which is the safest guess.
          stack.length = 0;
      }
    }
    depth--;
  };

  const escape = (op: number) => {
    const s = stack;
    switch (op) {
      case 35: // flex
        path.curveTo(s[0], s[1], s[2], s[3], s[4], s[5]);
        path.curveTo(s[6], s[7], s[8], s[9], s[10], s[11]);
        s.length = 0;
        return;
      case 34: // hflex
        path.curveTo(s[0], 0, s[1], s[2], s[3], 0);
        path.curveTo(s[4], 0, s[5], -s[2], s[6], 0);
        s.length = 0;
        return;
      case 36: // hflex1
        path.curveTo(s[0], s[1], s[2], s[3], s[4], 0);
        path.curveTo(s[5], 0, s[6], s[7], s[8], -(s[1] + s[3] + s[7]));
        s.length = 0;
        return;
      case 37: {
        // flex1
        const dx = s[0] + s[2] + s[4] + s[6] + s[8];
        const dy = s[1] + s[3] + s[5] + s[7] + s[9];
        path.curveTo(s[0], s[1], s[2], s[3], s[4], s[5]);
        if (Math.abs(dx) > Math.abs(dy)) path.curveTo(s[6], s[7], s[8], s[9], s[10], -dy);
        else path.curveTo(s[6], s[7], s[8], s[9], -dx, s[10]);
        s.length = 0;
        return;
      }
      // Arithmetic — legal but almost never used by real fonts.
      case 3: // and
        s.push(s.pop()! && s.pop()! ? 1 : 0);
        return;
      case 4: {
        const b = s.pop()!;
        const a = s.pop()!;
        s.push(a || b ? 1 : 0);
        return;
      }
      case 5:
        s.push(s.pop()! ? 0 : 1);
        return;
      case 9:
        s.push(Math.abs(s.pop()!));
        return;
      case 10:
        s.push(s.pop()! + s.pop()!);
        return;
      case 11: {
        const b = s.pop()!;
        s.push(s.pop()! - b);
        return;
      }
      case 12: {
        const b = s.pop()!;
        const a = s.pop()!;
        s.push(b === 0 ? 0 : a / b);
        return;
      }
      case 14:
        s.push(-s.pop()!);
        return;
      case 15:
        s.push(s.pop()! === s.pop()! ? 1 : 0);
        return;
      case 18:
        s.pop();
        return;
      case 20: {
        const index = s.pop()!;
        transient[index] = s.pop()!;
        return;
      }
      case 21:
        s.push(transient[s.pop()!] ?? 0);
        return;
      case 22: {
        const v2 = s.pop()!;
        const v1 = s.pop()!;
        const s2 = s.pop()!;
        const s1 = s.pop()!;
        s.push(v1 <= v2 ? s1 : s2);
        return;
      }
      case 23:
        s.push(Math.random());
        return;
      case 24:
        s.push(s.pop()! * s.pop()!);
        return;
      case 26:
        s.push(Math.sqrt(Math.abs(s.pop()!)));
        return;
      case 27:
        s.push(s[s.length - 1]);
        return;
      case 28: {
        const b = s.pop()!;
        const a = s.pop()!;
        s.push(b, a);
        return;
      }
      case 29: {
        let index = s.pop()!;
        if (index < 0) index = 0;
        s.push(s[s.length - 1 - index] ?? 0);
        return;
      }
      case 30: {
        const j = s.pop()!;
        const n = s.pop()!;
        if (n > 0 && n <= s.length) {
          const part = s.splice(s.length - n, n);
          const shift = ((j % n) + n) % n;
          s.push(...part.slice(n - shift), ...part.slice(0, n - shift));
        }
        return;
      }
      default:
        s.length = 0;
    }
  };

  exec(code);
  path.close();

  const contours = path.contours;
  if (seacParts) {
    // Deprecated accented-character form: base glyph plus an offset accent.
    const { adx, ady, base, accent } = seacParts as { adx: number; ady: number; base: number; accent: number };
    for (const [code, ox, oy] of [
      [base, 0, 0],
      [accent, adx, ady],
    ] as const) {
      const part = opts.seac(code);
      if (!part) continue;
      let start = 0;
      for (const end of part.endPts) {
        contours.push(part.points.slice(start, end + 1).map((p) => ({ x: p.x + ox, y: p.y + oy, on: p.on })));
        start = end + 1;
      }
    }
  }

  const endPts: number[] = [];
  const points: Point[] = [];
  for (const c of contours) {
    points.push(...c);
    endPts.push(points.length - 1);
  }
  return { endPts, points };
}
