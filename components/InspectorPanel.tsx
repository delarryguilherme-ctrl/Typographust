"use client";

import { AnimatePresence, motion } from "motion/react";
import { useApp } from "@/lib/store";
import { Button, Note, Panel, TextInput, cx } from "./ui";

export function InspectorPanel() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <SourceCard />
      <div className="h-px shrink-0 bg-white/6" />
      <InstanceList />
      <div className="h-px shrink-0 bg-white/6" />
      <ExportCard />
    </div>
  );
}

function SourceCard() {
  const source = useApp((s) => s.source);
  const reset = useApp((s) => s.reset);
  if (!source) return null;

  const rows: [string, string][] = [
    ["File", source.fileName],
    ["Glyphs", String(source.metrics.numGlyphs)],
    ["Units per em", String(source.metrics.unitsPerEm)],
    ["Measured stem", `${Math.round(source.shape.stem)} u`],
    ["Source weight", String(source.shape.weight)],
  ];

  return (
    <Panel title="Source" action={<Button variant="quiet" onClick={reset}>Replace</Button>} className="shrink-0">
      <div className="px-4 pb-3.5">
        <dl className="flex flex-col gap-1">
          {rows.map(([k, v]) => (
            <div key={k} className="flex items-baseline justify-between gap-3">
              <dt className="text-[11.5px] text-[var(--faint)]">{k}</dt>
              <dd className="truncate font-mono text-[11.5px] tabular-nums text-[var(--muted)]">{v}</dd>
            </div>
          ))}
        </dl>
        {source.weightMismatch && (
          <div className="mt-2.5">
            <Note tone="warn">
              The file declares weight {source.declaredWeight}, but the stems measure like {source.shape.weight}. The
              measurement is being used, so the weight ramp is anchored to what is actually drawn.
            </Note>
          </div>
        )}
        {source.isAlreadyVariable && (
          <div className="mt-2.5">
            <Note tone="warn">This font was already variable. Its default instance is used as the single master.</Note>
          </div>
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
      className="min-h-0 flex-1"
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
