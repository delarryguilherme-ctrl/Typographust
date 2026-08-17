import { Writer } from "./binary";
import { buildSfnt, parseSfnt, type TableMap } from "./sfnt";
import { glyphBounds, parseGlyphs, writeGlyph, type FontMetrics, type Glyph } from "./glyf";
import { applyDeformation } from "./transform";
import { buildGvar, type Master } from "./gvar";
import { buildFvar, buildStat, type AxisValueEntry, type InstanceEntry } from "./fvar";
import { buildName, getName, parseName, postScriptSafe } from "./name";
import { normalize, weightName, type AxisDef, type FontShape, type NamedInstance } from "./axes";
import { inferWeight, measureStem } from "./stem";

export interface SourceFont {
  tables: TableMap;
  glyphs: Glyph[];
  metrics: FontMetrics;
  familyName: string;
  subfamilyName: string;
  version: string;
  /** What OS/2 claims the weight is. */
  declaredWeight: number;
  /** Measured stem and the weight it implies — the axis presets use this. */
  shape: FontShape;
  /** Set when the drawing disagrees with the declared weight enough to matter. */
  weightMismatch: boolean;
  isAlreadyVariable: boolean;
  fileName: string;
  fileSize: number;
}

/** Tables that describe hinting or bitmap caches we can no longer honour. */
const DROPPED = [
  "fpgm",
  "prep",
  "cvt ",
  "hdmx",
  "LTSH",
  "VDMX",
  "DSIG",
  "fvar",
  "gvar",
  "avar",
  "cvar",
  "HVAR",
  "VVAR",
  "MVAR",
  "STAT",
];

export function loadSource(data: Uint8Array, fileName: string): SourceFont {
  const tables = parseSfnt(data);
  const { glyphs, metrics } = parseGlyphs(tables);
  const names = parseName(tables.get("name"));

  const os2 = tables.get("OS/2");
  let declared = 400;
  if (os2 && os2.length >= 6) {
    const value = (os2[4] << 8) | os2[5];
    if (value >= 1 && value <= 1000) declared = value;
  }

  // Fonts misdeclare their weight often enough that the drawing gets the last
  // word: a Light labelled 400 would otherwise anchor the whole ramp wrongly.
  const stem = measureStem(glyphs, metrics.unitsPerEm);
  const measured = inferWeight(stem, metrics.unitsPerEm);
  const weightMismatch = Math.abs(measured - declared) > 100;

  return {
    tables,
    glyphs,
    metrics,
    familyName: getName(names, 16) ?? getName(names, 1) ?? fileName.replace(/\.[^.]+$/, ""),
    subfamilyName: getName(names, 17) ?? getName(names, 2) ?? "Regular",
    version: getName(names, 5) ?? "Version 1.000",
    declaredWeight: declared,
    shape: { upem: metrics.unitsPerEm, stem, weight: weightMismatch ? measured : declared },
    weightMismatch,
    isAlreadyVariable: tables.has("fvar"),
    fileName,
    fileSize: data.length,
  };
}

/**
 * Turns each axis stop into a master with its own region.
 *
 * With stops at normalised 0.5 and 1.0, the 0.5 master covers 0 → 0.5 → 1.0 and
 * the 1.0 master covers 0.5 → 1.0 → 1.0. Each master's deltas stay relative to
 * the default outline, and the overlapping regions blend them linearly in
 * between — so a stop can be reshaped without disturbing its neighbours.
 */
export function buildMasters(source: SourceFont, axes: AxisDef[]): Master[] {
  const masters: Master[] = [];
  const zeros = () => new Array(axes.length).fill(0);

  axes.forEach((axis, index) => {
    const placed = axis.stops
      .filter((stop) => stop.at !== axis.def && stop.at >= axis.min && stop.at <= axis.max)
      .map((stop) => ({ stop, coord: normalize(axis, stop.at) }))
      .filter((entry) => entry.coord !== 0);

    // Each side of the default is an independent chain of regions.
    const negative = placed.filter((e) => e.coord < 0).sort((a, b) => b.coord - a.coord);
    const positive = placed.filter((e) => e.coord > 0).sort((a, b) => a.coord - b.coord);

    const emit = (chain: typeof placed, limit: number) => {
      chain.forEach((entry, i) => {
        const inner = i === 0 ? 0 : chain[i - 1].coord;
        const outer = i === chain.length - 1 ? limit : chain[i + 1].coord;

        const peak = zeros();
        const start = zeros();
        const end = zeros();
        peak[index] = entry.coord;
        start[index] = Math.min(inner, outer);
        end[index] = Math.max(inner, outer);

        masters.push({
          peak,
          start,
          end,
          glyphs: source.glyphs.map((g) => applyDeformation(g, entry.stop.deformation)),
        });
      });
    };

    emit(negative, -1);
    emit(positive, 1);
  });

  return masters;
}

