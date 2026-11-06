import type { Glyph } from "./glyf";
import { pointOffsets, type Master } from "./gvar";

/**
 * Turns masters at arbitrary design-space locations into gvar regions and
 * deltas — the same algorithm as fontTools' `VariationModel`, which is what
 * every major font compiler uses.
 *
 * Along a single axis this reproduces the plain region chain (each master
 * fades out at its neighbours). What it adds is masters off the axes: a Bold
 * Italic at (wght 700, ital 1) gets a region spanning both axes, and its
 * delta is only what Bold and Italic *together* fail to predict. That is how
 * a family with real italics and real weights interpolates correctly.
 */

export interface MasterSpec {
  /** Normalised location, one value per axis. Must not be all zero. */
  location: number[];
  /**
   * Full glyph set at that location. A null entry means "no drawing for this
   * glyph here" — the model's prediction is kept (its delta is zero).
   */
  glyphs: (Glyph | null)[];
}

type Triple = [number, number, number];
/** Axis index → (lower, peak, upper). Axes not listed are not part of the region. */
type Region = Map<number, Triple>;

function locationKey(spec: MasterSpec, axisPoints: Map<number, Set<number>>) {
  const axes = spec.location.map((v, i) => [i, v] as const).filter(([, v]) => v !== 0);
  const onPoint = axes.filter(([i, v]) => axisPoints.get(i)?.has(v)).length;
  return {
    rank: axes.length,
    onPoint: -onPoint,
    order: axes.map(([i]) => i),
    signs: axes.map(([, v]) => Math.sign(v)),
    magnitudes: axes.map(([, v]) => Math.abs(v)),
  };
}

function compareKeys(a: ReturnType<typeof locationKey>, b: ReturnType<typeof locationKey>) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.onPoint !== b.onPoint) return a.onPoint - b.onPoint;
  for (const field of ["order", "signs", "magnitudes"] as const) {
    const x = a[field];
    const y = b[field];
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
    if (x.length !== y.length) return x.length - y.length;
  }
  return 0;
}

export function supportScalar(location: number[], region: Region) {
  let scalar = 1;
  for (const [axis, [lower, peak, upper]] of region) {
    if (peak === 0) continue;
    const v = location[axis] ?? 0;
    if (v === peak) continue;
    if (v <= lower || v >= upper) return 0;
    scalar *= v < peak ? (v - lower) / (peak - lower) : (upper - v) / (upper - peak);
  }
  return scalar;
}

function computeSupports(locations: number[][]): Region[] {
  const axisCount = locations[0]?.length ?? 0;
  const minV = new Array(axisCount).fill(0);
  const maxV = new Array(axisCount).fill(0);
  for (const loc of locations) {
    loc.forEach((v, i) => {
      minV[i] = Math.min(minV[i], v);
      maxV[i] = Math.max(maxV[i], v);
    });
  }

  const regions: Region[] = locations.map((loc) => {
    const region: Region = new Map();
    loc.forEach((v, i) => {
      if (v > 0) region.set(i, [0, v, maxV[i]]);
      else if (v < 0) region.set(i, [minV[i], v, 0]);
    });
    return region;
  });

  // Each master's box is cut back wherever an earlier master on the same set
  // of axes sits inside it, so the two do not double-count.
  return regions.map((region, i) => {
    const axes = [...region.keys()].sort().join(",");
    for (const prev of regions.slice(0, i)) {
      if ([...prev.keys()].sort().join(",") !== axes) continue;
      let inside = true;
      for (const [axis, [lower, peak, upper]] of region) {
        const p = prev.get(axis)![1];
        if (!(p === peak || (lower < p && p < upper))) {
          inside = false;
          break;
        }
      }
      if (!inside) continue;

      let bestRatio = -1;
      let best = new Map<number, Triple>();
      for (const [axis, [, p]] of prev) {
        const [lower, peak, upper] = region.get(axis)!;
        let ratio: number;
        let triple: Triple;
        if (p < peak) {
          ratio = (p - peak) / (lower - peak);
          triple = [p, peak, upper];
        } else if (peak < p) {
          ratio = (p - peak) / (upper - peak);
          triple = [lower, peak, p];
        } else {
          continue;
        }
        if (ratio > bestRatio) {
          best = new Map();
          bestRatio = ratio;
        }
        if (ratio === bestRatio) best.set(axis, triple);
      }
      for (const [axis, triple] of best) region.set(axis, triple);
    }
    return region;
  });
}

/**
 * Solves the model and returns gvar-ready masters: a region and integer deltas
 * from the default outline for every point and advance.
 */
export function solveModel(base: Glyph[], specs: MasterSpec[]): Master[] {
  if (specs.length === 0) return [];

  const axisPoints = new Map<number, Set<number>>();
  for (const spec of specs) {
    const nonZero = spec.location.map((v, i) => [i, v] as const).filter(([, v]) => v !== 0);
    if (nonZero.length !== 1) continue;
    const [axis, v] = nonZero[0];
    if (!axisPoints.has(axis)) axisPoints.set(axis, new Set([0]));
    axisPoints.get(axis)!.add(v);
  }

  const order = specs
    .map((spec, index) => ({ spec, index, key: locationKey(spec, axisPoints) }))
    .sort((a, b) => compareKeys(a.key, b.key) || a.index - b.index)
    .map((e) => e.spec);

  const supports = computeSupports(order.map((s) => s.location));
  const weights = order.map((spec, i) => {
    const w: { j: number; scalar: number }[] = [];
    for (let j = 0; j < i; j++) {
      const scalar = supportScalar(spec.location, supports[j]);
      if (scalar) w.push({ j, scalar });
    }
    return w;
  });

  const offsets = pointOffsets(base);
  const total = offsets[base.length];
  const masters: Master[] = order.map((spec, i) => {
    const region = supports[i];
    const peak = spec.location.map((_, a) => region.get(a)?.[1] ?? 0);
    const start = spec.location.map((_, a) => region.get(a)?.[0] ?? 0);
    const end = spec.location.map((_, a) => region.get(a)?.[2] ?? 0);
    return {
      peak,
      start,
      end,
      dx: new Int32Array(total),
      dy: new Int32Array(total),
      dAdvance: new Int32Array(base.length),
    };
  });

  base.forEach((glyph, gid) => {
    const n = glyph.points.length;
    const at = offsets[gid];

    order.forEach((spec, i) => {
      const value = spec.glyphs[gid];
      // No drawing here: the delta stays zero, so the model's prediction holds.
      if (!value || value.points.length !== n) return;
      const m = masters[i];
      for (let k = 0; k < n; k++) {
        let x = value.points[k].x - glyph.points[k].x;
        let y = value.points[k].y - glyph.points[k].y;
        for (const { j, scalar } of weights[i]) {
          x -= masters[j].dx[at + k] * scalar;
          y -= masters[j].dy[at + k] * scalar;
        }
        // Rounded at each step, as fontTools does, so errors do not accumulate.
        m.dx[at + k] = Math.round(x);
        m.dy[at + k] = Math.round(y);
      }
      let a = value.advance - glyph.advance;
      for (const { j, scalar } of weights[i]) a -= masters[j].dAdvance[gid] * scalar;
      m.dAdvance[gid] = Math.round(a);
    });
  });

  return masters;
}
