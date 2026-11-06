import { Reader, Writer } from "./binary";
import { buildSfnt, type TableMap } from "./sfnt";
import { glyphBounds, writeGlyph, type Glyph } from "./glyf";
import { applyDeformation, deformation, isIdentity, type Deformation } from "./transform";
import { buildGvar, type Master } from "./gvar";
import { buildFvar, buildStat, type AxisValueEntry, type InstanceEntry } from "./fvar";
import { buildName, postScriptSafe } from "./name";
import { normalize, weightName, type AxisDef, type CornerMaster, type NamedInstance } from "./axes";
import { unpackFontFile } from "./container";
import { readFace, type SourceFace } from "./face";
import type { DrawnFace, GlyphHint, SourceFont } from "./family";
import { analyzeFigures, equalizeDigits, figureGlyphs, planFigures, type FigureOptions, type FigurePlan } from "./figures";
import { addSubstitutions } from "./gsub";
import { solveModel, type MasterSpec } from "./model";
import { buildPostWithNames, parsePostNames } from "./post";

export type { SourceFont } from "./family";

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

/** Reads every font in a file — a collection yields several. */
export async function loadFaces(data: Uint8Array, fileName: string): Promise<SourceFace[]> {
  const raws = await unpackFontFile(data);
  return raws.map((raw) => readFace(raw, fileName, data.length));
}

/**
 * The deformation that stands in for a drawn master on the glyphs whose
 * outlines could not be matched: the measured stem difference as a weight
 * offset, and the italic angle as a shear.
 */
export function fallbackDeformation(source: SourceFont, face: DrawnFace): Deformation {
  return deformation({
    weight: (face.shape.stem - source.shape.stem) / 2,
    slant: face.italic && !source.italic ? -face.italicAngle : 0,
  });
}

/** Gives a stand-in outline the drawn glyph's real advance and ink centre. */
function fitToHint(g: Glyph, hint: GlyphHint): Glyph {
  if (g.points.length === 0) return { ...g, advance: hint.advance };
  let xMin = Infinity;
  let xMax = -Infinity;
  for (const p of g.points) {
    xMin = Math.min(xMin, p.x);
    xMax = Math.max(xMax, p.x);
  }
  const shift = Math.round(hint.center - (xMin + xMax) / 2);
  return {
    endPts: g.endPts,
    points: g.points.map((p) => ({ x: p.x + shift, y: p.y, on: p.on })),
    advance: Math.round(hint.advance),
    lsb: g.lsb + shift,
  };
}

export interface DesignSpace {
  /** Default glyphs, including any generated figures. */
  base: Glyph[];
  masters: Master[];
  plan: FigurePlan | null;
}

/**
 * Builds every master the axes describe and solves them into gvar regions.
 *
 * Drawn masters (uploaded weights and italics) are solved first. Synthetic
 * stops are then applied on top of whatever the drawn masters produce at
 * their position — clamped to the drawn range — so a Black synthesised past
 * an uploaded Bold starts from the Bold drawing, not from the Regular.
 */