/**
 * How much a master contributes at `coords`, following the same rules a
 * shaping engine applies to a gvar tuple.
 */
function regionScalar(master: Master, coords: number[]) {
  let scalar = 1;
  for (let a = 0; a < coords.length; a++) {
    const peak = master.peak[a] ?? 0;
    if (peak === 0) continue; // axis not part of this region

    const c = coords[a];
    if (c === peak) continue;

    const start = master.start[a] ?? 0;
    const end = master.end[a] ?? 0;
    if (c <= start || c >= end) return 0;

    scalar *= c < peak ? (c - start) / (peak - start) : (end - c) / (end - peak);
  }
  return scalar;
}

/**
 * Flattens the design space at one position.
 *
 * Deltas are summed exactly as a renderer would, rather than by re-running the
 * deformations at that coordinate — so a static instance is identical to what
 * the variable font shows at the same place, not merely close to it.
 */
export function instantiate(base: Glyph[], masters: Master[], coords: number[]): Glyph[] {
  const active = masters
    .map((master) => ({ master, scalar: regionScalar(master, coords) }))
    .filter((entry) => entry.scalar !== 0);

  return base.map((glyph, gid) => {
    const points = glyph.points.map((p) => ({ ...p }));
    let advance = glyph.advance;

    for (const { master, scalar } of active) {
      const source = master.glyphs[gid];
      for (let i = 0; i < points.length; i++) {
        points[i].x += (source.points[i].x - glyph.points[i].x) * scalar;
        points[i].y += (source.points[i].y - glyph.points[i].y) * scalar;
      }
      advance += (source.advance - glyph.advance) * scalar;
    }

    const xMin = points.length ? Math.min(...points.map((p) => p.x)) : 0;
    return {
      endPts: glyph.endPts.slice(),
      points,
      advance: Math.max(0, Math.round(advance)),
      lsb: points.length ? Math.round(xMin) : glyph.lsb,
    };
  });
}

export interface BuildOptions {
  familyName: string;
  axes: AxisDef[];
  instances: NamedInstance[];
}

export interface BuildResult {
  data: Uint8Array;
  masterCount: number;
  warnings: string[];
}

class NameBuilder {
  private entries = new Map<number, string>();
  private next = 256;
  private reuse = new Map<string, number>();

  set(id: number, value: string) {
    this.entries.set(id, value);
  }

  add(value: string): number {
    const existing = this.reuse.get(value);
    if (existing !== undefined) return existing;
    const id = this.next++;
    this.entries.set(id, value);
    this.reuse.set(value, id);
    return id;
  }

  build() {
    return buildName(this.entries);
  }
}

export function buildVariableFont(source: SourceFont, options: BuildOptions): BuildResult {
  const { axes, instances } = options;
  const warnings: string[] = [];
  const base = source.glyphs;
  const masters = buildMasters(source, axes);

  if (masters.length === 0) {
    warnings.push("No axis produces any outline change, so the exported font has no variation.");
  }
  if (source.isAlreadyVariable) {
    warnings.push("The source already had variation data; it was replaced by the axes defined here.");
  }

  const tables: TableMap = new Map(source.tables);
  for (const tag of DROPPED) tables.delete(tag);
  rebuildOutlineTables(tables, source, base, masters.map((m) => m.glyphs));

  // --- OS/2: describe the default instance ---
  const wghtAxis = axes.find((a) => a.tag === "wght");
  const wdthAxis = axes.find((a) => a.tag === "wdth");
  patchOs2(tables, source, {
    weight: wghtAxis?.def,
    width: wdthAxis?.def,
    italic: false,
  });

  // --- names ---
  const names = new NameBuilder();
  const family = options.familyName.trim() || source.familyName;
  const psFamily = postScriptSafe(family.replace(/\s+/g, ""));

  names.set(1, family);
  names.set(2, "Regular");
  names.set(3, `${family}; ${source.version}; variable`);
  names.set(4, `${family} Regular`);
  names.set(5, source.version);
  names.set(6, `${psFamily}-Regular`);
  names.set(16, family);
  names.set(17, "Regular");
  names.set(25, psFamily);

  const axisNameIDs = axes.map((a) => names.add(a.name.trim() || a.tag));

  const instanceEntries: InstanceEntry[] = instances.map((inst) => {
    const label = inst.name.trim() || "Instance";
    return {
      subfamilyNameID: names.add(label),
      postScriptNameID: names.add(`${psFamily}-${postScriptSafe(label.replace(/\s+/g, ""))}`),
      coords: axes.map((a) => clampAxis(a, inst.coords[a.tag] ?? a.def)),
    };
  });

  const statValues = buildStatValues(axes, names);
  const elidedFallbackNameID = names.add("Regular");

  tables.set("name", names.build());
  tables.set("fvar", buildFvar(axes, axisNameIDs, instanceEntries));
  tables.set("STAT", buildStat(axes, axisNameIDs, statValues, elidedFallbackNameID));
  if (masters.length > 0) {
    tables.set("gvar", buildGvar(base, masters, axes.length));
  }

  return { data: buildSfnt(tables), masterCount: masters.length, warnings };
}

