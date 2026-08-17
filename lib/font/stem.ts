import { glyphBounds, type Glyph, type Point } from "./glyf";

/**
 * Stem thickness measured from the drawing itself, rather than assumed.
 *
 * For each glyph we take a horizontal scanline through the middle of its
 * bounding box, find the runs of ink along it, and keep the narrowest one —
 * on a straight-sided letter that run *is* the stem. Taking the median across
 * hundreds of glyphs washes out the ones where it isn't (round letters give
 * their wall thickness, diagonals overestimate slightly), and it needs no
 * `cmap`, so it works on a font with no Latin in it.
 */
export function measureStem(glyphs: Glyph[], upem: number): number {
  const samples: number[] = [];
  const noiseFloor = upem * 0.004;
  const ceiling = upem * 0.5;

  // A few hundred glyphs is plenty for a median, and keeps upload snappy on
  // large fonts.
  const stride = Math.max(1, Math.floor(glyphs.length / 500));

  for (let i = 0; i < glyphs.length; i += stride) {
    const glyph = glyphs[i];
    if (glyph.points.length < 4 || glyph.endPts.length === 0) continue;

    const bounds = glyphBounds(glyph);
    const height = bounds.yMax - bounds.yMin;
    if (height < upem * 0.15) continue; // punctuation and accents mislead

    const y = bounds.yMin + height / 2;
    const crossings = scanline(glyph, y);
    if (crossings.length < 2) continue;

    let narrowest = Infinity;
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const width = crossings[k + 1] - crossings[k];
      if (width >= noiseFloor && width <= ceiling && width < narrowest) narrowest = width;
    }
    if (Number.isFinite(narrowest)) samples.push(narrowest);
  }

  if (samples.length === 0) return upem * 0.082;
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

/**
 * X coordinates where the outline crosses `y`, sorted.
 *
 * Contours are treated as polygons through every point, control points
 * included. That bows curves slightly inward, which does not matter here:
 * stems are straight, and the median is taken over many glyphs.
 */
function scanline(glyph: Glyph, y: number): number[] {
  const xs: number[] = [];
  let start = 0;

  for (const end of glyph.endPts) {
    const n = end - start + 1;
    if (n >= 2) {
      for (let i = start; i <= end; i++) {
        const a: Point = glyph.points[i];
        const b: Point = glyph.points[i === end ? start : i + 1];
        // Half-open test, so a vertex exactly on the line counts once.
        if (a.y <= y === b.y <= y) continue;
        xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
      }
    }
    start = end + 1;
  }

  xs.sort((p, q) => p - q);
  return xs;
}

/** Stem thickness of a nominal Regular, as a fraction of the em. */
const REGULAR_STEM_RATIO = 0.082;

/** Each 100 weight steps multiplies stem thickness by this much. */
export const WEIGHT_RATIO = 1.17;

/** Stem thickness at `weight`, given the measured stem at `sourceWeight`. */
export function stemAt(weight: number, sourceWeight: number, sourceStem: number) {
  return sourceStem * WEIGHT_RATIO ** ((weight - sourceWeight) / 100);
}

/**
 * The weight class the drawing suggests, which is not always the one the font
 * declares — `usWeightClass` is wrong often enough to be worth checking.
 */
export function inferWeight(stem: number, upem: number) {
  const reference = REGULAR_STEM_RATIO * upem;
  const weight = 400 + (100 * Math.log(stem / reference)) / Math.log(WEIGHT_RATIO);
  return Math.max(100, Math.min(900, Math.round(weight / 25) * 25));
}
