"use client";

import { create } from "zustand";
import { buildStaticFonts, buildVariableFont, loadSource, type SourceFont } from "./font/build";
import { buildZip } from "./font/zip";
import {
  defaultInstances,
  deformationAt,
  makeAxis,
  makeStop,
  newId,
  normalize,
  validateAxes,
  type AxisDef,
  type AxisStop,
  type NamedInstance,
} from "./font/axes";
import type { Deformation } from "./font/transform";

export type PreviewMode = "text" | "waterfall" | "glyphs";

export interface BuiltFont {
  url: string;
  family: string;
  size: number;
  masterCount: number;
  warnings: string[];
}

interface AppState {
  source: SourceFont | null;
  loadError: string | null;
  loading: boolean;

  familyName: string;
  axes: AxisDef[];
  instances: NamedInstance[];
  selectedAxisId: string | null;

  /** Current preview position in user space, keyed by axis tag. */
  coords: Record<string, number>;

  preview: {
    mode: PreviewMode;
    text: string;
    size: number;
    lineHeight: number;
    letterSpacing: number;
    align: "left" | "center";
  };

  built: BuiltFont | null;
  building: boolean;
  buildError: string | null;
  issues: string[];

  loadFile: (file: File) => Promise<void>;
  reset: () => void;

  setFamilyName: (name: string) => void;
  addAxis: (tag: string) => void;
  removeAxis: (id: string) => void;
  updateAxis: (id: string, patch: Partial<AxisDef>) => void;
  selectAxis: (id: string | null) => void;

  /** Inserts a master at `at`, matching whatever the axis already does there. */
  addStop: (axisId: string, at: number) => string | null;
  removeStop: (axisId: string, stopId: string) => void;
  updateStop: (axisId: string, stopId: string, patch: Partial<Omit<AxisStop, "id">>) => void;
  updateStopDeformation: (axisId: string, stopId: string, patch: Partial<Deformation>) => void;

  addInstance: () => void;
  removeInstance: (id: string) => void;
  updateInstance: (id: string, patch: Partial<NamedInstance>) => void;
  captureInstance: () => void;
  regenerateInstances: () => void;
  applyInstance: (id: string) => void;

  setCoord: (tag: string, value: number) => void;
  setPreview: (patch: Partial<AppState["preview"]>) => void;

  rebuild: () => void;
  /** Flattens every named instance into a static font and zips them. */
  exportStatics: () => void;
  exportingStatics: boolean;
}

const SAMPLE = "Handgloves\nVariable typography 0123";

let previewFace: FontFace | null = null;
let buildTimer: ReturnType<typeof setTimeout> | null = null;
let familyCounter = 0;

function clampCoords(axes: AxisDef[], coords: Record<string, number>) {
  const next: Record<string, number> = {};
  for (const a of axes) {
    const current = coords[a.tag];
    next[a.tag] = current === undefined ? a.def : Math.min(a.max, Math.max(a.min, current));
  }
  return next;
}