export interface StaticFont {
  fileName: string;
  styleName: string;
  data: Uint8Array;
}

const RIBBI = new Set(["Regular", "Bold"]);

/**
 * One flattened font per named instance.
 *
 * Names follow both models at once: typographic family and subfamily
 * (`nameID` 16/17) so modern tools collect every weight into one family with a
 * style menu, and the legacy RIBBI split (`nameID` 1/2) so tools that only
 * understand Regular/Bold/Italic still see something sane.
 */
export function buildStaticFonts(source: SourceFont, options: BuildOptions): StaticFont[] {
  const { axes, instances } = options;
  const masters = buildMasters(source, axes);
  const family = options.familyName.trim() || source.familyName;
  const psFamily = postScriptSafe(family.replace(/\s+/g, ""));

  return instances.map((instance) => {
    const coords = axes.map((a) => clampAxis(a, instance.coords[a.tag] ?? a.def));
    const normalised = axes.map((a, i) => normalize(a, coords[i]));
    const glyphs = instantiate(source.glyphs, masters, normalised);

    const style = instance.name.trim() || "Regular";
    const italAxis = axes.findIndex((a) => a.tag === "ital");
    const slntAxis = axes.findIndex((a) => a.tag === "slnt");
    const italic =
      /italic|oblique/i.test(style) ||
      (italAxis >= 0 && coords[italAxis] >= 0.5) ||
      (slntAxis >= 0 && coords[slntAxis] !== axes[slntAxis].def);

    const weightPart = style.replace(/\s*(italic|oblique)\s*/i, "").trim() || "Regular";
    const isBold = weightPart === "Bold";
    const wghtIndex = axes.findIndex((a) => a.tag === "wght");
    const wdthIndex = axes.findIndex((a) => a.tag === "wdth");

    const tables: TableMap = new Map(source.tables);
    for (const tag of DROPPED) tables.delete(tag);
    rebuildOutlineTables(tables, source, glyphs, []);
    patchOs2(tables, source, {
      weight: wghtIndex >= 0 ? coords[wghtIndex] : undefined,
      width: wdthIndex >= 0 ? coords[wdthIndex] : undefined,
      italic,
      bold: isBold,
    });

    // Legacy naming can only express four styles, so anything else becomes its
    // own family with the weight folded into the family name.
    const legacyFamily = RIBBI.has(weightPart) ? family : `${family} ${weightPart}`;
    const legacyStyle = RIBBI.has(weightPart)
      ? [isBold ? "Bold" : null, italic ? "Italic" : null].filter(Boolean).join(" ") || "Regular"
      : italic
        ? "Italic"
        : "Regular";

    const psStyle = postScriptSafe(style.replace(/\s+/g, ""));
    const names = new NameBuilder();
    names.set(1, legacyFamily);
    names.set(2, legacyStyle);
    names.set(3, `${family} ${style}; ${source.version}`);
    names.set(4, `${family} ${style}`);
    names.set(5, source.version);
    names.set(6, `${psFamily}-${psStyle}`);
    names.set(16, family);
    names.set(17, style);
    tables.set("name", names.build());

    return {
      fileName: `${psFamily}-${psStyle}.ttf`,
      styleName: style,
      data: buildSfnt(tables),
    };
  });
}

