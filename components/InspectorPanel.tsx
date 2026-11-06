"use client";

import { useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import { FONT_ACCEPT, useApp } from "@/lib/store";
import { faceLabel } from "@/lib/font/face";
import { Button, Note, Panel, TextInput, cx } from "./ui";
import { Slider } from "./Slider";

export function InspectorPanel() {
  return (
    // The column scrolls as a whole once a family, the numbers card and the
    // instance list no longer fit; the instance list keeps a usable height.
    <div className="scroll-thin flex h-full min-h-0 flex-col overflow-y-auto">
      <SourceCard />
      <div className="h-px shrink-0 bg-white/6" />
      <NumbersCard />
      <div className="h-px shrink-0 bg-white/6" />
      <InstanceList />
      <div className="h-px shrink-0 bg-white/6" />
      <ExportCard />
    </div>
  );
}

function SourceCard() {
  const source = useApp((s) => s.source);
  const faces = useApp((s) => s.faces);
  const reset = useApp((s) => s.reset);
  const loadFiles = useApp((s) => s.loadFiles);
  const loading = useApp((s) => s.loading);
  const loadError = useApp((s) => s.loadError);
  const setDefaultFace = useApp((s) => s.setDefaultFace);
  const toggleFace = useApp((s) => s.toggleFace);
  const removeFace = useApp((s) => s.removeFace);
  const input = useRef<HTMLInputElement>(null);
  if (!source) return null;

  const rows: [string, string][] = [
    ["Format", source.converted ? `${source.format} → TrueType` : source.format],
    ["Glyphs", String(source.metrics.numGlyphs)],
    ["Units per em", String(source.metrics.unitsPerEm)],
    ["Measured stem", `${Math.round(source.shape.stem)} u`],
    ["Default weight", String(source.shape.weight)],
  ];
  const anyItalic = source.roles.some((r) => r.role !== "excluded" && r.italic);

  return (
    <Panel
      title={`Sources · ${faces.length}`}
      action={
        <div className="flex items-center gap-0.5">
          <Button variant="quiet" onClick={() => input.current?.click()} title="Add weights or italics of this family">
            {loading ? "Reading…" : "Add"}
          </Button>
          <Button variant="quiet" onClick={reset} title="Start over with other fonts">
            Replace
          </Button>
        </div>
      }
      className="shrink-0"
    >
      <input
        ref={input}
        type="file"
        accept={FONT_ACCEPT}
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) void loadFiles([...e.target.files]);
          e.target.value = "";
        }}
      />
      <div className="px-3 pb-3.5">
        <div className="scroll-thin flex max-h-[168px] flex-col gap-0.5 overflow-y-auto">
          {source.roles.map((role) => {
            const face = faces.find((f) => f.id === role.id);
            if (!face) return null;
            const canDefault = role.role !== "default" && (!role.italic || !source.roles.some((r) => !r.italic && r.role !== "excluded"));
            const share = role.role === "master" ? role.drawn / Math.max(1, role.total) : null;
            return (
              <div
                key={role.id}
                className={cx(
                  "group flex items-center gap-2 rounded-lg px-1.5 py-1",
                  role.role === "default" ? "bg-white/[0.055]" : "hover:bg-white/[0.03]",
                )}
                title={`${face.fileName} · ${face.format}`}
              >
                <button
                  onClick={() => canDefault && setDefaultFace(role.id)}
                  disabled={!canDefault}
                  aria-label={role.role === "default" ? "Default source" : "Make this the default source"}
                  title={role.role === "default" ? "The default — its outlines are the font's default instance" : canDefault ? "Make this the default" : undefined}
                  className={cx(
                    "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border transition-colors",
                    role.role === "default" ? "border-white/70" : "border-white/20 enabled:hover:border-white/50",
                  )}
                >
                  {role.role === "default" && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                </button>
                <div className="min-w-0 flex-1">
                  <div className={cx("truncate text-[12px]", role.role === "excluded" && "text-[var(--faint)] line-through decoration-white/20")}>
                    {faceLabel(face)}
                  </div>
                  <div className="truncate text-[10.5px] text-[var(--faint)]">
                    {role.role === "excluded"
                      ? role.reason
                      : role.role === "default"
                        ? `default · ${role.weight}${role.italic && anyItalic ? " italic" : ""}`
                        : `${role.weight}${role.italic ? " italic" : ""} · ${Math.round((share ?? 0) * 100)}% drawn`}
                  </div>
                </div>
                {share !== null && share < 0.9 && (
                  <span
                    className="shrink-0 text-[9px] text-[var(--warn)]"
                    title={`${role.role === "master" ? role.total - role.drawn : 0} glyphs could not be matched point for point and are synthesised from the default at this weight.`}
                  >
                    ▲
                  </span>
                )}
                {role.role !== "default" && (
                  <input
                    type="checkbox"
                    checked={role.role === "master"}
                    disabled={role.role === "excluded" && role.reason !== "Turned off"}
                    onChange={() => toggleFace(role.id)}
                    aria-label="Use as a master"
                    title="Use as a master"
                    className="h-3.5 w-3.5 shrink-0 accent-white/80 disabled:opacity-30"
                  />
                )}
                <button
                  onClick={() => removeFace(role.id)}
                  className="shrink-0 rounded px-1 text-[13px] leading-none text-[var(--faint)] opacity-0 transition-all hover:text-[var(--danger)] group-hover:opacity-100"
                  title="Remove this file"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>

        <dl className="mt-2.5 flex flex-col gap-1 border-t border-white/6 pt-2.5">
          {rows.map(([k, v]) => (
            <div key={k} className="flex items-baseline justify-between gap-3">
              <dt className="text-[11.5px] text-[var(--faint)]">{k}</dt>
              <dd className="truncate font-mono text-[11.5px] tabular-nums text-[var(--muted)]">{v}</dd>
            </div>
          ))}
        </dl>

        <div className="mt-2.5 flex flex-col gap-1.5 empty:hidden">
          {loadError && (
            <Note tone="danger">
              <span className="whitespace-pre-line">{loadError}</span>
            </Note>
          )}
          {source.weightMismatch && (
            <Note tone="warn">
              The file declares weight {source.declaredWeight}, but the stems measure like {source.shape.weight}. The
              measurement is being used, so the weight ramp is anchored to what is actually drawn.
            </Note>
          )}
          {source.notes.map((note) => (
            <Note key={note} tone="warn">
              {note}
            </Note>
          ))}
          {source.isAlreadyVariable && (
            <Note tone="warn">This font was already variable. Its default instance is used as the single master.</Note>
          )}
          {source.drawn.length > 0 && (
            <Note>
              Outlines come from every source; kerning, features and names come from the default only.
            </Note>
          )}
        </div>
      </div>
    </Panel>
  );
}

function NumbersCard() {
  const info = useApp((s) => s.figureInfo);
  const figures = useApp((s) => s.figures);
  const setFigures = useApp((s) => s.setFigures);
  if (!info) return null;

  const kind = info.tabular ? "Tabular" : "Proportional";
  const has = (tag: string) => info.features.includes(tag);
  const width = figures.tabularWidth ?? info.widest;

  return (
    <Panel title="Numbers" className="shrink-0">
      <div className="flex flex-col gap-2 px-4 pb-3.5">
        <div className="flex items-baseline justify-between gap-3 text-[11.5px]">
          <span className="text-[var(--faint)]">Default figures</span>
          <span className="font-mono text-[var(--muted)]">{info.digits ? kind : "—"}</span>
        </div>
        <div className="flex items-baseline justify-between gap-3 text-[11.5px]">
          <span className="text-[var(--faint)]">Source has</span>
          <span className="font-mono text-[var(--muted)]">
            {["tnum", "pnum"].filter(has).join(" · ") || "no tnum / pnum"}
          </span>
        </div>

        {!info.digits && <Note>This font does not map all ten digits, so there are no figures to re-space.</Note>}

        {info.digits && !info.generates && (
          <Note>
            Both spacings are already there — design tools offer Monospace and Proportional for this font as it is.
          </Note>
        )}

        {info.generates && (
          <>
            <label className="flex cursor-pointer items-start gap-2 text-[12px]">
              <input
                type="checkbox"
                checked={figures.enabled}
                onChange={(e) => setFigures({ enabled: e.target.checked })}
                className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-white/80"
              />
              <span>
                {info.generates === "tabular" ? "Add tabular figures" : "Add proportional figures"}
                <span className="ml-1.5 font-mono text-[10.5px] text-[var(--faint)]">
                  {info.generates === "tabular" ? "tnum" : "pnum"}
                </span>
              </span>
            </label>

            {figures.enabled && info.generates === "tabular" && (
              <Slider
                size="sm"
                label="Tabular width"
                suffix="u"
                value={width}
                min={info.minWidth}
                max={Math.max(info.widest * 1.5, info.minWidth + 1)}
                step={1}
                resetTo={info.widest}
                onChange={(v) => setFigures({ tabularWidth: Math.round(v) })}
              />
            )}

            <p className="text-[10.5px] leading-relaxed text-[var(--faint)]">
              {info.generates === "tabular"
                ? "Every digit gets the same advance, centred on its own spacing, so columns of numbers line up. The drawings are not changed."
                : "Each digit gets spacing that fits its shape — the 1 stops floating in a wide slot. The drawings are not changed."}{" "}
              In Figma: Type details → Numbers. In CSS: <span className="font-mono">font-variant-numeric</span>.
            </p>
          </>
        )}
      </div>
    </Panel>
  );
}

function InstanceList() {
  const instances = useApp((s) => s.instances);
  const axes = useApp((s) => s.axes);
  const coords = useApp((s) => s.coords);
  const applyInstance = useApp((s) => s.applyInstance);
  const updateInstance = useApp((s) => s.updateInstance);
  const removeInstance = useApp((s) => s.removeInstance);
  const captureInstance = useApp((s) => s.captureInstance);
  const regenerateInstances = useApp((s) => s.regenerateInstances);

  const isActive = (c: Record<string, number>) =>
    axes.every((a) => Math.abs((c[a.tag] ?? a.def) - (coords[a.tag] ?? a.def)) < 0.01);

  return (
    <Panel
      title={`Instances · ${instances.length}`}
      action={
        <div className="flex items-center gap-0.5">
          <Button variant="quiet" onClick={regenerateInstances} title="Rebuild the standard weight ladder">
            Auto
          </Button>
          <Button variant="quiet" onClick={captureInstance} title="Save the current preview position as an instance">
            Capture
          </Button>
        </div>
      }
      className="min-h-[220px] flex-1"
    >
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <div className="flex flex-col gap-1">
          <AnimatePresence initial={false}>
            {instances.map((inst) => (
              <motion.div
                key={inst.id}
                layout
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                className="overflow-hidden"
              >
                <div
                  className={cx(
                    "group flex items-center gap-1.5 rounded-lg border px-1.5 py-1 transition-colors",
                    isActive(inst.coords)
                      ? "border-white/18 bg-white/[0.055]"
                      : "border-transparent hover:border-white/10 hover:bg-white/[0.03]",
                  )}
                >
                  <button
                    onClick={() => applyInstance(inst.id)}
                    className="shrink-0 rounded px-1 text-[11px] text-[var(--faint)] transition-colors hover:text-[var(--text)]"
                    title="Jump the preview to this instance"
                  >
                    ▸
                  </button>
                  <input
                    value={inst.name}
                    onChange={(e) => updateInstance(inst.id, { name: e.target.value })}
                    aria-label="Instance name"
                    className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none"
                  />
                  <span className="shrink-0 font-mono text-[10px] tabular-nums text-[var(--faint)]">
                    {axes.map((a) => Math.round(inst.coords[a.tag] ?? a.def)).join(" ")}
                  </span>
                  <button
                    onClick={() => removeInstance(inst.id)}
                    className="shrink-0 rounded px-1 text-[13px] leading-none text-[var(--faint)] opacity-0 transition-all hover:text-[var(--danger)] group-hover:opacity-100"
                    title="Remove instance"
                  >
                    ×
                  </button>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        {instances.length === 0 && (
          <p className="px-1.5 py-2 text-[11.5px] leading-relaxed text-[var(--faint)]">
            No named instances. Apps will still see the axes, but users get no preset list.
          </p>
        )}
      </div>
    </Panel>
  );
}

function ExportCard() {
  const built = useApp((s) => s.built);
  const building = useApp((s) => s.building);
  const axes = useApp((s) => s.axes);
  const familyName = useApp((s) => s.familyName);
  const issues = useApp((s) => s.issues);
  const exportStatics = useApp((s) => s.exportStatics);
  const exporting = useApp((s) => s.exportingStatics);
  const instanceCount = useApp((s) => s.instances.length);

  const ready = Boolean(built) && !building && issues.length === 0;
  const fileName = `${(familyName || "Font").replace(/\s+/g, "")}[${axes.map((a) => a.tag.trim()).join(",")}].ttf`;

  return (
    <Panel title="Export" className="shrink-0">
      <div className="flex flex-col gap-2.5 px-4 pb-4">
        <div className="flex items-baseline justify-between gap-3 text-[11.5px]">
          <span className="text-[var(--faint)]">Masters</span>
          <span className="font-mono tabular-nums text-[var(--muted)]">
            {built ? built.masterCount + 1 : "—"}
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-3 text-[11.5px]">
          <span className="text-[var(--faint)]">Output size</span>
          <span className="font-mono tabular-nums text-[var(--muted)]">
            {built ? `${(built.size / 1024).toFixed(1)} KB` : "—"}
          </span>
        </div>

        {built?.warnings.map((warning) => (
          <Note key={warning} tone="warn">
            {warning}
          </Note>
        ))}

        <a
          href={built?.url ?? "#"}
          download={fileName}
          aria-disabled={!ready}
          onClick={(e) => {
            if (!ready) e.preventDefault();
          }}
          className={cx(
            "flex h-10 items-center justify-center rounded-lg text-[13px] font-medium transition-all duration-150",
            ready
              ? "bg-white text-black hover:bg-white/90 active:scale-[0.99]"
              : "pointer-events-none bg-white/10 text-[var(--faint)]",
          )}
        >
          {building ? "Building…" : issues.length > 0 ? "Fix axis errors" : "Download variable .ttf"}
        </a>
        <p className="truncate text-center font-mono text-[10.5px] text-[var(--faint)]" title={fileName}>
          {fileName}
        </p>

        <button
          onClick={exportStatics}
          disabled={!ready || instanceCount === 0 || exporting}
          className={cx(
            "flex h-9 items-center justify-center rounded-lg border text-[12.5px] transition-all duration-150",
            ready && instanceCount > 0 && !exporting
              ? "border-white/10 bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.07] active:scale-[0.99]"
              : "pointer-events-none border-white/6 text-[var(--faint)]",
          )}
        >
          {exporting ? "Flattening…" : `Statics .zip · ${instanceCount} files`}
        </button>
        <p className="text-center text-[10.5px] leading-relaxed text-[var(--faint)]">
          One flattened .ttf per named instance — the reliable path when an app will not drive the axes itself.
        </p>
      </div>
    </Panel>
  );
}

export function FamilyNameField() {
  const familyName = useApp((s) => s.familyName);
  const setFamilyName = useApp((s) => s.setFamilyName);
  return <TextInput value={familyName} onChange={setFamilyName} placeholder="Family name" ariaLabel="Family name" className="w-[220px]" />;
}
