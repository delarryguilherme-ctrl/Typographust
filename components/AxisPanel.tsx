"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useApp } from "@/lib/store";
import { REGISTERED_AXES, masterStrain, type AxisDef } from "@/lib/font/axes";
import type { Deformation } from "@/lib/font/transform";
import { Button, Note, Panel, TextInput, cx } from "./ui";
import { Slider } from "./Slider";

export function AxisPanel() {
  const axes = useApp((s) => s.axes);
  const issues = useApp((s) => s.issues);
  const addAxis = useApp((s) => s.addAxis);
  const [adding, setAdding] = useState(false);

  return (
    <Panel
      title="Axes"
      action={
        <button
          onClick={() => setAdding((v) => !v)}
          className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--muted)] transition-colors hover:bg-white/[0.07] hover:text-[var(--text)]"
          title="Add axis"
        >
          <motion.span animate={{ rotate: adding ? 45 : 0 }} transition={{ duration: 0.18 }} className="text-[15px] leading-none">
            +
          </motion.span>
        </button>
      }
      className="min-h-0 flex-1"
    >
      <AnimatePresence initial={false}>
        {adding && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <AddAxis
              existing={axes}
              onAdd={(tag) => {
                addAxis(tag);
                setAdding(false);
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        <div className="flex flex-col gap-1.5">
          {axes.map((axis) => (
            <AxisCard key={axis.id} axis={axis} />
          ))}
        </div>

        {issues.length > 0 && (
          <div className="mt-3 flex flex-col gap-1.5">
            {issues.map((issue) => (
              <Note key={issue} tone="danger">
                {issue}
              </Note>
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}

function AddAxis({ existing, onAdd }: { existing: AxisDef[]; onAdd: (tag: string) => void }) {
  const [custom, setCustom] = useState("");
  const used = new Set(existing.map((a) => a.tag));
  const available = REGISTERED_AXES.filter((a) => !used.has(a.tag));

  return (
    <div className="mx-3 mb-2.5 rounded-xl border border-white/8 bg-white/[0.02] p-2.5">
      <div className="flex flex-wrap gap-1.5">
        {available.map((a) => (
          <button
            key={a.tag}
            onClick={() => onAdd(a.tag)}
            className="rounded-md border border-white/8 bg-white/[0.03] px-2 py-1 text-[11.5px] transition-colors hover:border-white/20 hover:bg-white/[0.08]"
          >
            <span className="font-mono text-[11px] text-[var(--muted)]">{a.tag}</span>
            <span className="ml-1.5">{a.name}</span>
          </button>
        ))}
        {available.length === 0 && <span className="px-1 text-[11.5px] text-[var(--faint)]">All registered axes added.</span>}
      </div>

      <div className="mt-2.5 flex gap-1.5 border-t border-white/8 pt-2.5">
        <TextInput
          value={custom}
          onChange={(v) => setCustom(v.slice(0, 4))}
          placeholder="TRML"
          mono
          maxLength={4}
          ariaLabel="Custom axis tag"
          className="w-[92px]"
        />
        <Button
          onClick={() => {
            const tag = custom.padEnd(4, " ");
            if (custom.trim().length > 0 && !used.has(tag)) onAdd(tag);
            setCustom("");
          }}
          className="h-8 flex-1"
        >
          Add custom axis
        </Button>
      </div>
      <p className="mt-2 text-[10.5px] leading-relaxed text-[var(--faint)]">
        Custom tags are 4 characters and must contain an uppercase letter — all-lowercase tags are reserved for
        registered axes.
      </p>
    </div>
  );
}

function AxisCard({ axis }: { axis: AxisDef }) {
  const selected = useApp((s) => s.selectedAxisId) === axis.id;
  const selectAxis = useApp((s) => s.selectAxis);
  const updateAxis = useApp((s) => s.updateAxis);
  const removeAxis = useApp((s) => s.removeAxis);
  const setCoord = useApp((s) => s.setCoord);
  const addStop = useApp((s) => s.addStop);
  const updateStop = useApp((s) => s.updateStop);
  const upem = useApp((s) => s.source?.metrics.unitsPerEm ?? 1000);
  const coord = useApp((s) => s.coords[axis.tag]);

  const shape = useApp((s) => s.source?.shape);
  const [stopId, setStopId] = useState<string | null>(axis.stops[axis.stops.length - 1]?.id ?? null);
  const stop = axis.stops.find((s) => s.id === stopId) ?? axis.stops[0] ?? null;
  const strain = stop && shape ? masterStrain(stop, shape) : null;

  // A master only shows in the preview at its own position on the axis, so
  // selecting or editing one moves the preview there.
  const showStop = (at: number) => setCoord(axis.tag, at);

  const selectStop = (id: string, at: number) => {
    setStopId(id);
    showStop(at);
  };

  const insertStop = () => {
    const here = coord ?? axis.def;
    const taken = here === axis.def || axis.stops.some((s) => s.at === here);
    const at = taken ? Number(((axis.def + axis.max) / 2).toFixed(2)) : here;
    const id = addStop(axis.id, at);
    if (id) selectStop(id, at);
  };

  const range = axisRange(axis);

  return (
    <div
      className={cx(
        "overflow-hidden rounded-xl border transition-colors duration-150",
        selected ? "border-white/18 bg-white/[0.045]" : "border-white/8 bg-white/[0.02] hover:border-white/14",
      )}
    >
      <button
        onClick={() => selectAxis(selected ? null : axis.id)}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left"
      >
        <span className="rounded-[5px] bg-white/[0.07] px-1.5 py-0.5 font-mono text-[10.5px] tracking-tight text-[var(--muted)]">
          {axis.tag.trim()}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px]">{axis.name}</span>
        <span className="font-mono text-[10.5px] tabular-nums text-[var(--faint)]">
          {axis.min}–{axis.max}
        </span>
        <motion.span
          animate={{ rotate: selected ? 90 : 0 }}
          transition={{ duration: 0.18 }}
          className="text-[11px] text-[var(--faint)]"
        >
          ›
        </motion.span>
      </button>

      <AnimatePresence initial={false}>
        {selected && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <div className="space-y-3 border-t border-white/8 px-3 py-3">
              <div className="flex gap-1.5">
                <TextInput
                  value={axis.name}
                  onChange={(v) => updateAxis(axis.id, { name: v })}
                  placeholder="Axis name"
                  ariaLabel="Axis name"
                  className="min-w-0 flex-1"
                />
                <TextInput
                  value={axis.tag}
                  onChange={(v) => updateAxis(axis.id, { tag: v.slice(0, 4) })}
                  mono
                  maxLength={4}
                  ariaLabel="Axis tag"
                  className="w-[68px]"
                />
              </div>

              <div className="flex flex-col gap-1">
                {(["min", "def", "max"] as const).map((key) => (
                  <Slider
                    key={key}
                    size="sm"
                    clampInput={false}
                    label={key === "def" ? "Default" : key === "min" ? "Minimum" : "Maximum"}
                    value={axis[key]}
                    min={range.lo}
                    max={range.hi}
                    step={range.step}
                    onChange={(v) => updateAxis(axis.id, { [key]: v })}
                  />
                ))}
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="whitespace-nowrap text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[var(--faint)]">
                    Masters
                  </span>
                  <button
                    onClick={insertStop}
                    title="Add a master at the current preview position"
                    className="rounded-md px-1.5 text-[16px] leading-none text-[var(--muted)] transition-colors hover:bg-white/[0.07] hover:text-[var(--text)]"
                  >
                    +
                  </button>
                </div>

                <StopChips
                  axis={axis}
                  selectedId={stop?.id ?? null}
                  onSelect={selectStop}
                />

                {axis.tag === "ital" && (
                  <p className="mt-2 px-0.5 text-[10.5px] leading-relaxed text-[var(--faint)]">
                    Italic here is the roman sheared over, not a cursive redrawing — no single-storey{" "}
                    <span className="font-mono">a</span>, no entry strokes. Passable on a geometric sans, plainly
                    wrong on a serif.
                  </p>
                )}

                {strain && (
                  <p className="mt-2 rounded-lg border border-[var(--warn)]/25 bg-[var(--warn)]/8 px-2.5 py-1.5 text-[10.5px] leading-relaxed text-[var(--warn)]">
                    {strain}
                  </p>
                )}

                {stop ? (
                  <div className="mt-2 flex flex-col gap-1">
                    <Slider
                      size="sm"
                      label="Position"
                      value={stop.at}
                      min={axis.min}
                      max={axis.max}
                      step={range.step}
                      onChange={(v) => {
                        updateStop(axis.id, stop.id, { at: v });
                        showStop(v);
                      }}
                    />
                    <DeformationEditor
                      axisId={axis.id}
                      stopId={stop.id}
                      value={stop.deformation}
                      upem={upem}
                      onEdit={() => showStop(stop.at)}
                    />
                  </div>
                ) : (
                  <p className="mt-2 px-0.5 text-[11px] leading-relaxed text-[var(--faint)]">
                    No masters, so this axis has no effect. Add one to shape a position on it.
                  </p>
                )}
              </div>

              <div className="flex items-center justify-between border-t border-white/8 pt-2.5">
                <label className="flex cursor-pointer items-center gap-2 text-[11.5px] text-[var(--muted)]">
                  <input
                    type="checkbox"
                    checked={axis.hidden}
                    onChange={(e) => updateAxis(axis.id, { hidden: e.target.checked })}
                    className="h-3.5 w-3.5 accent-white/80"
                  />
                  Hidden from font pickers
                </label>
                <Button variant="danger" onClick={() => removeAxis(axis.id)}>
                  Remove
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

interface Field {
  key: keyof Deformation;
  label: string;
  step: number;
  suffix?: string;
  /** Display multiplier — scales are edited as percentages. */
  scale?: number;
  /** Slider bounds, as a fraction of the em when `em` is true. */
  lo: number;
  hi: number;
  em?: boolean;
}

const FIELDS: Field[] = [
  { key: "weight", label: "Weight", step: 0.5, suffix: "u", lo: -0.12, hi: 0.12, em: true },
  { key: "grade", label: "Grade", step: 0.5, suffix: "u", lo: -0.12, hi: 0.12, em: true },
  { key: "slant", label: "Slant", step: 0.25, suffix: "°", lo: -30, hi: 30 },
  { key: "widthScale", label: "Width", step: 0.5, suffix: "%", scale: 100, lo: 50, hi: 160 },
  { key: "heightScale", label: "Height", step: 0.5, suffix: "%", scale: 100, lo: 50, hi: 160 },
  { key: "tracking", label: "Tracking", step: 1, suffix: "u", lo: -0.15, hi: 0.3, em: true },
  { key: "advanceDelta", label: "Advance", step: 1, suffix: "u", lo: -0.3, hi: 0.3, em: true },
  { key: "yShift", label: "Y shift", step: 1, suffix: "u", lo: -0.3, hi: 0.3, em: true },
];

/**
 * The masters on an axis, laid out in axis order with the default marked. The
 * default is not selectable — it is the source outline.
 */
function StopChips({
  axis,
  selectedId,
  onSelect,
}: {
  axis: AxisDef;
  selectedId: string | null;
  onSelect: (id: string, at: number) => void;
}) {
  const removeStop = useApp((s) => s.removeStop);
  const shape = useApp((s) => s.source?.shape);
  const entries = [
    ...axis.stops.map((s) => ({
      kind: "stop" as const,
      at: s.at,
      id: s.id,
      strain: shape ? masterStrain(s, shape) : null,
    })),
    { kind: "default" as const, at: axis.def, id: "default", strain: null },
  ].sort((a, b) => a.at - b.at);

  return (
    <div className="flex flex-wrap gap-1">
      {entries.map((entry) =>
        entry.kind === "default" ? (
          <span
            key="default"
            title="The axis default — this is the outline you uploaded"
            className="rounded-md border border-dashed border-white/14 px-1.5 py-1 font-mono text-[11px] tabular-nums text-[var(--faint)]"
          >
            {entry.at}
          </span>
        ) : (
          <span key={entry.id} className="group relative">
            <button
              onClick={() => onSelect(entry.id, entry.at)}
              title={entry.strain ?? undefined}
              className={cx(
                "rounded-md border px-1.5 py-1 font-mono text-[11px] tabular-nums transition-colors",
                entry.id === selectedId
                  ? "border-white/30 bg-white/[0.12] text-[var(--text)]"
                  : "border-white/8 bg-white/[0.03] text-[var(--muted)] hover:border-white/20 hover:text-[var(--text)]",
                entry.strain && "text-[var(--warn)]",
              )}
            >
              {entry.at}
              {entry.strain && <span className="ml-1 align-super text-[8px] leading-none">▲</span>}
            </button>
            <button
              onClick={() => removeStop(axis.id, entry.id)}
              title="Remove this master"
              className="absolute -right-1 -top-1 hidden h-3.5 w-3.5 items-center justify-center rounded-full border border-white/15 bg-[var(--panel-2)] text-[10px] leading-none text-[var(--muted)] hover:text-[var(--danger)] group-hover:flex"
            >
              ×
            </button>
          </span>
        ),
      )}
    </div>
  );
}

function DeformationEditor({
  axisId,
  stopId,
  value,
  upem,
  onEdit,
}: {
  axisId: string;
  stopId: string;
  value: Deformation;
  upem: number;
  onEdit: () => void;
}) {
  const update = useApp((s) => s.updateStopDeformation);

  return (
    <div className="flex flex-col gap-1">
      {FIELDS.map((f) => {
        const scale = f.scale ?? 1;
        const lo = f.em ? Math.round(f.lo * upem) : f.lo;
        const hi = f.em ? Math.round(f.hi * upem) : f.hi;
        return (
          <Slider
            key={f.key}
            size="sm"
            clampInput={false}
            label={f.label}
            suffix={f.suffix}
            step={f.step}
            min={lo}
            max={hi}
            resetTo={f.scale ? 100 : 0}
            value={Math.round(value[f.key] * scale * 100) / 100}
            onChange={(v) => {
              onEdit();
              update(axisId, stopId, { [f.key]: v / scale } as Partial<Deformation>);
            }}
          />
        );
      })}
    </div>
  );
}

/** Slider bounds for an axis's own min/def/max — a suggestion, not a limit. */
function axisRange(axis: AxisDef) {
  const presets: Record<string, [number, number, number]> = {
    wght: [1, 1000, 1],
    wdth: [25, 200, 0.5],
    slnt: [-90, 90, 0.5],
    ital: [0, 1, 0.01],
    opsz: [5, 300, 0.5],
    GRAD: [-1000, 1000, 1],
  };
  const preset = presets[axis.tag];
  if (preset) return { lo: preset[0], hi: preset[1], step: preset[2] };

  // Custom axes have no conventional range, so follow the one in use.
  const span = Math.max(1, axis.max - axis.min);
  const lo = axis.min - span;
  const hi = axis.max + span;
  return { lo, hi, step: hi - lo <= 4 ? 0.01 : 1 };
}
