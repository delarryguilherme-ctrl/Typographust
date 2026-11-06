import type { FontShape } from "./axes";
import { alignContours, alignPoints, emitTogether, frameOf, harmonize, quadratize, toContours, type Contour } from "./curves";
import type { SourceFace } from "./face";
import { faceLabel } from "./face";
import type { FontMetrics, Glyph } from "./glyf";
import { buildPostWithNames } from "./post";
import type { TableMap } from "./sfnt";

/**
 * Assembles a family from one or more uploaded faces.
 *
 * One face is the default — its outlines are the font's default instance and
 * its tables (cmap, layout, names…) are carried into the export. Every other
 * face becomes a *drawn master*: its outlines are matched glyph-for-glyph and
 * point-for-point to the default so they can be written as real gvar deltas
 * instead of synthesised ones. Glyphs whose outlines cannot be matched fall
 * back to synthesis at build time, and the panel says how many did.
 */

export interface DrawnFace {
  id: string;
  label: string;
  fileName: string;
  /** Position on the weight axis. */
  weight: number;
  italic: boolean;
  italicAngle: number;
  shape: FontShape;
  /** In default glyph order; null where the outline could not be matched. */
  glyphs: (Glyph | null)[];
  /**
   * For glyphs this face has but whose outline could not be matched: its real
   * advance and ink centre, so the stand-in outline is at least spaced like
   * the drawing. Without this a synthesised digit would break tabular widths.
   */
  hints: (GlyphHint | null)[];
  drawn: number;
}

export interface GlyphHint {
  advance: number;
  /** Horizontal centre of the ink, in font units. */
  center: number;
}

export type FaceRole =
  | { id: string; role: "default"; weight: number; italic: boolean }
  | { id: string; role: "master"; weight: number; italic: boolean; drawn: number; total: number }
  | { id: string; role: "excluded"; weight: number; italic: boolean; reason: string };

export interface SourceFont {
  tables: TableMap;
  glyphs: Glyph[];
  metrics: FontMetrics;
  familyName: string;
  subfamilyName: string;
  version: string;
  /** What OS/2 claims the weight is. */
  declaredWeight: number;
  /** Measured stem and the weight it sits at — the axis presets use this. */
  shape: FontShape;
  /** Set when the drawing disagrees with the declared weight enough to matter. */
  weightMismatch: boolean;
  isAlreadyVariable: boolean;
  fileName: string;
  fileSize: number;
  format: string;
  /** True when the default was CFF and its curves were converted to quadratic. */
  converted: boolean;
  glyphNames: string[] | null;
  cmap: Map<number, number>;
  italic: boolean;
  italicAngle: number;
  drawn: DrawnFace[];
  roles: FaceRole[];
  notes: string[];
}

export interface FamilyChoice {
  defaultId?: string | null;
  excluded?: Set<string>;
}

const DROP_FROM_CFF = ["CFF ", "CFF2", "VORG"];

