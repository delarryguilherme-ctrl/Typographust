import type { SourceFont } from "./family";
import { glyphBounds, type Glyph } from "./glyf";
import { featureTags, substitutesOf, type SubstitutionFeature } from "./gsub";
import { uniqueNames } from "./post";

/**
 * Tabular and proportional figures.
 *
 * Tables need digits that all share one advance (`tnum`) so columns line up;
 * running text reads better with digits spaced to their shapes (`pnum`).
 * Design tools only offer the choice when the font has both: Figma's
 * Type details → Numbers lists "Monospace" for `tnum` and "Proportional" for
 * `pnum`.
 *
 * Most fonts ship one kind as the default figures. This generates the other
 * kind as new glyphs — the same drawings, re-spaced — and the GSUB features
 * that switch between them. The drawings are not altered, so unlike the
 * synthesised masters there is no quality trade-off: only spacing changes.
 */

export type FigureKind = "tabular" | "proportional";

export interface FigureInfo {
  /** Glyph ids for 0–9, or null when the font does not map all ten. */
  digits: number[] | null;
  advances: number[];
  /** The default figures share one advance. */
  tabular: boolean;
  widest: number;
  /** Narrowest tabular width that keeps every digit's ink inside its advance. */
  minWidth: number;
  features: string[];
  /** What generating would add, or null when the font already has both. */
  generates: FigureKind | null;
}

export interface FigureOptions {
  enabled: boolean;
  /** Advance of the tabular figures at the default; null = widest digit. */
  tabularWidth: number | null;
}

export const DEFAULT_FIGURES: FigureOptions = { enabled: true, tabularWidth: null };

/** Features whose single substitutions produce full-size figure variants. Fractions and super/subscripts are left alone. */
const VARIANT_FEATURES = /^(zero|onum|lnum|salt|ss\d\d|cv\d\d)$/;

const DIGIT_NAMES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

export function analyzeFigures(source: SourceFont): FigureInfo {
  const features = featureTags(source.tables.get("GSUB"));
  const gids = DIGIT_NAMES.map((_, i) => source.cmap.get(0x30 + i) ?? 0);
  const digits = gids.every((g) => g > 0 && g < source.glyphs.length) ? gids : null;

  if (!digits) {
    return { digits: null, advances: [], tabular: false, widest: 0, minWidth: 0, features, generates: null };
  }

  const glyphs = digits.map((g) => source.glyphs[g]);
  const advances = glyphs.map((g) => g.advance);
  const widest = Math.max(...advances);
  const tabular = widest - Math.min(...advances) <= 1;
  const minWidth = Math.max(...glyphs.map((g) => {
    const b = glyphBounds(g);
    return g.points.length ? b.xMax - b.xMin : 0;
  }));

  let generates: FigureKind | null = null;
  if (tabular && !features.includes("pnum")) generates = "proportional";
  if (!tabular && !features.includes("tnum")) generates = "tabular";

  return { digits, advances, tabular, widest, minWidth, features, generates };
}

export interface FigurePlan {
  kind: FigureKind;
  digits: number[];
  /**
   * Every glyph that gets a re-spaced copy: the ten digits first, then the
   * digit variants other features substitute in (slashed zero, oldstyle…).
   * Spacing is always worked out from the ten digits.
   */
  sources: number[];
  /** Glyph id the new figures start at. */
  firstNew: number;
  /** Tabular advance at the default; each master keeps the same offset from its widest digit. */
  width: number;
  widest: number;
  names: string[];
  features: SubstitutionFeature[];
}