/**
 * Rewrites glyf, loca, hmtx, hhea, maxp and head from `base`.
 *
 * `alternates` are other glyph sets the font can reach — the synthetic masters
 * in a variable build — which do not go into glyf but must still be covered by
 * the bounding box and the maxp limits.
 */
function rebuildOutlineTables(tables: TableMap, source: SourceFont, base: Glyph[], alternates: Glyph[][]) {
  const glyfWriter = new Writer(1 << 18);
  const locaOffsets: number[] = [];
  for (const g of base) {
    locaOffsets.push(glyfWriter.length);
    glyfWriter.bytes(writeGlyph(g));
    glyfWriter.pad(4);
  }
  locaOffsets.push(glyfWriter.length);
  tables.set("glyf", glyfWriter.toBytes());

  const locaWriter = new Writer(locaOffsets.length * 4);
  for (const off of locaOffsets) locaWriter.u32(off);
  tables.set("loca", locaWriter.toBytes());

  const numGlyphs = base.length;
  const hmtxWriter = new Writer(numGlyphs * 4);
  let advanceWidthMax = 0;
  let minLsb = Infinity;
  let minRsb = Infinity;
  let xMaxExtent = -Infinity;

  for (const g of base) {
    const b = glyphBounds(g);
    const lsb = g.points.length ? b.xMin : g.lsb;
    hmtxWriter.u16(Math.max(0, Math.round(g.advance)));
    hmtxWriter.i16(Math.round(lsb));
    advanceWidthMax = Math.max(advanceWidthMax, g.advance);
    if (g.points.length) {
      minLsb = Math.min(minLsb, lsb);
      minRsb = Math.min(minRsb, g.advance - (lsb + (b.xMax - b.xMin)));
      xMaxExtent = Math.max(xMaxExtent, lsb + (b.xMax - b.xMin));
    }
  }
  tables.set("hmtx", hmtxWriter.toBytes());

  const hhea = new Uint8Array(source.tables.get("hhea")!);
  const hheaView = new DataView(hhea.buffer);
  hheaView.setUint16(10, Math.round(advanceWidthMax));
  hheaView.setInt16(12, Number.isFinite(minLsb) ? Math.round(minLsb) : 0);
  hheaView.setInt16(14, Number.isFinite(minRsb) ? Math.round(minRsb) : 0);
  hheaView.setInt16(16, Number.isFinite(xMaxExtent) ? Math.round(xMaxExtent) : 0);
  hheaView.setUint16(34, numGlyphs);
  tables.set("hhea", hhea);

  // Outlines are decomposed, so composite and hinting limits are all zero.
  const maxp = new Uint8Array(source.tables.get("maxp")!);
  if (maxp.length >= 32) {
    const view = new DataView(maxp.buffer);
    let maxPoints = 0;
    let maxContours = 0;
    for (const set of [base, ...alternates]) {
      for (const g of set) {
        maxPoints = Math.max(maxPoints, g.points.length);
        maxContours = Math.max(maxContours, g.endPts.length);
      }
    }

    // Offset 4 is numGlyphs and must be left alone.
    view.setUint16(6, Math.min(0xffff, maxPoints));
    view.setUint16(8, Math.min(0xffff, maxContours));
    view.setUint16(10, 0); // maxCompositePoints
    view.setUint16(12, 0); // maxCompositeContours
    view.setUint16(14, 1); // maxZones
    view.setUint16(16, 0); // maxTwilightPoints
    view.setUint16(18, 0); // maxStorage
    view.setUint16(20, 0); // maxFunctionDefs
    view.setUint16(22, 0); // maxInstructionDefs
    view.setUint16(24, 0); // maxStackElements
    view.setUint16(26, 0); // maxSizeOfInstructions
    view.setUint16(28, 0); // maxComponentElements
    view.setUint16(30, 0); // maxComponentDepth
  }
  tables.set("maxp", maxp);

  const head = new Uint8Array(source.tables.get("head")!);
  const headView = new DataView(head.buffer);
  let xMin = Infinity;
  let yMin = Infinity;
  let xMax = -Infinity;
  let yMax = -Infinity;
  for (const set of [base, ...alternates]) {
    for (const g of set) {
      if (!g.points.length) continue;
      const b = glyphBounds(g);
      xMin = Math.min(xMin, b.xMin);
      yMin = Math.min(yMin, b.yMin);
      xMax = Math.max(xMax, b.xMax);
      yMax = Math.max(yMax, b.yMax);
    }
  }
  if (!Number.isFinite(xMin)) xMin = yMin = xMax = yMax = 0;

  headView.setInt16(36, clampI16(xMin));
  headView.setInt16(38, clampI16(yMin));
  headView.setInt16(40, clampI16(xMax));
  headView.setInt16(42, clampI16(yMax));
  headView.setInt16(50, 1); // indexToLocFormat: long
  tables.set("head", head);
}

