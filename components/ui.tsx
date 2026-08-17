"use client";

import { useEffect, useRef, useState } from "react";

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

export function Button({
  children,
  onClick,
  variant = "ghost",
  disabled,
  className,
  title,
  type = "button",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: "ghost" | "solid" | "quiet" | "danger";
  disabled?: boolean;
  className?: string;
  title?: string;
  type?: "button" | "submit";
}) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-lg text-[13px] font-medium transition-all duration-150 outline-none disabled:opacity-40 disabled:pointer-events-none focus-visible:ring-1 focus-visible:ring-white/40";
  const variants = {
    solid: "bg-white text-black px-3.5 h-9 hover:bg-white/90 active:scale-[0.985]",
    ghost: "border border-white/10 bg-white/[0.03] px-3.5 h-9 hover:bg-white/[0.07] hover:border-white/20",
    quiet: "px-2 h-7 text-[var(--muted)] hover:text-[var(--text)] hover:bg-white/[0.06] rounded-md",
    danger: "px-2 h-7 text-[var(--muted)] hover:text-[var(--danger)] hover:bg-[var(--danger)]/10 rounded-md",
  } as const;
  return (
    <button type={type} title={title} onClick={onClick} disabled={disabled} className={cx(base, variants[variant], className)}>
      {children}
    </button>
  );
}

export function Panel({
  title,
  action,
  children,
  className,
}: {
  title?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cx("flex flex-col", className)}>
      {title && (
        <header className="flex h-9 shrink-0 items-center justify-between gap-2 px-4">
          <h2 className="truncate whitespace-nowrap text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[var(--faint)]">
            {title}
          </h2>
          {action && <div className="flex shrink-0 items-center">{action}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  mono,
  maxLength,
  className,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  maxLength?: number;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <input
      aria-label={ariaLabel}
      value={value}
      maxLength={maxLength}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className={cx(
        // No width here on purpose — callers own it, so `flex-1` and fixed
        // widths don't fight a base `w-full` in the generated stylesheet.
        "h-8 rounded-md border border-white/8 bg-white/[0.03] px-2.5 text-[13px] text-[var(--text)] placeholder:text-[var(--faint)] outline-none transition-colors focus:border-white/25 focus:bg-white/[0.06]",
        mono && "font-mono tracking-tight",
        className,
      )}
    />
  );
}

/** Number field that can be scrubbed by dragging horizontally, Framer-style. */
export function NumberField({
  value,
  onChange,
  step = 1,
  min = -Infinity,
  max = Infinity,
  suffix,
  label,
  className,
}: {
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
  label?: string;
  className?: string;
}) {
  const [text, setText] = useState(String(round(value)));
  const editing = useRef(false);
  const drag = useRef<{ x: number; start: number } | null>(null);

  useEffect(() => {
    if (!editing.current) setText(String(round(value)));
  }, [value]);

  const clamp = (v: number) => Math.min(max, Math.max(min, v));

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!drag.current) return;
      const dx = e.clientX - drag.current.x;
      const next = clamp(drag.current.start + dx * step);
      setText(String(round(next)));
      onChange(next);
    };
    const up = () => {
      drag.current = null;
      document.body.style.cursor = "";
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  });

  return (
    <label className={cx("group flex h-8 items-center gap-1 rounded-md border border-white/8 bg-white/[0.03] px-2 transition-colors focus-within:border-white/25", className)}>
      {label && (
        <span
          onPointerDown={(e) => {
            drag.current = { x: e.clientX, start: value };
            document.body.style.cursor = "ew-resize";
          }}
          className="shrink-0 cursor-ew-resize select-none whitespace-nowrap pr-0.5 text-[11px] text-[var(--faint)] transition-colors group-hover:text-[var(--muted)]"
        >
          {label}
        </span>
      )}
      <input
        value={text}
        inputMode="decimal"
        onFocus={() => (editing.current = true)}
        onChange={(e) => {
          setText(e.target.value);
          const parsed = Number.parseFloat(e.target.value);
          if (Number.isFinite(parsed)) onChange(clamp(parsed));
        }}
        onBlur={() => {
          editing.current = false;
          setText(String(round(value)));
        }}
        className="w-full min-w-0 bg-transparent text-right font-mono text-[12px] tabular-nums outline-none"
      />
      {suffix && <span className="text-[11px] text-[var(--faint)]">{suffix}</span>}
    </label>
  );
}

function round(v: number) {
  return Math.round(v * 1000) / 1000;
}

export function Toggle({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex rounded-lg border border-white/8 bg-white/[0.02] p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cx(
            "h-7 flex-1 whitespace-nowrap rounded-[6px] px-2.5 text-[12px] transition-all duration-150",
            value === o.value ? "bg-white/[0.1] text-[var(--text)]" : "text-[var(--faint)] hover:text-[var(--muted)]",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Note({ tone = "muted", children }: { tone?: "muted" | "warn" | "danger"; children: React.ReactNode }) {
  const tones = {
    muted: "border-white/8 bg-white/[0.03] text-[var(--muted)]",
    warn: "border-[var(--warn)]/25 bg-[var(--warn)]/8 text-[var(--warn)]",
    danger: "border-[var(--danger)]/25 bg-[var(--danger)]/8 text-[var(--danger)]",
  } as const;
  return <p className={cx("rounded-lg border px-3 py-2 text-[11.5px] leading-relaxed", tones[tone])}>{children}</p>;
}