export function planFigures(source: SourceFont, options: FigureOptions | undefined): FigurePlan | null {
  if (!options?.enabled) return null;
  const info = analyzeFigures(source);
  if (!info.digits || !info.generates) return null;

  const kind = info.generates;
  const firstNew = source.glyphs.length;
  // The new lookups run after every existing one, so a digit that `zero` or
  // `onum` already replaced must find its variant in the map too.
  const variants = substitutesOf(source.tables.get("GSUB"), new Set(info.digits), (tag) =>
    VARIANT_FEATURES.test(tag),
  ).filter((g) => g < source.glyphs.length && source.glyphs[g].points.length > 0);
  const sources = [...info.digits, ...variants];
  const fresh = sources.map((_, i) => firstNew + i);
  const forward = sources.map((d, i) => [d, fresh[i]] as [number, number]);
  const backward = sources.map((d, i) => [fresh[i], d] as [number, number]);

  const features: SubstitutionFeature[] =
    kind === "tabular"
      ? [{ tag: "tnum", pairs: forward }, ...(info.features.includes("pnum") ? [] : [{ tag: "pnum", pairs: backward }])]
      : [{ tag: "pnum", pairs: forward }, ...(info.features.includes("tnum") ? [] : [{ tag: "tnum", pairs: backward }])];

  const suffix = kind === "tabular" ? ".tf" : ".pf";
  const baseNames = sources.map((gid, i) => (source.glyphNames?.[gid] || DIGIT_NAMES[i] || `glyph${gid}`) + suffix);
  const names = uniqueNames(source.glyphNames ?? [], baseNames);

  const inkWidth = (gid: number) => {
    const b = glyphBounds(source.glyphs[gid]);
    return b.xMax - b.xMin;
  };
  const minWidth = Math.max(info.minWidth, ...variants.map(inkWidth));
  const width = Math.max(minWidth, Math.round(options.tabularWidth ?? info.widest));
  return { kind, digits: info.digits, sources, firstNew, width, widest: info.widest, names, features };
}

function respace(g: Glyph, shift: number, advance: number): Glyph {
  return {
    endPts: g.endPts,
    points: g.points.map((p) => ({ x: p.x + shift, y: p.y, on: p.on })),
    advance,
    lsb: g.lsb + shift,
  };
}

/**
 * The new figures for one master's glyph set, derived from that master's own
 * digits. Every master gets the same treatment, so the new glyphs vary along
 * the axes exactly like the digits they come from — and tabular ones keep a
 * single shared advance at every position in the design space.
 */
export function figureGlyphs(set: (Glyph | null)[], plan: FigurePlan): (Glyph | null)[] {
  const all = plan.sources.map((gid) => set[gid]);
  // A master that lacks any of them leaves all to the model, so they stay
  // consistent with one another.
  if (all.some((g) => !g)) return all.map(() => null);
  const sources = all as Glyph[];
  const glyphs = sources.slice(0, plan.digits.length);

  if (plan.kind === "tabular") {
    // Equal space is added on both sides, which keeps whatever optical
    // offset the designer built into each digit's sidebearings.
    const widest = Math.max(...glyphs.map((g) => g.advance));
    const width = Math.max(1, Math.round(plan.width + (widest - plan.widest)));
    return sources.map((g) => respace(g, Math.round((width - g.advance) / 2), width));
  }

  // Proportional: tighten the loose sidebearings that tabular spacing forced
  // on narrow digits (the 1 above all) down to what the widest digit uses.
  const bounds = glyphs.map((g) => glyphBounds(g));
  const inkOf = (i: number) => (glyphs[i].points.length ? bounds[i].xMax - bounds[i].xMin : 0);
  let ref = 0;
  for (let i = 1; i < glyphs.length; i++) if (inkOf(i) > inkOf(ref)) ref = i;
  const refSide = Math.round((bounds[ref].xMin + (glyphs[ref].advance - bounds[ref].xMax)) / 2);

  return sources.map((g) => {
    if (!g.points.length) return respace(g, 0, g.advance);
    const b = glyphBounds(g);
    const lsb = b.xMin;
    const rsb = g.advance - b.xMax;
    const newL = Math.min(lsb, refSide);
    const newR = Math.min(rsb, refSide);
    return respace(g, newL - lsb, Math.max(1, newL + (b.xMax - b.xMin) + newR));
  });
}

/**
 * Holds tabular default figures to one shared advance within a master. Only
 * matters when a master's digits did not all come from its own drawing: a
 * stand-in that is a unit off is enough to break a column.
 */
export function equalizeDigits(set: (Glyph | null)[], digits: number[]): (Glyph | null)[] {
  const present = digits.map((gid) => set[gid]).filter((g): g is Glyph => Boolean(g));
  if (present.length < 2) return set;
  const width = Math.max(...present.map((g) => g.advance));
  if (present.every((g) => g.advance === width)) return set;
  const out = set.slice();
  for (const gid of digits) {
    const g = set[gid];
    if (g && g.advance !== width) out[gid] = respace(g, Math.round((width - g.advance) / 2), width);
  }
  return out;
}
