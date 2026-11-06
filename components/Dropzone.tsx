"use client";

import { useCallback, useRef, useState } from "react";
import { motion } from "motion/react";
import { FONT_ACCEPT, useApp } from "@/lib/store";
import { Note, cx } from "./ui";

export function Dropzone() {
  const loadFiles = useApp((s) => s.loadFiles);
  const loading = useApp((s) => s.loading);
  const error = useApp((s) => s.loadError);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const accept = useCallback(
    (files: FileList | null) => {
      if (files && files.length > 0) void loadFiles([...files]);
    },
    [loadFiles],
  );

  return (
    <div className="grain flex h-full items-center justify-center px-6">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-[520px]"
      >
        <div className="mb-9 text-center">
          <h1 className="text-[30px] font-semibold leading-tight tracking-[-0.02em]">Make it variable</h1>
          <p className="mx-auto mt-2.5 max-w-[400px] text-[13px] leading-relaxed text-[var(--muted)]">
            Drop one font, or a whole family. Extra weights and italics become real masters; whatever is missing is
            synthesised. Export a single variable <span className="font-mono text-[12px]">.ttf</span>.
          </p>
        </div>

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            accept(e.dataTransfer.files);
          }}
          onClick={() => input.current?.click()}
          className={cx(
            "group relative cursor-pointer rounded-2xl border border-dashed px-8 py-14 text-center transition-all duration-200",
            over ? "border-white/35 bg-white/[0.05]" : "border-white/12 bg-white/[0.02] hover:border-white/25 hover:bg-white/[0.035]",
          )}
        >
          <input
            ref={input}
            type="file"
            accept={FONT_ACCEPT}
            multiple
            className="hidden"
            onChange={(e) => {
              accept(e.target.files);
              e.target.value = "";
            }}
          />

          <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-[17px] font-medium transition-transform duration-200 group-hover:-translate-y-0.5">
            {loading ? <Spinner /> : "A"}
          </div>
          <p className="text-[13.5px] font-medium">{loading ? "Reading outlines…" : "Drop fonts, or click to browse"}</p>
          <p className="mt-1.5 text-[11.5px] text-[var(--faint)]">.ttf · .otf · .woff · .woff2 · .ttc · .otc — several at once for a family</p>
        </div>

        {error && (
          <div className="mt-4">
            <Note tone="danger">
              <span className="whitespace-pre-line">{error}</span>
            </Note>
          </div>
        )}

        <p className="mt-8 text-center text-[11px] leading-relaxed text-[var(--faint)]">
          One master can&apos;t describe a real weight range. Upload the weights you have — Regular and Bold, say — and
          they interpolate as drawn; only the range beyond them is synthesised.
        </p>
      </motion.div>
    </div>
  );
}

function Spinner() {
  return (
    <motion.span
      animate={{ rotate: 360 }}
      transition={{ repeat: Infinity, duration: 0.9, ease: "linear" }}
      className="block h-4 w-4 rounded-full border-[1.5px] border-white/20 border-t-white/80"
    />
  );
}
