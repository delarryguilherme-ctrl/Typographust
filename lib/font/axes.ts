import { IDENTITY, deformation, lerpDeformation, type Deformation } from "./transform";
import { stemAt } from "./stem";

/**
 * One master along an axis. The axis default needs no stop — that position is
 * the source outline itself — so every stop describes a deviation from it.
 *
 * Two stops give the usual linear axis. More stops let each position be shaped
 * independently: a weight axis can be tuned at 500 without disturbing 100 or
 * 900, which is what intermediate gvar regions exist for.
 */
export interface AxisStop {
  id: string;
  /** User-space coordinate, between the axis min and max. */
  at: number;
  deformation: Deformation;
}

export interface AxisDef {
  id: string;
  tag: string;
  name: string;
  min: number;
  def: number;
  max: number;
  /** Hidden axes are exposed to layout engines but not offered in font UIs. */
  hidden: boolean;
  stops: AxisStop[];
}

export interface NamedInstance {
  id: string;
  name: string;
  /** Axis tag -> user-space coordinate. */
  coords: Record<string, number>;
}

/** What the axis presets need to know about the uploaded font. */
export interface FontShape {
  upem: number;
  /** Weight class the drawing suggests — see `inferWeight`. */
  weight: number;
  /** Measured stem thickness in font units. */
  stem: number;
}

export const REGISTERED_AXES = [
  { tag: "wght", name: "Weight", min: 100, def: 400, max: 900 },
  { tag: "wdth", name: "Width", min: 75, def: 100, max: 125 },
  { tag: "slnt", name: "Slant", min: -12, def: 0, max: 0 },
  { tag: "ital", name: "Italic", min: 0, def: 0, max: 1 },
  { tag: "opsz", name: "Optical Size", min: 8, def: 14, max: 144 },
  { tag: "GRAD", name: "Grade", min: -200, def: 0, max: 150 },
] as const;

export type RegisteredTag = (typeof REGISTERED_AXES)[number]["tag"];

let counter = 0;
export function newId(prefix: string) {
  counter += 1;
  return `${prefix}-${counter}-${Math.random().toString(36).slice(2, 7)}`;
}

export function makeStop(at: number, d: Partial<Deformation> = {}): AxisStop {
  return { id: newId("stop"), at, deformation: deformation(d) };
}

/**
 * The outline offset that takes the source stem to the stem a given weight
 * wants. Emboldening pushes both sides outward, so total thickness grows by
 * twice the offset.
 */
function weightOffset(target: number, shape: FontShape) {
  return (stemAt(target, shape.weight, shape.stem) - shape.stem) / 2;
}

/**
 * Builds a sensible starting axis for `tag`.
 *
 * The axis default lands on the weight the uploaded font actually is, so the
 * untouched outline stays reachable, and every stop is measured out from the
 * font's own stem rather than from a constant.
 */
