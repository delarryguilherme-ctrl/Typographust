"use client";

import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useApp, variationSettings } from "@/lib/store";
import { NumberField, Toggle, cx } from "./ui";
import { Slider } from "./Slider";

const WATERFALL = [14, 18, 24, 32, 44, 60, 84];
const GLYPH_SET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.,;:!?'\"()[]{}@#$%&*+-=/\\<>~^ÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÑÒÓÔÕÖÙÚÛÜàáâãäåçèéêëìíîïñòóôõöùúûüß";

export function Preview() {
  const built = useApp((s) => s.built);
  const building = useApp((s) => s.building);
  const buildError = useApp((s) => s.buildError);
  const axes = useApp((s) => s.axes);
  const coords = useApp((s) => s.coords);
  const preview = useApp((s) => s.preview);
  const setPreview = useApp((s) => s.setPreview);

  const style: React.CSSProperties = {
    fontFamily: built ? `"${built.family}"` : "inherit",
    fontVariationSettings: variationSettings(axes, coords),
    letterSpacing: `${preview.letterSpacing}em`,
    lineHeight: preview.lineHeight,
    textAlign: preview.align,
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-white/6 px-4">
        <div className="w-[228px]">
          <Toggle
            value={preview.mode}
            onChange={(v) => setPreview({ mode: v as typeof preview.mode })}
            options={[
              { value: "text", label: "Text" },
              { value: "waterfall", label: "Waterfall" },
              { value: "glyphs", label: "Glyphs" },
            ]}
          />
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <NumberField label="size" suffix="px" value={preview.size} min={8} max={400} onChange={(v) => setPreview({ size: v })} className="w-[104px]" />
          <NumberField label="lh" value={preview.lineHeight} min={0.6} max={3} step={0.01} onChange={(v) => setPreview({ lineHeight: v })} className="w-[86px]" />
          <NumberField label="ls" suffix="em" value={preview.letterSpacing} min={-0.2} max={1} step={0.005} onChange={(v) => setPreview({ letterSpacing: v })} className="w-[102px]" />
          <div className="w-[104px]">
            <Toggle
              value={preview.align}
              onChange={(v) => setPreview({ align: v as "left" | "center" })}
              options={[
                { value: "left", label: "Left" },
                { value: "center", label: "Center" },
              ]}
            />
          </div>
        </div>
      </div>

      <div className="scroll-thin relative min-h-0 flex-1 overflow-auto">
        <AnimatePresence>
          {buildError && (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="absolute inset-x-4 top-3 z-10 rounded-lg border border-[var(--danger)]/25 bg-[var(--danger)]/10 px-3 py-2 text-[12px] text-[var(--danger)]"
            >
              {buildError}
            </motion.div>
          )}
        </AnimatePresence>

        <div className={cx("px-8 py-10 transition-opacity duration-200", building && "opacity-45")}>
          {preview.mode === "text" && <EditableText style={style} size={preview.size} />}
          {preview.mode === "waterfall" && <Waterfall style={style} />}
          {preview.mode === "glyphs" && <Glyphs style={style} />}
        </div>
      </div>

      <AxisSliders />
    </div>
  );
}

function EditableText({ style, size }: { style: React.CSSProperties; size: number }) {
  const text = useApp((s) => s.preview.text);
  const setPreview = useApp((s) => s.setPreview);
  const ref = useRef<HTMLDivElement>(null);

  // Seeded once so typing never fights the caret with a controlled re-render.
  useEffect(() => {
    if (ref.current && ref.current.innerText.trim() === "") ref.current.innerText = text;
  }, [text]);

  return (
    <div
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      onInput={(e) => setPreview({ text: (e.target as HTMLDivElement).innerText })}
      style={{ ...style, fontSize: size }}
      className="min-h-[40vh] whitespace-pre-wrap break-words outline-none"
    />
  );
}

function Waterfall({ style }: { style: React.CSSProperties }) {
  const text = useApp((s) => s.preview.text).split("\n")[0] || "Handgloves";
  return (
    <div className="flex flex-col gap-5">
      {WATERFALL.map((size) => (
        <div key={size} className="flex items-baseline gap-5">
          <span className="w-9 shrink-0 pt-1 text-right font-mono text-[10.5px] tabular-nums text-[var(--faint)]">{size}</span>
          <div style={{ ...style, fontSize: size }} className="min-w-0 flex-1 truncate">
            {text}
          </div>
        </div>
      ))}
    </div>
  );
}

function Glyphs({ style }: { style: React.CSSProperties }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(72px,1fr))] gap-px overflow-hidden rounded-xl border border-white/8 bg-white/[0.06]">
      {[...GLYPH_SET].map((ch, i) => (
        <div key={`${ch}-${i}`} className="flex h-[72px] items-center justify-center bg-[var(--bg)] transition-colors hover:bg-white/[0.04]">
          <span style={{ ...style, fontSize: 30, letterSpacing: 0, textAlign: "center" }}>{ch}</span>
        </div>
      ))}
    </div>
  );
}

function AxisSliders() {
  const axes = useApp((s) => s.axes);
  const coords = useApp((s) => s.coords);
  const setCoord = useApp((s) => s.setCoord);
  if (axes.length === 0) return null;

  return (
    <div className="shrink-0 border-t border-white/6 bg-[var(--panel)]/60 px-4 py-3">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(230px,1fr))] gap-2">
        {axes.map((axis) => (
          <Slider
            key={axis.id}
            tag={axis.tag.trim()}
            label={axis.name}
            value={coords[axis.tag] ?? axis.def}
            min={axis.min}
            max={axis.max}
            step={axis.max - axis.min <= 4 ? 0.01 : 1}
            resetTo={axis.def}
            onChange={(v) => setCoord(axis.tag, v)}
          />
        ))}
      </div>
    </div>
  );
}
