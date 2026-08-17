"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { animate, useMotionValue, useMotionValueEvent, useTransform, motion } from "motion/react";

/**
 * A full-bleed slider: the track *is* the control surface, with the label and
 * value floating inside it.
 *
 * Interaction model:
 * - dragging is continuous and instant
 * - a click snaps to the nearest decile (inside a generous zone) with a spring
 * - press and hold the value for 800ms to type an exact number
 * - dragging past either end rubber-bands the card, after a dead zone
 */

const HANDLE_INSET = 9;
const HANDLE_MIN_LEFT = 6;
const DRAG_THRESHOLD = 4;
const EDIT_HOLD_MS = 800;
const SNAP_ZONE = 0.035; // fraction of the range on each side of a decile
const RUBBER_DEAD_ZONE = 20;
const RUBBER_MAX = 26;
const TICKS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

const SPRING = { type: "spring", stiffness: 420, damping: 34, mass: 0.7 } as const;

export interface SliderProps {
  label: string;
  /** Small monospace tag rendered before the label — the axis tag, typically. */
  tag?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (value: number) => void;
  /** Double-click resets here when provided. */
  resetTo?: number;
  size?: "sm" | "md";
  /**
   * When false, typed and keyboard values are accepted outside `min`/`max` —
   * the track just pins to its end. Used where the range is only a suggestion.
   */
  clampInput?: boolean;
}

function decimalsOf(step: number) {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const text = String(step);
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : text.length - dot - 1;
}

/** Diminishing-returns curve for over-drag, after a dead zone. */
function rubber(distance: number) {
  const past = distance - RUBBER_DEAD_ZONE;
  if (past <= 0) return 0;
  return Math.min(RUBBER_MAX, (past * 0.5) / (1 + past / 220));
}

