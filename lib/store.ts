"use client";

import { create } from "zustand";
import { loadFaces, type SourceFont } from "./font/build";
import { buildInWorker, cancelBuild, exportStaticsInWorker, isSuperseded } from "./buildClient";
import {
  defaultInstances,
  deformationAt,
  makeAxis,
  makeFamilyAxes,
  makeStop,
  newId,
  normalize,
  validateAxes,
  type AxisDef,
  type AxisStop,
  type CornerMaster,
  type NamedInstance,
} from "./font/axes";
import type { SourceFace } from "./font/face";
import { assembleFamily } from "./font/family";
import { analyzeFigures, DEFAULT_FIGURES, type FigureInfo, type FigureOptions } from "./font/figures";
import type { Deformation } from "./font/transform";

export type PreviewMode = "text" | "waterfall" | "glyphs" | "numbers";

/** Formats the file picker offers. Detection is by content, not extension. */
export const FONT_ACCEPT = ".ttf,.otf,.woff,.woff2,.ttc,.otc,font/ttf,font/otf,font/woff,font/woff2,font/collection";

export interface BuiltFont {
  url: string;
  family: string;
  size: number;
  masterCount: number;
  warnings: string[];
}

interface AppState {
  /** Every font read from the uploaded files; a collection contributes several. */
  faces: SourceFace[];
  defaultFaceId: string | null;
  excludedFaceIds: string[];
  /** The family as assembled from `faces`: the default plus its drawn masters. */
  source: SourceFont | null;
  loadError: string | null;
  loading: boolean;

  /** Drawn masters that sit off the axes, such as a Bold Italic. */
  corners: CornerMaster[];
  figures: FigureOptions;
  figureInfo: FigureInfo | null;

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