function patchOs2(
  tables: TableMap,
  source: SourceFont,
  style: { weight?: number; width?: number; italic: boolean; bold?: boolean },
) {
  const os2Source = source.tables.get("OS/2");
  if (!os2Source) return;
  const os2 = new Uint8Array(os2Source);
  const view = new DataView(os2.buffer);

  if (style.weight !== undefined) view.setUint16(4, Math.round(Math.min(1000, Math.max(1, style.weight))));
  if (style.width !== undefined) view.setUint16(6, widthClass(style.width));

  if (os2.length >= 64) {
    const ITALIC = 0x0001;
    const BOLD = 0x0020;
    const REGULAR = 0x0040;
    let fsSelection = view.getUint16(62) & ~(ITALIC | BOLD | REGULAR);
    if (style.italic) fsSelection |= ITALIC;
    if (style.bold) fsSelection |= BOLD;
    if (!style.italic && !style.bold) fsSelection |= REGULAR;
    view.setUint16(62, fsSelection);
  }
  tables.set("OS/2", os2);

  const head = tables.get("head");
  if (head) {
    const headView = new DataView(head.buffer, head.byteOffset, head.byteLength);
    let macStyle = headView.getUint16(44) & ~0x0003;
    if (style.bold) macStyle |= 0x0001;
    if (style.italic) macStyle |= 0x0002;
    headView.setUint16(44, macStyle);
  }
}

function clampI16(v: number) {
  return Math.max(-32768, Math.min(32767, Math.round(v)));
}

function clampAxis(axis: AxisDef, value: number) {
  return Math.min(axis.max, Math.max(axis.min, value));
}

const WIDTH_CLASSES: [number, number][] = [
  [50, 1],
  [62.5, 2],
  [75, 3],
  [87.5, 4],
  [100, 5],
  [112.5, 6],
  [125, 7],
  [150, 8],
  [200, 9],
];

function widthClass(wdth: number) {
  let best = WIDTH_CLASSES[4];
  for (const entry of WIDTH_CLASSES) {
    if (Math.abs(entry[0] - wdth) < Math.abs(best[0] - wdth)) best = entry;
  }
  return best[1];
}

const WIDTH_NAMES: [number, string][] = [
  [50, "UltraCondensed"],
  [62.5, "ExtraCondensed"],
  [75, "Condensed"],
  [87.5, "SemiCondensed"],
  [100, "Normal"],
  [112.5, "SemiExpanded"],
  [125, "Expanded"],
  [150, "ExtraExpanded"],
  [200, "UltraExpanded"],
];

/** Emits STAT axis values only where a position has a well-defined public name. */
function buildStatValues(axes: AxisDef[], names: NameBuilder): AxisValueEntry[] {
  const out: AxisValueEntry[] = [];

  axes.forEach((axis, axisIndex) => {
    const push = (value: number, label: string, elidable: boolean) => {
      out.push({ axisIndex, value, nameID: names.add(label), elidable });
    };

    if (axis.tag === "wght") {
      for (let w = 100; w <= 900; w += 100) {
        if (w < axis.min || w > axis.max) continue;
        push(w, weightName(w), w === 400);
      }
    } else if (axis.tag === "wdth") {
      for (const [value, label] of WIDTH_NAMES) {
        if (value < axis.min || value > axis.max) continue;
        push(value, label, value === 100);
      }
    } else if (axis.tag === "ital") {
      if (axis.min <= 0) push(0, "Roman", true);
      if (axis.max >= 1) push(1, "Italic", false);
    } else if (axis.tag === "slnt") {
      if (axis.min <= 0 && axis.max >= 0) push(0, "Roman", true);
      if (axis.min < 0) push(axis.min, "Slanted", false);
    }
  });

  return out;
}