export function designSpace(source: SourceFont, options: BuildOptions): DesignSpace {
  const { axes } = options;
  const plan = planFigures(source, options.figures);
  const figures = analyzeFigures(source);
  const tabularDigits = figures.tabular ? figures.digits : null;
  const augment = (raw: (Glyph | null)[]): (Glyph | null)[] => {
    const set = tabularDigits ? equalizeDigits(raw, tabularDigits) : raw;
    return plan ? [...set, ...figureGlyphs(set, plan)] : set;
  };
  const base = augment(source.glyphs) as Glyph[];

  const faces = new Map(source.drawn.map((d) => [d.id, d]));
  const zeros = () => new Array<number>(axes.length).fill(0);
  const extent = axes.map(() => ({ lo: 0, hi: 0 }));
  const drawn: MasterSpec[] = [];
  const seen = new Set<string>();
  const place = (location: number[], glyphs: (Glyph | null)[]) => {
    const key = location.join(",");
    if (seen.has(key) || location.every((v) => v === 0)) return false;
    seen.add(key);
    drawn.push({ location, glyphs });
    return true;
  };

  axes.forEach((axis, a) => {
    for (const stop of axis.stops) {
      const face = stop.faceId ? faces.get(stop.faceId) : undefined;
      if (!face) continue;
      const location = zeros();
      location[a] = normalize(axis, stop.at);
      const fallback = fallbackDeformation(source, face);
      let set = augment(
        face.glyphs.map((g, gid) => {
          if (g) return g;
          const stand = applyDeformation(source.glyphs[gid], fallback);
          return face.hints[gid] ? fitToHint(stand, face.hints[gid]!) : stand;
        }),
      );
      if (!isIdentity(stop.deformation)) set = set.map((g) => g && applyDeformation(g, stop.deformation));
      if (place(location, set)) {
        extent[a].lo = Math.min(extent[a].lo, location[a]);
        extent[a].hi = Math.max(extent[a].hi, location[a]);
      }
    }
  });

  // Corners are placed after the on-axis masters, so a corner glyph that has
  // no matching outline can start from what those masters predict there.
  const onAxis = solveModel(base, drawn);
  for (const corner of options.corners ?? []) {
    const face = faces.get(corner.faceId);
    if (!face) continue;
    if (!Object.keys(corner.coords).every((tag) => axes.some((a) => a.tag === tag))) continue;
    const location = axes.map((axis) => (axis.tag in corner.coords ? normalize(axis, corner.coords[axis.tag]) : 0));
    if (location.filter((v) => v !== 0).length < 2) continue;
    const predicted = instantiate(base, onAxis, location);
    place(
      location,
      augment(face.glyphs.map((g, gid) => g ?? (face.hints[gid] ? fitToHint(predicted[gid], face.hints[gid]!) : null))),
    );
  }

  const drawnMasters = solveModel(base, drawn);

  const synthetic: MasterSpec[] = [];
  axes.forEach((axis, a) => {
    for (const stop of axis.stops) {
      if (stop.faceId && faces.has(stop.faceId)) continue;
      const v = normalize(axis, stop.at);
      if (v === 0) continue;
      const location = zeros();
      location[a] = v;
      const anchor = zeros();
      anchor[a] = Math.min(extent[a].hi, Math.max(extent[a].lo, v));
      const basis = anchor[a] === 0 ? base : instantiate(base, drawnMasters, anchor);
      synthetic.push({ location, glyphs: basis.map((g) => applyDeformation(g, stop.deformation)) });
    }
  });

  return { base, masters: solveModel(base, [...drawn, ...synthetic]), plan };
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
  /** Drawn masters that sit off the axes, e.g. a Bold Italic at (wght 700, ital 1). */
  corners?: CornerMaster[];
  figures?: FigureOptions;
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
  const { base, masters, plan } = designSpace(source, options);

  if (masters.length === 0) {
    warnings.push("No axis produces any outline change, so the exported font has no variation.");
  }
  if (source.isAlreadyVariable) {
    warnings.push("The source already had variation data; it was replaced by the axes defined here.");
  }

  const tables: TableMap = new Map(source.tables);
  for (const tag of DROPPED) tables.delete(tag);
  addGlyphTables(tables, source, plan, warnings);
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
  const { base, masters, plan } = designSpace(source, options);
  const family = options.familyName.trim() || source.familyName;
  const psFamily = postScriptSafe(family.replace(/\s+/g, ""));

  return instances.map((instance) => {
    const coords = axes.map((a) => clampAxis(a, instance.coords[a.tag] ?? a.def));
    const normalised = axes.map((a, i) => normalize(a, coords[i]));
    const glyphs = instantiate(base, masters, normalised);

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
    addGlyphTables(tables, source, plan, []);
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

  // Rebuilt from scratch: a CFF source only has the 6-byte version 0.5, and
  // decomposed, unhinted outlines leave every composite and hinting limit at 0.
  let maxPoints = 0;
  let maxContours = 0;
  for (const set of [base, ...alternates]) {
    for (const g of set) {
      maxPoints = Math.max(maxPoints, g.points.length);
      maxContours = Math.max(maxContours, g.endPts.length);
    }
  }
  const maxp = new Writer(32);
  maxp.u32(0x00010000);
  maxp.u16(numGlyphs);
  maxp.u16(Math.min(0xffff, maxPoints));
  maxp.u16(Math.min(0xffff, maxContours));
  maxp.u16(0); // maxCompositePoints
  maxp.u16(0); // maxCompositeContours
  maxp.u16(1); // maxZones
  for (let i = 0; i < 8; i++) maxp.u16(0); // twilight points through component depth
  tables.set("maxp", maxp.toBytes());

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

/**
 * Brings the tables that are indexed by glyph id up to date with the glyphs
 * the build appends (generated figures), and wires those glyphs into GSUB.
 */
function addGlyphTables(tables: TableMap, source: SourceFont, plan: FigurePlan | null, warnings: string[]) {
  if (!plan) return;
  const count = source.glyphs.length;
  const added = plan.digits.length;

  try {
    tables.set("GSUB", addSubstitutions(tables.get("GSUB"), plan.features));
  } catch (e) {
    warnings.push(
      `The figures were added, but the font's GSUB could not take the ${plan.features.map((f) => f.tag).join("/")} feature: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  const post = tables.get("post");
  const names = parsePostNames(post, count);
  if (names) {
    tables.set("post", buildPostWithNames(post, [...names, ...plan.names]));
  } else if (post && post.length >= 32 && new Reader(post).u32() !== 0x00030000) {
    // Any other format lists glyphs by index and would now be short; format 3 lists none.
    const v3 = post.slice(0, 32);
    new DataView(v3.buffer).setUint32(0, 0x00030000);
    tables.set("post", v3);
  }

  const vhea = tables.get("vhea");
  const vmtx = tables.get("vmtx");
  if (vhea && vmtx && vhea.length >= 36) {
    const numLong = new Reader(vhea, 34).u16();
    const r = new Reader(vmtx);
    const heights: number[] = [];
    const tsbs: number[] = [];
    let last = 0;
    for (let gid = 0; gid < count; gid++) {
      if (gid < numLong && r.pos + 4 <= vmtx.length) {
        last = r.u16();
        tsbs.push(r.i16());
      } else {
        tsbs.push(r.pos + 2 <= vmtx.length ? r.i16() : 0);
      }
      heights.push(last);
    }
    for (let i = 0; i < added; i++) {
      heights.push(heights[plan.digits[i]] ?? last);
      tsbs.push(tsbs[plan.digits[i]] ?? 0);
    }
    const w = new Writer(heights.length * 4);
    heights.forEach((h, i) => {
      w.u16(h);
      w.i16(tsbs[i]);
    });
    tables.set("vmtx", w.toBytes());
    const vheaCopy = vhea.slice();
    new DataView(vheaCopy.buffer).setUint16(34, heights.length);
    tables.set("vhea", vheaCopy);
  }
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