export function makeAxis(tag: string, shape: FontShape): AxisDef {
  const s = shape.upem / 1000;
  const preset = REGISTERED_AXES.find((a) => a.tag === tag);
  const base = { id: newId("axis"), tag, hidden: false };

  if (tag === "wght") {
    const def = Math.min(900, Math.max(100, shape.weight));
    const stops: AxisStop[] = [];
    for (const value of [100, 200, 300, 400, 500, 600, 700, 800, 900]) {
      if (value === def) continue;
      stops.push(makeStop(value, { weight: weightOffset(value, shape) }));
    }
    return { ...base, name: "Weight", min: 100, def, max: 900, stops };
  }

  if (tag === "wdth") {
    return {
      ...base,
      name: "Width",
      min: 75,
      def: 100,
      max: 125,
      stops: [makeStop(75, { widthScale: 0.75 }), makeStop(125, { widthScale: 1.25 })],
    };
  }

  if (tag === "slnt") {
    // slnt is measured in degrees counter-clockwise, so the negative end leans right.
    return { ...base, name: "Slant", min: -12, def: 0, max: 0, stops: [makeStop(-12, { slant: 12 })] };
  }

  if (tag === "ital") {
    return {
      ...base,
      name: "Italic",
      min: 0,
      def: 0,
      max: 1,
      stops: [makeStop(1, { slant: 11, widthScale: 0.97, weight: -shape.stem * 0.04 })],
    };
  }

  if (tag === "opsz") {
    return {
      ...base,
      name: "Optical Size",
      min: 8,
      def: 14,
      max: 144,
      stops: [
        makeStop(8, { weight: shape.stem * 0.09, tracking: 28 * s, widthScale: 1.015 }),
        makeStop(144, { weight: -shape.stem * 0.1, tracking: -20 * s, widthScale: 0.99 }),
      ],
    };
  }

  if (tag === "GRAD") {
    return {
      ...base,
      name: "Grade",
      min: -200,
      def: 0,
      max: 150,
      // Grade follows the same stem curve as weight; only the advance differs.
      stops: [
        makeStop(-200, { grade: (stemAt(shape.weight - 200, shape.weight, shape.stem) - shape.stem) / 2 }),
        makeStop(150, { grade: (stemAt(shape.weight + 150, shape.weight, shape.stem) - shape.stem) / 2 }),
      ],
    };
  }

  const min = preset?.min ?? 0;
  const max = preset?.max ?? 100;
  const def = preset?.def ?? 0;
  return {
    ...base,
    name: preset?.name ?? tag,
    min,
    def,
    max,
    stops: [min, max].filter((v) => v !== def).map((v) => makeStop(v)),
  };
}

/**
 * Whether a master pushes the source drawing far enough that the synthesis
 * stops being believable — counters closing up, joins filling in, letterforms
 * distorting. Judged against the font's own stem rather than a fixed step
 * count, so a delicate face is flagged sooner than a sturdy one.
 */
export function masterStrain(stop: AxisStop, shape: FontShape): string | null {
  const d = stop.deformation;
  const thickness = 2 * (d.weight + d.grade);

  if (Math.abs(thickness) > shape.stem * 0.6) {
    return thickness > 0
      ? "Stems more than half again as thick as the original — counters and joins will start to fill in."
      : "Stems thinned by more than half — thin strokes may break up or vanish.";
  }
  if (d.widthScale < 0.85 || d.widthScale > 1.2) {
    return "Scaled horizontally past ±20%, which distorts stems and curves rather than redrawing them.";
  }
  if (Math.abs(d.slant) > 15) {
    return "Sheared past 15°, well beyond the angle any italic uses.";
  }
  return null;
}

/**
 * The deformation an axis already produces at `at`, by interpolating its
 * neighbouring stops. Used when inserting a stop, so adding one changes
 * nothing until it is edited.
 */
export function deformationAt(axis: AxisDef, at: number): Deformation {
  const points = [{ at: axis.def, deformation: IDENTITY }, ...axis.stops].sort((a, b) => a.at - b.at);

  const exact = points.find((p) => p.at === at);
  if (exact) return { ...exact.deformation };

  let lower = points[0];
  let upper = points[points.length - 1];
  for (const p of points) if (p.at <= at && p.at >= lower.at) lower = p;
  for (let i = points.length - 1; i >= 0; i--) if (points[i].at >= at && points[i].at <= upper.at) upper = points[i];

  if (at <= points[0].at) return { ...points[0].deformation };
  if (at >= points[points.length - 1].at) return { ...points[points.length - 1].deformation };
  if (lower.at === upper.at) return { ...lower.deformation };

  const t = (at - lower.at) / (upper.at - lower.at);
  return lerpDeformation(lower.deformation, upper.deformation, t);
}

const TAG_RE = /^[\x20-\x7e]{4}$/;