export const useApp = create<AppState>((set, get) => ({
  source: null,
  loadError: null,
  loading: false,

  familyName: "",
  axes: [],
  instances: [],
  selectedAxisId: null,
  coords: {},

  preview: {
    mode: "text",
    text: SAMPLE,
    size: 96,
    lineHeight: 1.15,
    letterSpacing: 0,
    align: "left",
  },

  built: null,
  building: false,
  buildError: null,
  issues: [],
  exportingStatics: false,

  async loadFile(file) {
    set({ loading: true, loadError: null });
    try {
      const buffer = new Uint8Array(await file.arrayBuffer());
      const source = loadSource(buffer, file.name);

      // Seed with the axes that make sense for a single-master source: weight
      // first, then `ital` rather than `slnt` — design tools and CSS treat
      // `ital` as the italic switch, while `slnt` is just another slider.
      const axes = [makeAxis("wght", source.shape), makeAxis("ital", source.shape)];
      const instances = defaultInstances(axes);

      set({
        source,
        loading: false,
        // Suffixed so the export never collides with the static already
        // installed under the same name.
        familyName: `${source.familyName} VF`,
        axes,
        instances,
        selectedAxisId: axes[0].id,
        coords: clampCoords(axes, {}),
        built: null,
        buildError: null,
        issues: validateAxes(axes),
      });
      get().rebuild();
    } catch (e) {
      set({ loading: false, loadError: e instanceof Error ? e.message : String(e) });
    }
  },

  reset() {
    if (get().built) URL.revokeObjectURL(get().built!.url);
    set({
      source: null,
      loadError: null,
      familyName: "",
      axes: [],
      instances: [],
      selectedAxisId: null,
      coords: {},
      built: null,
      buildError: null,
      issues: [],
    });
  },

  setFamilyName(name) {
    set({ familyName: name });
    get().rebuild();
  },

  addAxis(tag) {
    const { source, axes, coords } = get();
    if (!source) return;
    if (axes.some((a) => a.tag === tag)) return;
    const axis = makeAxis(tag, source.shape);
    const next = [...axes, axis];
    set({
      axes: next,
      selectedAxisId: axis.id,
      coords: clampCoords(next, coords),
      issues: validateAxes(next),
    });
    get().rebuild();
  },

  removeAxis(id) {
    const { axes, coords, selectedAxisId } = get();
    const next = axes.filter((a) => a.id !== id);
    set({
      axes: next,
      coords: clampCoords(next, coords),
      selectedAxisId: selectedAxisId === id ? (next[0]?.id ?? null) : selectedAxisId,
      issues: validateAxes(next),
    });
    get().rebuild();
  },

  updateAxis(id, patch) {
    const next = get().axes.map((a) => (a.id === id ? { ...a, ...patch } : a));
    set({ axes: next, coords: clampCoords(next, get().coords), issues: validateAxes(next) });
    get().rebuild();
  },

  selectAxis(id) {
    set({ selectedAxisId: id });
  },

  addStop(axisId, at) {
    const axis = get().axes.find((a) => a.id === axisId);
    if (!axis) return null;
    const rounded = Number(at.toFixed(4));
    if (rounded === axis.def || axis.stops.some((s) => s.at === rounded)) return null;

    const stop = makeStop(rounded);
    stop.deformation = deformationAt(axis, rounded);
    const next = get().axes.map((a) =>
      a.id === axisId ? { ...a, stops: [...a.stops, stop].sort((x, y) => x.at - y.at) } : a,
    );
    set({ axes: next, issues: validateAxes(next) });
    get().rebuild();
    return stop.id;
  },

  removeStop(axisId, stopId) {
    const next = get().axes.map((a) =>
      a.id === axisId ? { ...a, stops: a.stops.filter((s) => s.id !== stopId) } : a,
    );
    set({ axes: next, issues: validateAxes(next) });
    get().rebuild();
  },

  updateStop(axisId, stopId, patch) {
    const next = get().axes.map((a) =>
      a.id === axisId
        ? { ...a, stops: a.stops.map((s) => (s.id === stopId ? { ...s, ...patch } : s)).sort((x, y) => x.at - y.at) }
        : a,
    );
    set({ axes: next, issues: validateAxes(next) });
    get().rebuild();
  },

  updateStopDeformation(axisId, stopId, patch) {
    const next = get().axes.map((a) =>
      a.id === axisId
        ? {
            ...a,
            stops: a.stops.map((s) => (s.id === stopId ? { ...s, deformation: { ...s.deformation, ...patch } } : s)),
          }
        : a,
    );
    set({ axes: next });
    get().rebuild();
  },

  addInstance() {
    const { axes, instances, coords } = get();
    const inst: NamedInstance = {
      id: newId("inst"),
      name: `Instance ${instances.length + 1}`,
      coords: Object.fromEntries(axes.map((a) => [a.tag, coords[a.tag] ?? a.def])),
    };
    set({ instances: [...instances, inst] });
    get().rebuild();
  },

  captureInstance() {
    get().addInstance();
  },

  removeInstance(id) {
    set({ instances: get().instances.filter((i) => i.id !== id) });
    get().rebuild();
  },

  updateInstance(id, patch) {
    set({ instances: get().instances.map((i) => (i.id === id ? { ...i, ...patch } : i)) });
    get().rebuild();
  },

  regenerateInstances() {
    set({ instances: defaultInstances(get().axes) });
    get().rebuild();
  },

  applyInstance(id) {
    const inst = get().instances.find((i) => i.id === id);
    if (!inst) return;
    set({ coords: clampCoords(get().axes, inst.coords) });
  },

  setCoord(tag, value) {
    set({ coords: { ...get().coords, [tag]: value } });
  },

  setPreview(patch) {
    set({ preview: { ...get().preview, ...patch } });
  },

  exportStatics() {
    const { source, axes, instances, familyName, issues } = get();
    if (!source || issues.length > 0 || instances.length === 0) return;

    set({ exportingStatics: true, buildError: null });
    // Yielding first lets the button reach its pending state before the main
    // thread is tied up flattening every instance.
    setTimeout(() => {
      try {
        const statics = buildStaticFonts(source, { familyName, axes, instances });
        const zip = buildZip(statics.map((s) => ({ name: s.fileName, data: s.data })));
        const url = URL.createObjectURL(new Blob([zip.slice().buffer as ArrayBuffer], { type: "application/zip" }));

        const link = document.createElement("a");
        link.href = url;
        link.download = `${(familyName || "Font").replace(/\s+/g, "")}-static.zip`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        set({ exportingStatics: false });
      } catch (e) {
        set({ exportingStatics: false, buildError: e instanceof Error ? e.message : String(e) });
      }
    }, 30);
  },

  rebuild() {
    const { source } = get();
    if (!source) return;

    if (buildTimer) clearTimeout(buildTimer);
    set({ building: true, buildError: null });

    buildTimer = setTimeout(() => {
      const { axes, instances, familyName, built } = get();
      const issues = validateAxes(axes);
      set({ issues });
      if (issues.length > 0) {
        set({ building: false });
        return;
      }

      try {
        const result = buildVariableFont(source, { familyName, axes, instances });
        const blob = new Blob([result.data.slice().buffer as ArrayBuffer], { type: "font/ttf" });
        const url = URL.createObjectURL(blob);

        familyCounter += 1;
        const family = `VFPreview${familyCounter}`;
        const face = new FontFace(family, `url(${url})`);

        face
          .load()
          .then((loaded) => {
            document.fonts.add(loaded);
            if (previewFace) document.fonts.delete(previewFace);
            previewFace = loaded;
            if (built) URL.revokeObjectURL(built.url);
            set({
              built: {
                url,
                family,
                size: result.data.length,
                masterCount: result.masterCount,
                warnings: result.warnings,
              },
              building: false,
            });
          })
          .catch(() => {
            set({
              building: false,
              buildError:
                "The browser rejected the generated font. Try reducing the axis ranges — extreme deformations can push coordinates out of range.",
            });
          });
      } catch (e) {
        set({ building: false, buildError: e instanceof Error ? e.message : String(e) });
      }
    }, 260);
  },
}));

/** Current preview position expressed as a CSS `font-variation-settings` value. */
export function variationSettings(axes: AxisDef[], coords: Record<string, number>) {
  if (axes.length === 0) return "normal";
  return axes.map((a) => `"${a.tag}" ${round(coords[a.tag] ?? a.def)}`).join(", ");
}

export function round(v: number) {
  return Math.round(v * 100) / 100;
}

export { normalize };