export function assembleFamily(faces: SourceFace[], choice: FamilyChoice = {}): SourceFont {
  if (faces.length === 0) throw new Error("No fonts loaded.");
  const excluded = choice.excluded ?? new Set<string>();
  const notes: string[] = [];

  // --- who belongs ---------------------------------------------------------
  const anchor = faces.find((f) => f.id === choice.defaultId) ?? faces[0];
  const reasons = new Map<string, string>();
  for (const f of faces) {
    if (f.id === anchor.id) continue;
    if (excluded.has(f.id)) reasons.set(f.id, "Turned off");
    else if (f.familyName !== anchor.familyName) reasons.set(f.id, `Different family (${f.familyName})`);
    else if (f.widthClass !== anchor.widthClass) reasons.set(f.id, "Different width — not a weight or italic of this one");
    else if (f.upem !== anchor.upem) reasons.set(f.id, `Different units per em (${f.upem})`);
  }
  const eligible = faces.filter((f) => !reasons.has(f.id));

  // --- where each face sits on the weight axis ----------------------------
  const placement = placeWeights(eligible, notes);

  // --- the default ---------------------------------------------------------
  // The default must be upright whenever an upright exists: the italic axis
  // runs from it to the italics.
  const allItalic = eligible.every((f) => f.italic);
  let def = faces.find((f) => f.id === choice.defaultId && !reasons.has(f.id) && (allItalic || !f.italic));
  if (!def) {
    const uprights = eligible.filter((f) => !f.italic);
    const pool = uprights.length ? uprights : eligible;
    def = pool.reduce((best, f) =>
      Math.abs(placement.get(f.id)! - 400) < Math.abs(placement.get(best.id)! - 400) ? f : best,
    );
  }
  const isItalic = (f: SourceFace) => f.italic && !allItalic;

  // One face per style; the first one dropped in wins.
  const styles = new Map<string, SourceFace>();
  styles.set(`${placement.get(def.id)}-${isItalic(def)}`, def);
  for (const f of eligible) {
    if (f.id === def.id) continue;
    const key = `${placement.get(f.id)}-${isItalic(f)}`;
    const taken = styles.get(key);
    if (taken) reasons.set(f.id, `Same style as ${faceLabel(taken)}`);
    else styles.set(key, f);
  }
  const masters = eligible.filter((f) => f.id !== def.id && !reasons.has(f.id));

  // --- outlines ------------------------------------------------------------
  const tolerance = Math.max(0.5, def.upem / 1000);
  const maps = masters.map((m) => matchGlyphs(def, m));
  const defFrames = def.glyphs.map((g) => frameOf(g, 0));
  const baseGlyphs: Glyph[] = [];
  const aligned: (Glyph | null)[][] = masters.map(() => []);
  const hints: (GlyphHint | null)[][] = masters.map(() => []);

  def.glyphs.forEach((glyph, gid) => {
    const others = masters.map((m, k) => {
      const index = maps[k][gid];
      return index >= 0 ? m.glyphs[index] : null;
    });
    const result = assembleGlyph(glyph, def.cubic, defFrames[gid], others, masters, tolerance);
    baseGlyphs.push(result.base);
    result.aligned.forEach((g, k) => {
      aligned[k].push(g);
      const own = others[k];
      hints[k].push(!g && own ? { advance: own.advance, center: inkCenter(own) } : null);
    });
  });

  const drawn: DrawnFace[] = masters.map((m, k) => ({
    id: m.id,
    label: faceLabel(m),
    fileName: m.fileName,
    weight: placement.get(m.id)!,
    italic: isItalic(m),
    italicAngle: m.italicAngle,
    shape: { upem: m.upem, stem: m.stem, weight: placement.get(m.id)! },
    glyphs: aligned[k],
    hints: hints[k],
    drawn: aligned[k].filter(Boolean).length,
  }));

  // --- tables carried from the default -----------------------------------
  const tables: TableMap = new Map(def.tables);
  if (def.cubic) {
    for (const tag of DROP_FROM_CFF) tables.delete(tag);
    // CFF keeps names in its charset; TrueType keeps them in post.
    if (def.names) tables.set("post", buildPostWithNames(def.tables.get("post"), def.names));
  }

  const single = masters.length === 0;
  const weightMismatch = single && Math.abs(def.measuredWeight - def.declaredWeight) > 100;
  const weight = single ? (weightMismatch ? def.measuredWeight : def.declaredWeight) : placement.get(def.id)!;

  const roles: FaceRole[] = faces.map((f) => {
    const w = placement.get(f.id) ?? f.declaredWeight;
    if (f.id === def.id) return { id: f.id, role: "default", weight: w, italic: f.italic };
    const reason = reasons.get(f.id);
    if (reason) return { id: f.id, role: "excluded", weight: w, italic: f.italic, reason };
    const d = drawn.find((x) => x.id === f.id)!;
    return { id: f.id, role: "master", weight: w, italic: d.italic, drawn: d.drawn, total: def.glyphs.length };
  });

  return {
    tables,
    glyphs: baseGlyphs,
    metrics: { unitsPerEm: def.upem, numGlyphs: def.glyphs.length, ascender: def.ascender, descender: def.descender },
    familyName: def.familyName,
    subfamilyName: def.subfamilyName,
    version: def.version,
    declaredWeight: def.declaredWeight,
    shape: { upem: def.upem, stem: def.stem, weight: Math.min(1000, Math.max(1, weight)) },
    weightMismatch,
    isAlreadyVariable: def.isVariable,
    fileName: def.fileName,
    fileSize: def.fileSize,
    format: def.format,
    converted: def.cubic,
    glyphNames: def.names,
    cmap: def.cmap,
    italic: def.italic,
    italicAngle: def.italicAngle,
    drawn,
    roles,
    notes,
  };
}

/**
 * Declared weights are used when they tell a consistent story — distinct per
 * style and rising with the measured stems. Otherwise the measurements are
 * used for every face, so the axis is at least ordered correctly.
 */
