import type { Glyph, Point } from "./glyf";

/**
 * A synthetic master is described as a deformation of the single source
 * outline. Every field is expressed relative to the source, and every
 * operation preserves point count and order — which is what lets us compute
 * gvar deltas by subtracting one master from another.
 */
export interface Deformation {
  /** Outline offset in font units (per side). Positive thickens, negative thins. */
  weight: number;
  /** Like `weight`, but advance width is left untouched (GRAD behaviour). */
  grade: number;
  /** Shear in degrees. Positive leans to the right. */
  slant: number;
  /** Horizontal scale factor around the glyph origin. 1 = unchanged. */
  widthScale: number;
  /** Vertical scale factor around the baseline. 1 = unchanged. */
  heightScale: number;
  /** Uniform advance change in font units (letterspacing). */
  tracking: number;
  /** Extra advance change on top of what `weight` and `widthScale` imply. */
  advanceDelta: number;
  /** Vertical displacement in font units. */
  yShift: number;
}

export const IDENTITY: Deformation = {
  weight: 0,
  grade: 0,
  slant: 0,
  widthScale: 1,
  heightScale: 1,
  tracking: 0,
  advanceDelta: 0,
  yShift: 0,
};

export function deformation(partial: Partial<Deformation>): Deformation {
  return { ...IDENTITY, ...partial };
}

export function isIdentity(d: Deformation) {
  return (
    d.weight === 0 &&
    d.grade === 0 &&
    d.slant === 0 &&
    d.widthScale === 1 &&
    d.heightScale === 1 &&
    d.tracking === 0 &&
    d.advanceDelta === 0 &&
    d.yShift === 0
  );
}

/** How much of the outline growth is handed back to the advance width. */
const ADVANCE_COMPENSATION = 0.8;

function signedArea(points: Point[], start: number, end: number) {
  let area = 0;
  for (let i = start; i <= end; i++) {
    const a = points[i];
    const b = points[i === end ? start : i + 1];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

/**
 * Offsets every point along the outward normal of its contour, thickening
 * (or thinning) stems. This is the same family of algorithm as FreeType's
 * `FT_Outline_EmboldenXY` — an approximation of a real weight master, not a
 * substitute for one.
 */
function embolden(points: Point[], endPts: number[], amount: number): Point[] {
  if (amount === 0) return points.map((p) => ({ ...p }));

  // TrueType convention puts outer contours clockwise (negative shoelace area).
  // Fonts converted from PostScript often use the opposite winding, so derive
  // the orientation from the glyph itself instead of assuming.
  let total = 0;
  let start = 0;
  for (const end of endPts) {
    total += signedArea(points, start, end);
    start = end + 1;
  }
  const winding = total > 0 ? -1 : 1;

  const out = points.map((p) => ({ ...p }));
  start = 0;
  for (const end of endPts) {
    const n = end - start + 1;
    if (n < 2) {
      start = end + 1;
      continue;
    }

    for (let i = start; i <= end; i++) {
      const prev = points[i === start ? end : i - 1];
      const cur = points[i];
      const next = points[i === end ? start : i + 1];

      // Normal pointing away from the ink, for each adjacent edge.
      const inN = normalAway(cur.x - prev.x, cur.y - prev.y);
      const outN = normalAway(next.x - cur.x, next.y - cur.y);

      let nx = inN.x + outN.x;
      let ny = inN.y + outN.y;
      const len = Math.hypot(nx, ny);
      if (len < 1e-9) {
        start = end + 1;
        continue;
      }
      nx /= len;
      ny /= len;

      // Miter compensation: at sharp corners the averaged normal is shorter
      // than the offset the two edges each want, so scale it back up.
      const dot = inN.x * outN.x + inN.y * outN.y;
      const miter = Math.min(2, 1 / Math.max(0.35, Math.sqrt((1 + dot) / 2)));

      out[i].x = cur.x + nx * amount * winding * miter;
      out[i].y = cur.y + ny * amount * winding * miter;
    }
    start = end + 1;
  }
  return out;
}

function normalAway(dx: number, dy: number) {
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return { x: 0, y: 0 };
  return { x: -dy / len, y: dx / len };
}

/** Produces a new glyph by applying `d` to `source`. Point structure is preserved. */
export function applyDeformation(source: Glyph, d: Deformation): Glyph {
  const thickness = d.weight + d.grade;
  let points = embolden(source.points, source.endPts, thickness);

  const shear = Math.tan((d.slant * Math.PI) / 180);
  const hasGeometry = points.length > 0;

  // Weight is applied outward in both directions, so shift the outline back to
  // keep the left sidebearing stable — grade deliberately does not.
  const weightShift = d.weight;
  const trackingShift = d.tracking / 2;

  if (hasGeometry) {
    points = points.map((p) => {
      const y = p.y * d.heightScale + d.yShift;
      const x = p.x * d.widthScale + shear * y + weightShift + trackingShift;
      return { x, y, on: p.on };
    });
  }

  let advance = source.advance;
  if (advance > 0) {
    advance = advance * d.widthScale;
    advance += 2 * d.weight * ADVANCE_COMPENSATION;
    advance += d.tracking + d.advanceDelta;
    advance = Math.max(0, advance);
  }

  const xMin = hasGeometry ? Math.min(...points.map((p) => p.x)) : 0;

  return {
    endPts: source.endPts.slice(),
    points,
    advance: Math.round(advance),
    lsb: hasGeometry ? Math.round(xMin) : source.lsb,
  };
}

/** Linear blend between two deformations, used for axis default positions. */
export function lerpDeformation(a: Deformation, b: Deformation, t: number): Deformation {
  const mix = (x: number, y: number) => x + (y - x) * t;
  return {
    weight: mix(a.weight, b.weight),
    grade: mix(a.grade, b.grade),
    slant: mix(a.slant, b.slant),
    widthScale: mix(a.widthScale, b.widthScale),
    heightScale: mix(a.heightScale, b.heightScale),
    tracking: mix(a.tracking, b.tracking),
    advanceDelta: mix(a.advanceDelta, b.advanceDelta),
    yShift: mix(a.yShift, b.yShift),
  };
}