  /** Reads the files and adds them to the family (or starts one). */
  loadFiles: (files: File[]) => Promise<void>;
  reset: () => void;
  setDefaultFace: (id: string) => void;
  toggleFace: (id: string) => void;
  removeFace: (id: string) => void;
  setFigures: (patch: Partial<FigureOptions>) => void;

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
/** Bumped by every rebuild and reset; a result is only applied if it is still the latest. */
let buildTicket = 0;

function clampCoords(axes: AxisDef[], coords: Record<string, number>) {
  const next: Record<string, number> = {};
  for (const a of axes) {
    const current = coords[a.tag];
    next[a.tag] = current === undefined ? a.def : Math.min(a.max, Math.max(a.min, current));
  }
  return next;
}

/** What the weight and italic axes are built from: the default and its drawn masters. */
function drawnSignature(source: SourceFont) {
  const def = source.roles.find((r) => r.role === "default");
  const drawn = source.drawn.map((d) => `${d.id}:${d.weight}:${d.italic}`).sort();
  return [def?.id, source.italic, ...drawn].join("|");
}

interface Previous {
  axes: AxisDef[];
  corners: CornerMaster[];
  instances: NamedInstance[];
  coords: Record<string, number>;
  selectedAxisId: string | null;
  familyName: string;
  figures: FigureOptions;
  source: SourceFont | null;
}

/**
 * Re-assembles the family after the set of faces or their roles changed.
 *
 * The user's work survives whenever it still applies: if the default and its
 * drawn masters are unchanged (a face from another family was added, say), the
 * axes stay exactly as edited; other axes are always kept; instances are kept
 * as long as the set of axis tags is the same. Only when the drawn masters
 * themselves change are the weight and italic axes rebuilt around them.
 */
function assemble(faces: SourceFace[], defaultFaceId: string | null, excluded: string[], previous: Previous) {
  const source = assembleFamily(faces, { defaultId: defaultFaceId, excluded: new Set(excluded) });

  let axes: AxisDef[];
  let corners: CornerMaster[];
  const unchanged = previous.source !== null && drawnSignature(previous.source) === drawnSignature(source);
  if (unchanged) {
    axes = previous.axes;
    corners = previous.corners;
  } else {
    let familyAxes: AxisDef[];
    if (source.drawn.length > 0) {
      ({ axes: familyAxes, corners } = makeFamilyAxes(source.shape, source.drawn, source.italic));
    } else {
      // Seed with the axes that make sense for a single-master source: weight
      // first, then `ital` rather than `slnt` — design tools and CSS treat
      // `ital` as the italic switch, while `slnt` is just another slider. An
      // italic source is already italic, so it gets no italic axis.
      familyAxes = source.italic
        ? [makeAxis("wght", source.shape)]
        : [makeAxis("wght", source.shape), makeAxis("ital", source.shape)];
      corners = [];
    }
    const kept = previous.axes.filter((a) => a.tag !== "wght" && a.tag !== "ital" && !a.stops.some((s) => s.faceId));
    axes = [...familyAxes, ...kept];
  }

  const tags = (list: AxisDef[]) =>
    list
      .map((a) => a.tag)
      .sort()
      .join(",");
  const sameTags = previous.instances.length > 0 && tags(previous.axes) === tags(axes);
  const instances = sameTags
    ? previous.instances.map((i) => ({ ...i, coords: clampCoords(axes, i.coords) }))
    : defaultInstances(axes, source.italic);

  // Suffixed so the export never collides with the static already installed
  // under the same name. A name the user typed survives re-assembly, and so
  // do figure settings — but a tabular width in another font's units would
  // be meaningless, so a different family starts from the defaults.
  const sameFamily =
    previous.source?.familyName === source.familyName &&
    previous.source?.metrics.unitsPerEm === source.metrics.unitsPerEm;
  const familyName = sameFamily && previous.familyName ? previous.familyName : `${source.familyName} VF`;
  const figures = sameFamily ? previous.figures : DEFAULT_FIGURES;

  return {
    source,
    defaultFaceId: faces.find((f) => source.roles.some((r) => r.id === f.id && r.role === "default"))?.id ?? null,
    axes,
    corners,
    instances,
    familyName,
    figures,
    figureInfo: analyzeFigures(source),
    selectedAxisId: axes.some((a) => a.id === previous.selectedAxisId)
      ? previous.selectedAxisId
      : (axes[0]?.id ?? null),
    coords: clampCoords(axes, sameTags ? previous.coords : {}),
    issues: validateAxes(axes),
  };
}

export const useApp = create<AppState>((set, get) => ({
  faces: [],
  defaultFaceId: null,
  excludedFaceIds: [],
  source: null,
  loadError: null,
  loading: false,
  corners: [],
  figures: DEFAULT_FIGURES,
  figureInfo: null,

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

  async loadFiles(files) {
    if (files.length === 0) return;
    set({ loading: true, loadError: null });

    const added: SourceFace[] = [];
    const failed: string[] = [];
    for (const file of files) {
      try {
        added.push(...(await loadFaces(new Uint8Array(await file.arrayBuffer()), file.name)));
      } catch (e) {
        failed.push(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const loadError = failed.length ? failed.join("\n") : null;
    if (added.length === 0) {
      set({ loading: false, loadError });
      return;
    }

    try {
      const { faces, defaultFaceId, excludedFaceIds } = get();
      const nextFaces = [...faces, ...added];
      set({
        ...assemble(nextFaces, defaultFaceId, excludedFaceIds, previousOf(get())),
        faces: nextFaces,
        loading: false,
        loadError,
        built: get().built,
        buildError: null,
      });
      get().rebuild();
    } catch (e) {
      set({ loading: false, loadError: e instanceof Error ? e.message : String(e) });
    }
  },

  reset() {
    if (buildTimer) clearTimeout(buildTimer);
    buildTimer = null;
    buildTicket += 1;
    cancelBuild();
    if (previewFace) document.fonts.delete(previewFace);
    previewFace = null;
    if (get().built) URL.revokeObjectURL(get().built!.url);
    set({
      figures: DEFAULT_FIGURES,
      building: false,
      faces: [],
      defaultFaceId: null,
      excludedFaceIds: [],
      source: null,
      corners: [],
      figureInfo: null,
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

  setDefaultFace(id) {
    const { faces, excludedFaceIds } = get();
    const excluded = excludedFaceIds.filter((x) => x !== id);
    set({ ...assemble(faces, id, excluded, previousOf(get())), excludedFaceIds: excluded });
    get().rebuild();
  },

  toggleFace(id) {
    const { faces, defaultFaceId, excludedFaceIds } = get();
    if (id === defaultFaceId) return;
    const excluded = excludedFaceIds.includes(id) ? excludedFaceIds.filter((x) => x !== id) : [...excludedFaceIds, id];
    set({ ...assemble(faces, defaultFaceId, excluded, previousOf(get())), excludedFaceIds: excluded });
    get().rebuild();
  },

  removeFace(id) {
    const { faces, defaultFaceId, excludedFaceIds } = get();
    const next = faces.filter((f) => f.id !== id);
    if (next.length === 0) {
      get().reset();
      return;
    }
    const excluded = excludedFaceIds.filter((x) => x !== id);
    const nextDefault = defaultFaceId === id ? null : defaultFaceId;
    set({ ...assemble(next, nextDefault, excluded, previousOf(get())), faces: next, excludedFaceIds: excluded });
    get().rebuild();
  },

  setFigures(patch) {
    set({ figures: { ...get().figures, ...patch } });
    get().rebuild();
  },

  setFamilyName(name) {
    set({ familyName: name });
    get().rebuild();
  },

  addAxis(tag) {
    const { source, axes, coords } = get();
    if (!source) return;
    if (axes.some((a) => a.tag === tag)) return;
    // Re-adding the weight or italic axis of a family brings its drawn masters
    // back, rather than a synthetic-only axis that silently ignores them.
    const family =
      (tag === "wght" || tag === "ital") && source.drawn.length > 0
        ? makeFamilyAxes(source.shape, source.drawn, source.italic)
        : null;
    const axis = family?.axes.find((a) => a.tag === tag) ?? makeAxis(tag, source.shape);
    const next = [...axes, axis];
    set({
      ...(family ? { corners: family.corners } : {}),
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
    const before = get().axes.find((a) => a.id === id);
    const next = get().axes.map((a) => (a.id === id ? { ...a, ...patch } : a));
    // Corner masters and instances address axes by tag; follow a rename.
    const renamed = before && patch.tag !== undefined && patch.tag !== before.tag ? [before.tag, patch.tag] : null;
    const retag = (coords: Record<string, number>) => {
      if (!renamed || !(renamed[0] in coords)) return coords;
      const { [renamed[0]]: value, ...rest } = coords;
      return { ...rest, [renamed[1]]: value };
    };
    set({
      axes: next,
      coords: clampCoords(next, retag(get().coords)),
      issues: validateAxes(next),
      ...(renamed
        ? {
            corners: get().corners.map((c) => ({ ...c, coords: retag(c.coords) })),
            instances: get().instances.map((i) => ({ ...i, coords: retag(i.coords) })),
          }
        : {}),
    });
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
    // The first free number, so deleting one and capturing again cannot
    // produce two instances (and two static files) with the same name.
    const taken = new Set(instances.map((i) => i.name.trim()));
    let n = instances.length + 1;
    for (let k = 1; k <= instances.length + 1; k++) {
      if (!taken.has(`Instance ${k}`)) {
        n = k;
        break;
      }
    }
    const inst: NamedInstance = {
      id: newId("inst"),
      name: `Instance ${n}`,
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
    set({ instances: defaultInstances(get().axes, get().source?.italic) });
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
    const { source, axes, instances, familyName, issues, corners, figures } = get();
    if (!source || issues.length > 0 || instances.length === 0) return;

    set({ exportingStatics: true, buildError: null });
    exportStaticsInWorker(source, { familyName, axes, instances, corners, figures })
      .then(({ zip }) => {
        const url = URL.createObjectURL(new Blob([zip.slice().buffer as ArrayBuffer], { type: "application/zip" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = `${(familyName || "Font").replace(/\s+/g, "")}-static.zip`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        set({ exportingStatics: false });
      })
      .catch((e) => {
        set({ exportingStatics: false, buildError: e instanceof Error ? e.message : String(e) });
      });
  },

  rebuild() {
    if (!get().source) return;

    if (buildTimer) clearTimeout(buildTimer);
    const ticket = ++buildTicket;
    set({ building: true, buildError: null });

    buildTimer = setTimeout(() => {
      buildTimer = null;
      // Read at fire time, so the build always reflects the latest state.
      const { source, axes, instances, familyName, corners, figures } = get();
      if (!source) return;
      const issues = validateAxes(axes);
      set({ issues });
      if (issues.length > 0) {
        set({ building: false });
        return;
      }

      // Builds run in a worker, so the page stays responsive; a newer request
      // supersedes an older one, and only the latest result is ever applied.
      const current = () => ticket === buildTicket;
      buildInWorker(source, { familyName, axes, instances, corners, figures })
        .then(async (result) => {
          if (!current()) return;
          const blob = new Blob([result.data.slice().buffer as ArrayBuffer], { type: "font/ttf" });
          const url = URL.createObjectURL(blob);
          familyCounter += 1;
          const family = `VFPreview${familyCounter}`;
          let loaded: FontFace;
          try {
            loaded = await new FontFace(family, `url(${url})`).load();
          } catch {
            URL.revokeObjectURL(url);
            if (current()) {
              set({
                building: false,
                buildError:
                  "The browser rejected the generated font. Try reducing the axis ranges — extreme deformations can push coordinates out of range.",
              });
            }
            return;
          }
          // A newer build may have started while this one was loading.
          if (!current()) {
            URL.revokeObjectURL(url);
            return;
          }
          document.fonts.add(loaded);
          if (previewFace) document.fonts.delete(previewFace);
          previewFace = loaded;
          const previous = get().built;
          if (previous) URL.revokeObjectURL(previous.url);
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
        .catch((e) => {
          if (isSuperseded(e) || !current()) return;
          set({ building: false, buildError: e instanceof Error ? e.message : String(e) });
        });
    }, 260);
  },
}));

function previousOf(state: AppState): Previous {
  const { axes, corners, instances, coords, selectedAxisId, familyName, figures, source } = state;
  return { axes, corners, instances, coords, selectedAxisId, familyName, figures, source };
}

/** Current preview position expressed as a CSS `font-variation-settings` value. */
export function variationSettings(axes: AxisDef[], coords: Record<string, number>) {
  if (axes.length === 0) return "normal";
  return axes.map((a) => `"${a.tag}" ${round(coords[a.tag] ?? a.def)}`).join(", ");
}

export function round(v: number) {
  return Math.round(v * 100) / 100;
}

export { normalize };