function placeWeights(faces: SourceFace[], notes: string[]): Map<string, number> {
  const placement = new Map<string, number>();
  // The same style uploaded twice (say .otf and .woff2) is a duplicate, not a
  // clash — it is dropped later.
  const same = (a: SourceFace, b: SourceFace) => Math.abs(a.stem - b.stem) <= 0.03 * Math.max(a.stem, b.stem);
  const declaredOk = [false, true].every((italic) => {
    const group = faces.filter((f) => f.italic === italic).sort((a, b) => a.declaredWeight - b.declaredWeight);
    for (let i = 1; i < group.length; i++) {
      const [lighter, heavier] = [group[i - 1], group[i]];
      if (heavier.declaredWeight === lighter.declaredWeight) {
        if (!same(lighter, heavier)) return false;
      } else if (heavier.stem < lighter.stem * 0.98) {
        return false;
      }
    }
    return true;
  });

  if (!declaredOk && faces.length > 1) {
    notes.push("The declared weights clash with how heavy the drawings measure, so measured weights place the masters.");
  }
  for (const f of faces) placement.set(f.id, declaredOk || faces.length === 1 ? f.declaredWeight : f.measuredWeight);
  return placement;
}

/**
 * Maps every default glyph to the matching glyph in `face`: by code point
 * first (the most reliable), then by glyph name, then by position when the
 * two fonts share a glyph order.
 */
function matchGlyphs(def: SourceFace, face: SourceFace): Int32Array {
  const map = new Int32Array(def.glyphs.length).fill(-1);
  map[0] = 0; // .notdef

  for (const [cp, gid] of def.cmap) {
    const other = face.cmap.get(cp);
    if (other !== undefined && map[gid] < 0) map[gid] = other;
  }

  if (def.names && face.names) {
    const index = new Map<string, number>();
    face.names.forEach((n, gid) => {
      if (!index.has(n)) index.set(n, gid);
    });
    def.names.forEach((n, gid) => {
      if (map[gid] >= 0) return;
      const other = index.get(n);
      if (other !== undefined) map[gid] = other;
    });
  }

  if (def.glyphs.length === face.glyphs.length) {
    let agree = 0;
    let total = 0;
    for (const [cp, gid] of def.cmap) {
      const other = face.cmap.get(cp);
      if (other === undefined) continue;
      total++;
      if (other === gid) agree++;
    }
    if (total > 0 && agree / total > 0.98) {
      for (let gid = 0; gid < map.length; gid++) if (map[gid] < 0) map[gid] = gid;
    }
  }
  return map;
}

/**
 * One glyph across every master. The cheap path keeps each outline's own
 * points when they already correspond; the segment path promotes lines and
 * quadratics so masters with different point patterns still match, and is
 * also how cubic outlines get converted consistently.
 */
function assembleGlyph(
  def: Glyph,
  defCubic: boolean,
  defFrame: ReturnType<typeof frameOf>,
  others: (Glyph | null)[],
  faces: SourceFace[],
  tolerance: number,
): { base: Glyph; aligned: (Glyph | null)[] } {
  const frames = others.map((g, k) => (g ? frameOf(g, faces[k].italicAngle) : null));
  const allQuadratic = !defCubic && faces.every((f) => !f.cubic);

  let pointAligned: (Glyph | null)[] = others.map(() => null);
  if (allQuadratic) {
    pointAligned = others.map((g, k) => (g ? alignPoints(def, defFrame, g, frames[k]!) : null));
    if (others.every((g, k) => !g || pointAligned[k])) return { base: def, aligned: pointAligned };
  }

  const baseContours = toContours(def, defCubic);
  if (!baseContours) {
    return { base: defCubic ? quadratize(def, tolerance) : def, aligned: others.map(() => null) };
  }

  const otherContours: (Contour[] | null)[] = others.map((g, k) => {
    if (!g) return null;
    if (pointAligned[k]) return toContours(pointAligned[k]!, false);
    const contours = toContours(g, faces[k].cubic);
    return contours ? alignContours(baseContours, defFrame, contours, frames[k]!) : null;
  });

  // A quadratic family that gained nothing from the segment path keeps the
  // default's own points rather than paying for explicit implied points.
  if (allQuadratic && otherContours.every((c, k) => !c || pointAligned[k])) {
    return { base: def, aligned: pointAligned };
  }

  const members = otherContours.map((c, k) => (c ? k : -1)).filter((k) => k >= 0);
  const sets = harmonize([baseContours, ...members.map((k) => otherContours[k]!)]);
  const emitted = emitTogether(sets, tolerance);

  const aligned: (Glyph | null)[] = others.map(() => null);
  members.forEach((k, i) => {
    aligned[k] = { ...emitted[i + 1], advance: others[k]!.advance, lsb: others[k]!.lsb };
  });
  return { base: { ...emitted[0], advance: def.advance, lsb: def.lsb }, aligned };
}

function inkCenter(g: Glyph) {
  if (g.points.length === 0) return g.advance / 2;
  let xMin = Infinity;
  let xMax = -Infinity;
  for (const p of g.points) {
    xMin = Math.min(xMin, p.x);
    xMax = Math.max(xMax, p.x);
  }
  return (xMin + xMax) / 2;
}
