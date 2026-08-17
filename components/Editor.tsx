"use client";

import { motion } from "motion/react";
import { useApp } from "@/lib/store";
import { AxisPanel } from "./AxisPanel";
import { Dropzone } from "./Dropzone";
import { FamilyNameField, InspectorPanel } from "./InspectorPanel";
import { Preview } from "./Preview";

export function Editor() {
  const source = useApp((s) => s.source);
  const building = useApp((s) => s.building);

  if (!source) return <Dropzone />;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      className="flex h-full flex-col"
    >
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-white/6 px-4">
        <div className="flex items-center gap-2.5">
          <span className="flex h-6 w-6 items-center justify-center rounded-md border border-white/10 bg-white/[0.05] text-[12px] font-semibold">
            A
          </span>
          <span className="text-[13px] font-medium tracking-[-0.01em]">Axis</span>
        </div>

        <div className="mx-1 h-4 w-px bg-white/8" />
        <FamilyNameField />

        <div className="ml-auto flex items-center gap-2.5">
          <motion.span
            animate={{ opacity: building ? 1 : 0 }}
            transition={{ duration: 0.15 }}
            className="flex items-center gap-1.5 text-[11.5px] text-[var(--muted)]"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--muted)]" />
            compiling
          </motion.span>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[320px] shrink-0 flex-col border-r border-white/6 bg-[var(--panel)]">
          <AxisPanel />
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <Preview />
        </main>

        <aside className="flex w-[300px] shrink-0 flex-col border-l border-white/6 bg-[var(--panel)]">
          <InspectorPanel />
        </aside>
      </div>
    </motion.div>
  );
}