export function validateAxes(axes: AxisDef[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const a of axes) {
    if (!TAG_RE.test(a.tag)) {
      problems.push(`Tag "${a.tag}" must be exactly 4 printable ASCII characters.`);
    }
    if (seen.has(a.tag)) problems.push(`Duplicate axis tag "${a.tag}".`);
    seen.add(a.tag);

    const registered = REGISTERED_AXES.some((r) => r.tag === a.tag);
    if (!registered && a.tag === a.tag.toLowerCase() && TAG_RE.test(a.tag)) {
      problems.push(
        `"${a.tag}" is not a registered axis, so its tag must contain an uppercase letter (e.g. "${a.tag.toUpperCase()}").`,
      );
    }
    if (!(a.min <= a.def && a.def <= a.max)) {
      problems.push(`Axis "${a.tag}": min ≤ default ≤ max is not satisfied.`);
    }
    if (a.min === a.max) {
      problems.push(`Axis "${a.tag}" has a zero-length range and would do nothing.`);
    }

    const positions = new Set<number>();
    for (const stop of a.stops) {
      if (stop.at < a.min || stop.at > a.max) {
        problems.push(`Axis "${a.tag}": the master at ${stop.at} sits outside the axis range.`);
      }
      if (stop.at === a.def) {
        problems.push(`Axis "${a.tag}": a master at the default (${a.def}) is the source outline — remove it.`);
      }
      if (positions.has(stop.at)) {
        problems.push(`Axis "${a.tag}" has two masters at ${stop.at}.`);
      }
      positions.add(stop.at);
    }
  }

  if (axes.length === 0) problems.push("Add at least one axis before exporting.");
  if (axes.length > 64) problems.push("A font cannot have more than 64 axes.");
  return problems;
}

/** Maps a user-space coordinate onto the -1..1 normalised range fvar uses. */
export function normalize(axis: AxisDef, value: number) {
  const v = Math.min(axis.max, Math.max(axis.min, value));
  if (v === axis.def) return 0;
  if (v < axis.def) return axis.def === axis.min ? 0 : -(axis.def - v) / (axis.def - axis.min);
  return axis.max === axis.def ? 0 : (v - axis.def) / (axis.max - axis.def);
}

const WEIGHT_NAMES: [number, string][] = [
  [100, "Thin"],
  [200, "ExtraLight"],
  [300, "Light"],
  [400, "Regular"],
  [500, "Medium"],
  [600, "SemiBold"],
  [700, "Bold"],
  [800, "ExtraBold"],
  [900, "Black"],
];

export function weightName(w: number) {
  let best = WEIGHT_NAMES[0];
  for (const entry of WEIGHT_NAMES) {
    if (Math.abs(entry[0] - w) < Math.abs(best[0] - w)) best = entry;
  }
  return best[1];
}

/** Generates the usual weight (and italic) instance ladder for the current axes. */
export function defaultInstances(axes: AxisDef[]): NamedInstance[] {
  const wght = axes.find((a) => a.tag === "wght");
  const ital = axes.find((a) => a.tag === "ital");
  const slnt = axes.find((a) => a.tag === "slnt");

  const base: Record<string, number> = {};
  for (const a of axes) base[a.tag] = a.def;

  if (!wght) {
    return [{ id: newId("inst"), name: "Regular", coords: { ...base } }];
  }

  const steps = WEIGHT_NAMES.filter(([v]) => v >= wght.min && v <= wght.max);
  const upright = steps.map(([value, name]) => ({
    id: newId("inst"),
    name,
    coords: { ...base, wght: value },
  }));

  const slantAxis = ital ?? slnt;
  if (!slantAxis) return upright;

  const slantValue = ital ? ital.max : slnt!.min;
  const italics = steps.map(([value, name]) => ({
    id: newId("inst"),
    name: name === "Regular" ? "Italic" : `${name} Italic`,
    coords: { ...base, wght: value, [slantAxis.tag]: slantValue },
  }));

  return [...upright, ...italics];
}