export function Slider({
  label,
  tag,
  value,
  min,
  max,
  step = 1,
  suffix,
  onChange,
  resetTo,
  size = "md",
  clampInput = true,
}: SliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const valueRef = useRef<HTMLSpanElement>(null);

  const span = max - min || 1;
  const decimals = decimalsOf(step);

  const pct = useMotionValue(clamp01((value - min) / span));
  const stretch = useMotionValue(0);

  const [hover, setHover] = useState(false);
  const [active, setActive] = useState(false);
  const [dodging, setDodging] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  // Text extents, so the handle knows when it is about to collide with them.
  const extents = useRef({ width: 0, labelEnd: 0, valueStart: Infinity });
  const interacting = useRef(false);
  const gesture = useRef<{
    pointerId: number;
    startX: number;
    moved: boolean;
    onValue: boolean;
    holdTimer: ReturnType<typeof setTimeout> | null;
  } | null>(null);

  const measure = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const labelRect = labelRef.current?.getBoundingClientRect();
    const valueRect = valueRef.current?.getBoundingClientRect();
    extents.current = {
      width: rect.width,
      labelEnd: labelRect ? labelRect.right - rect.left : 0,
      valueStart: valueRect ? valueRect.left - rect.left : Infinity,
    };
  }, []);

  useLayoutEffect(() => {
    measure();
    const track = trackRef.current;
    if (!track || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    return () => observer.disconnect();
  }, [measure]);

  // External changes (a named instance being applied, say) move the track too.
  const latest = useRef(value);
  useEffect(() => {
    latest.current = value;
    if (interacting.current) return;
    pct.set(clamp01((value - min) / span));
  }, [value, min, span, pct]);

  const updateDodge = useCallback(
    (p: number) => {
      const { width, labelEnd, valueStart } = extents.current;
      const x = p * width;
      const near = x < labelEnd + 6 || x > valueStart - 6;
      setDodging((was) => (was === near ? was : near));
    },
    [],
  );

  useMotionValueEvent(pct, "change", updateDodge);
  useEffect(() => updateDodge(pct.get()), [updateDodge, pct, editing]);

  const fillWidth = useTransform(pct, (p) => `${(p * 100).toFixed(3)}%`);
  const handleLeft = useTransform(pct, (p) => `max(${HANDLE_MIN_LEFT}px, calc(${(p * 100).toFixed(3)}% - ${HANDLE_INSET}px))`);
  const cardWidth = useTransform(stretch, (s) => `calc(100% + ${Math.abs(s).toFixed(2)}px)`);
  const cardShift = useTransform(stretch, (s) => (s < 0 ? s : 0));

  const quantise = useCallback(
    (raw: number, clamp = true) => {
      const snapped = Math.round(raw / step) * step;
      const bounded = clamp ? Math.min(max, Math.max(min, snapped)) : snapped;
      return Number(bounded.toFixed(decimals));
    },
    [step, min, max, decimals],
  );

  const valueFromClientX = useCallback((clientX: number) => {
    const track = trackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    return clamp01((clientX - rect.left) / rect.width);
  }, []);

  const commit = useCallback(
    (p: number) => {
      const next = quantise(min + p * span);
      pct.set(clamp01((next - min) / span));
      latest.current = next;
      onChange(next);
    },
    [quantise, min, span, pct, onChange],
  );

  const endGesture = useCallback(() => {
    const g = gesture.current;
    if (g?.holdTimer) clearTimeout(g.holdTimer);
    gesture.current = null;
    setActive(false);
    animate(stretch, 0, SPRING);
    interacting.current = false;
  }, [stretch]);

  const onPointerDown = (event: React.PointerEvent) => {
    if (editing) return;
    const onValue = valueRef.current?.contains(event.target as Node) ?? false;
    try {
      // Capture keeps the drag alive past the track edges, which is what makes
      // the rubber band reachable at all.
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    } catch {
      // Some pointer sources refuse capture; the gesture still works in-bounds.
    }
    interacting.current = true;
    setActive(true);
    measure();

    gesture.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      moved: false,
      onValue,
      holdTimer: onValue
        ? setTimeout(() => {
            setDraft(format(value, decimals));
            setEditing(true);
            endGesture();
          }, EDIT_HOLD_MS)
        : null,
    };
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const g = gesture.current;
    if (!g || g.pointerId !== event.pointerId) return;

    if (!g.moved && Math.abs(event.clientX - g.startX) < DRAG_THRESHOLD) return;
    if (!g.moved) {
      g.moved = true;
      if (g.holdTimer) clearTimeout(g.holdTimer);
    }

    commit(valueFromClientX(event.clientX));

    const rect = trackRef.current!.getBoundingClientRect();
    if (event.clientX < rect.left) stretch.set(-rubber(rect.left - event.clientX));
    else if (event.clientX > rect.right) stretch.set(rubber(event.clientX - rect.right));
    else stretch.set(0);
  };

  const onPointerUp = (event: React.PointerEvent) => {
    const g = gesture.current;
    if (!g || g.pointerId !== event.pointerId) return;

    if (!g.moved) {
      // A click: assist by pulling to the nearest decile inside a generous zone.
      const raw = valueFromClientX(event.clientX);
      const decile = Math.round(raw * 10) / 10;
      const target = Math.abs(raw - decile) <= SNAP_ZONE ? decile : raw;
      const next = quantise(min + target * span);
      onChange(next);
      interacting.current = true;
      animate(pct, clamp01((next - min) / span), {
        ...SPRING,
        onComplete: () => {
          interacting.current = false;
        },
      });
      if (g.holdTimer) clearTimeout(g.holdTimer);
      gesture.current = null;
      setActive(false);
      animate(stretch, 0, SPRING);
      return;
    }
    endGesture();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const big = event.shiftKey ? 10 : 1;
    // Key repeat outruns re-rendering, so step from the last value we sent
    // rather than from the prop, which may still be a frame behind.
    const from = latest.current;
    let next: number | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = from - step * big;
    else if (event.key === "ArrowRight" || event.key === "ArrowUp") next = from + step * big;
    else if (event.key === "Home") next = min;
    else if (event.key === "End") next = max;
    else if (event.key === "Enter") {
      setDraft(format(from, decimals));
      setEditing(true);
      event.preventDefault();
      return;
    }
    if (next === null) return;
    event.preventDefault();
    const clamped = quantise(next, clampInput);
    latest.current = clamped;
    onChange(clamped);
    animate(pct, clamp01((clamped - min) / span), SPRING);
  };

  const commitDraft = () => {
    const parsed = Number.parseFloat(draft);
    setEditing(false);
    if (!Number.isFinite(parsed)) return;
    const next = quantise(parsed, clampInput);
    onChange(next);
    animate(pct, clamp01((next - min) / span), SPRING);
  };

  const lit = hover || active;

  return (
    <motion.div
      ref={trackRef}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={`${format(value, decimals)}${suffix ?? ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={endGesture}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onKeyDown={onKeyDown}
      onDoubleClick={() => {
        if (resetTo === undefined) return;
        onChange(resetTo);
        animate(pct, clamp01((resetTo - min) / span), SPRING);
      }}
      style={{ width: cardWidth, x: cardShift }}
      className={[
        "relative cursor-ew-resize touch-none select-none overflow-hidden rounded-lg outline-none",
        size === "sm" ? "h-8" : "h-9",
        "border transition-colors duration-150",
        lit ? "border-white/14 bg-white/[0.055]" : "border-white/8 bg-white/[0.028]",
        "focus-visible:border-white/30",
      ].join(" ")}
    >
      <motion.div
        style={{ width: fillWidth }}
        className={["absolute inset-y-0 left-0 transition-colors duration-150", lit ? "bg-white/[0.11]" : "bg-white/[0.07]"].join(" ")}
      />

      {/* Deciles — spatial reference only, so they stay quiet until hovered. */}
      <div className="pointer-events-none absolute inset-0">
        {TICKS.map((t) => (
          <motion.span
            key={t}
            initial={false}
            animate={{ opacity: lit ? 1 : 0 }}
            transition={{ duration: 0.16 }}
            style={{ left: `${t * 100}%` }}
            className="absolute top-1/2 h-2 w-px -translate-y-1/2 bg-white/12"
          />
        ))}
      </div>

      <motion.span
        initial={false}
        animate={{
          opacity: lit ? (dodging ? 0.2 : 0.85) : 0,
          scaleX: lit ? (dodging ? 0.5 : 1) : 0,
          scaleY: dodging ? 0.62 : 1,
        }}
        transition={SPRING}
        style={{ left: handleLeft }}
        className="pointer-events-none absolute top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-white"
      />

      <div className="pointer-events-none relative flex h-full items-center justify-between gap-3 px-3">
        <span ref={labelRef} className="flex min-w-0 items-baseline gap-1.5">
          {tag && <span className="shrink-0 font-mono text-[10.5px] text-[var(--faint)]">{tag}</span>}
          <span className="truncate text-[12.5px] text-[var(--muted)]">{label}</span>
        </span>

        <span ref={valueRef} className="pointer-events-auto shrink-0 cursor-text">
          {editing ? (
            <input
              autoFocus
              value={draft}
              inputMode="decimal"
              aria-label={`${label} value`}
              onChange={(e) => setDraft(e.target.value)}
              onFocus={(e) => e.target.select()}
              onBlur={commitDraft}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") commitDraft();
                if (e.key === "Escape") setEditing(false);
              }}
              onPointerDown={(e) => e.stopPropagation()}
              className="w-[72px] rounded-[4px] bg-white/10 px-1 text-right font-mono text-[12px] tabular-nums text-[var(--text)] outline-none"
            />
          ) : (
            <span className="font-mono text-[12px] tabular-nums text-[var(--text)]">
              {format(value, decimals)}
              {suffix}
            </span>
          )}
        </span>
      </div>
    </motion.div>
  );
}

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}

function format(v: number, decimals: number) {
  if (decimals <= 0) return String(Math.round(v));
  return v.toFixed(decimals).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}
