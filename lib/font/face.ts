import { Reader } from "./binary";
import type { RawFace } from "./container";
import { parseCff } from "./cff";
import { parseCmap } from "./cmap";
import { parseGlyphs, readHmtx, readMetrics, type Glyph } from "./glyf";
import { getName, parseName } from "./name";
import { italicAngle, parsePostNames } from "./post";
import { reverseContours } from "./curves";
import { inferWeight, measureStem } from "./stem";
import type { TableMap } from "./sfnt";

/**
 * One uploaded font, read and measured, before it is assigned a role in the
 * family. A family is assembled from one or more of these in `family.ts`.
 */
export interface SourceFace {
  id: string;
  fileName: string;
  fileSize: number;
  /** e.g. "WOFF2 · TrueType", "OTF · CFF". */
  format: string;
  /** Position inside a collection; `count` is 1 for a plain font. */
  index: number;
  count: number;

  tables: TableMap;
  /** Outlines as drawn. Cubic for CFF sources (off-curve points come in pairs). */
  glyphs: Glyph[];
  cubic: boolean;
  names: string[] | null;
  cmap: Map<number, number>;

  upem: number;
  ascender: number;
  descender: number;

  familyName: string;
  subfamilyName: string;
  version: string;

  /** usWeightClass as declared. */
  declaredWeight: number;
  /** Measured stem and the weight the drawing suggests. */
  stem: number;
  measuredWeight: number;
  italic: boolean;
  /** post.italicAngle, degrees; negative leans right. */
  italicAngle: number;
  widthClass: number;
  isVariable: boolean;
}

let faceCounter = 0;

export function readFace(raw: RawFace, fileName: string, fileSize: number): SourceFace {
  const { tables } = raw;
  const metrics = readMetrics(tables);

  let glyphs: Glyph[];
  let names: string[] | null;
  if (raw.outlines === "glyf") {
    glyphs = parseGlyphs(tables).glyphs;
    names = parsePostNames(tables.get("post"), metrics.numGlyphs);
  } else {
    const cff = parseCff(tables.get(raw.outlines === "CFF2" ? "CFF2" : "CFF ")!);
    const { advances, lsbs } = readHmtx(tables, metrics.numGlyphs);
    glyphs = [];
    for (let gid = 0; gid < metrics.numGlyphs; gid++) {
      const outline = cff.outlines[gid] ?? { endPts: [], points: [] };
      // TrueType winds outer contours clockwise; CFF the other way round.
      glyphs.push(reverseContours({ ...outline, advance: advances[gid], lsb: lsbs[gid] }));
    }
    names = cff.names ?? parsePostNames(tables.get("post"), metrics.numGlyphs);
  }

  const nameRecords = parseName(tables.get("name"));
  const baseName = fileName.replace(/\.[^.]+$/, "");
  const familyName = getName(nameRecords, 16) ?? getName(nameRecords, 1) ?? baseName;
  const subfamilyName = getName(nameRecords, 17) ?? getName(nameRecords, 2) ?? "Regular";

  const os2 = tables.get("OS/2");
  let declaredWeight = 400;
  let widthClass = 5;
  let fsSelection = 0;
  if (os2 && os2.length >= 8) {
    const r = new Reader(os2);
    const weight = r.seek(4).u16();
    if (weight >= 1 && weight <= 1000) declaredWeight = weight;
    widthClass = r.seek(6).u16() || 5;
    if (os2.length >= 64) fsSelection = r.seek(62).u16();
  }

  const head = tables.get("head");
  const macStyle = head && head.length >= 46 ? new Reader(head, 44).u16() : 0;
  const angle = italicAngle(tables.get("post"));
  const italic =
    (fsSelection & 0x0001) !== 0 ||
    (fsSelection & 0x0200) !== 0 ||
    (macStyle & 0x0002) !== 0 ||
    /italic|oblique|slanted/i.test(subfamilyName);

  const stem = measureStem(glyphs, metrics.unitsPerEm);

  faceCounter += 1;
  return {
    id: `face-${faceCounter}-${Math.random().toString(36).slice(2, 7)}`,
    fileName,
    fileSize,
    format: raw.format,
    index: raw.index,
    count: raw.count,
    tables,
    glyphs,
    cubic: raw.outlines !== "glyf",
    names,
    cmap: parseCmap(tables.get("cmap")),
    upem: metrics.unitsPerEm,
    ascender: metrics.ascender,
    descender: metrics.descender,
    familyName,
    subfamilyName,
    version: getName(nameRecords, 5) ?? "Version 1.000",
    declaredWeight,
    stem,
    measuredWeight: inferWeight(stem, metrics.unitsPerEm),
    italic,
    italicAngle: italic && angle === 0 ? -11 : angle,
    widthClass,
    isVariable: tables.has("fvar"),
  };
}

/** A label for lists: "Bold Italic", or "Bold Italic (2/4)" inside a collection. */
export function faceLabel(face: SourceFace) {
  return face.count > 1 ? `${face.subfamilyName} (${face.index + 1}/${face.count})` : face.subfamilyName;
}
