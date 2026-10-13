import type { JSX } from "react";
import { useCallback, useRef } from "react";

import { cn } from "~/lib/utils";

/*
 * The Performance tab's one chart (spec section 5): one y axis, thin marks, a
 * wash under each line, an end dot with a surface ring on the live end, and a
 * scrub the finger drives. Shares the bucket-mean drawing rule with PerfSpark;
 * gaps (nulls) break the line and are never interpolated.
 */

export interface PerfChartSeries {
  readonly name: string;
  readonly hbots: boolean;
  readonly values: ReadonlyArray<number | null>;
}

export interface PerfChartProps {
  readonly series: ReadonlyArray<PerfChartSeries>;
  readonly min: number;
  readonly max: number;
  readonly ticks: ReadonlyArray<{ readonly v: number; readonly l: string }>;
  readonly width?: number;
  readonly height?: number;
  /** The amber dashed line, shown only while its warning is active. */
  readonly warnLine?: { readonly v: number; readonly l: string } | null;
  /** The scrub position (a sample index), or null for live. */
  readonly scrubIndex?: number | null;
  readonly onScrub?: (index: number | null) => void;
  readonly loadingNote?: string | null;
  readonly ariaLabel: string;
}

const GUTTER = 36;
const BUCKETS_PER_SAMPLE = 1;

/**
 * One drawn point per ~2 px: the mean of each bucket of samples. Exported for
 * the tests.
 */
export function chartRuns(
  values: ReadonlyArray<number | null>,
  width: number,
): ReadonlyArray<ReadonlyArray<readonly [number, number]>> {
  const total = values.length;
  if (total === 0) return [];
  const bucketSize = Math.max(1, Math.round(total / (width / 2)));
  const runs: Array<Array<readonly [number, number]>> = [];
  let current: Array<readonly [number, number]> | null = null;
  for (let bucket = 0; bucket * bucketSize < total; bucket++) {
    const slice = values.slice(bucket * bucketSize, bucket * bucketSize + bucketSize);
    const numbers = slice.filter((value): value is number => value !== null);
    if (numbers.length === 0) {
      current = null;
      continue;
    }
    if (current === null) {
      current = [];
      runs.push(current);
    }
    const last = bucket * bucketSize + bucketSize >= total;
    const index = last
      ? total - 1
      : Math.min(total - 1, bucket * bucketSize + (bucketSize - 1) / 2);
    const mean = numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
    current.push([index, mean]);
  }
  return runs;
}

export function PerfChart({
  series,
  min,
  max,
  ticks,
  width = 290,
  height = 112,
  warnLine = null,
  scrubIndex = null,
  onScrub,
  loadingNote = null,
  ariaLabel,
}: PerfChartProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const total = series[0]?.values.length ?? 0;
  const x = useCallback(
    (index: number) => (total <= 1 ? 0 : (index / (total - 1)) * width),
    [total, width],
  );
  const y = useCallback(
    (value: number) => {
      const clamped = Math.min(max, Math.max(min, value));
      return 6 + (1 - (clamped - min) / (max - min)) * (height - 6);
    },
    [height, max, min],
  );

  const empty = series.every((s) => s.values.every((value) => value === null));

  const indexAt = (clientX: number): number | null => {
    const host = hostRef.current;
    if (host === null || total === 0) return null;
    const rect = host.getBoundingClientRect();
    const ratio = (clientX - rect.left) / Math.max(1, rect.width - GUTTER);
    return Math.max(0, Math.min(total - 1, Math.round(ratio * (total - 1))));
  };

  const tickY = ticks.map((tick) => ({ ...tick, y: y(tick.v) }));
  const warnY = warnLine === null ? null : y(warnLine.v);
  const dropTick = (value: number): boolean => warnY !== null && Math.abs(y(value) - warnY) < 14;

  const grid = tickY
    .filter((tick) => !dropTick(tick.v))
    .map((tick) => (
      <line
        key={`grid-${tick.l}`}
        x1={0}
        x2={width}
        y1={tick.y}
        y2={tick.y}
        stroke="var(--perf-grid)"
        strokeWidth="1"
      />
    ));

  const washes: JSX.Element[] = [];
  const lines: JSX.Element[] = [];
  for (const s of series) {
    const runs = chartRuns(s.values, width);
    for (const [runIndex, run] of runs.entries()) {
      const point = (i: number, v: number) => `${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
      const line = "M" + run.map(([i, v]) => point(i, v)).join("L");
      const first = run[0]!;
      const last = run.at(-1)!;
      if (run.length > 1) {
        washes.push(
          <path
            key={`wash-${s.name}-${runIndex}`}
            d={`${line}L${x(last[0]).toFixed(1)} ${y(min)}L${x(first[0]).toFixed(1)} ${y(min)}Z`}
            fill={s.hbots ? "var(--perf-wash-hbots)" : "var(--perf-wash-pc)"}
          />,
        );
      }
      lines.push(
        <path
          key={`line-${s.name}-${runIndex}`}
          d={line}
          fill="none"
          stroke={s.hbots ? "var(--perf-hbots)" : "var(--perf-pc)"}
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />,
      );
    }
  }

  const gapLabels: JSX.Element[] = [];
  {
    const reference = series[0]?.values ?? [];
    let gapStart = -1;
    for (let i = 0; i < reference.length; i++) {
      const value = reference[i] ?? null;
      if (value === null && gapStart < 0) gapStart = i;
      if ((value !== null || i === reference.length - 1) && gapStart >= 0) {
        const gapEnd = value === null ? i : i - 1;
        if (x(gapEnd) - x(gapStart) >= 56) {
          gapLabels.push(
            <span
              key={`gap-${gapStart}`}
              className="absolute text-[11px] leading-[13px] text-[var(--personal-text-tertiary)]"
              style={{
                left: (x(gapStart) + x(gapEnd)) / 2,
                bottom: 2,
                transform: "translateX(-50%)",
              }}
            >
              Tab closed
            </span>,
          );
        }
        gapStart = -1;
      }
    }
  }

  const endDots: JSX.Element[] = [];
  if (scrubIndex === null) {
    for (const s of series) {
      const lastIndex = s.values.length - 1;
      const lastValue = s.values[lastIndex] ?? null;
      if (lastValue === null) continue;
      endDots.push(
        <circle
          key={`end-${s.name}`}
          cx={x(lastIndex)}
          cy={y(lastValue)}
          r="4"
          fill={s.hbots ? "var(--perf-hbots)" : "var(--perf-pc)"}
          stroke="var(--personal-surface)"
          strokeWidth="2"
        />,
      );
    }
  } else {
    for (const s of series) {
      const value = s.values[scrubIndex] ?? null;
      if (value === null) continue;
      endDots.push(
        <circle
          key={`scrub-dot-${s.name}`}
          cx={x(scrubIndex)}
          cy={y(value)}
          r="4"
          fill={s.hbots ? "var(--perf-hbots)" : "var(--perf-pc)"}
          stroke="var(--personal-surface)"
          strokeWidth="2"
        />,
      );
    }
  }

  return (
    <div className="flex flex-col">
      <div
        ref={hostRef}
        className="relative"
        style={{
          width: width + GUTTER,
          height,
          touchAction: scrubIndex === null ? "pan-y" : "none",
        }}
        onPointerDown={(event) => {
          if (onScrub === undefined) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          const index = indexAt(event.clientX);
          if (index !== null) onScrub(index);
        }}
        onPointerMove={(event) => {
          if (onScrub === undefined || !event.currentTarget.hasPointerCapture(event.pointerId)) {
            return;
          }
          const index = indexAt(event.clientX);
          if (index !== null) onScrub(index);
        }}
        onPointerUp={(event) => {
          if (onScrub === undefined) return;
          event.currentTarget.releasePointerCapture(event.pointerId);
          onScrub(null);
        }}
        onPointerCancel={() => onScrub?.(null)}
        onKeyDown={(event) => {
          if (onScrub === undefined) return;
          if (event.key === "Escape") {
            onScrub(null);
            return;
          }
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            const step = event.key === "ArrowLeft" ? -BUCKETS_PER_SAMPLE : BUCKETS_PER_SAMPLE;
            const from = scrubIndex ?? total - 1;
            onScrub(Math.max(0, Math.min(total - 1, from + step)));
          }
        }}
        tabIndex={onScrub === undefined ? -1 : 0}
        role="img"
        aria-label={ariaLabel}
      >
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
          {grid}
          <line
            x1={0}
            x2={width}
            y1={y(min) - 0.5}
            y2={y(min) - 0.5}
            stroke="var(--perf-base)"
            strokeWidth="1"
          />
          {washes}
          {lines}
          {warnY === null ? null : (
            <line
              x1={0}
              x2={width + 4}
              y1={warnY}
              y2={warnY}
              stroke="var(--perf-warn)"
              strokeWidth="1.5"
              strokeDasharray="4 4"
            />
          )}
          {endDots}
          {scrubIndex === null ? null : (
            <line
              x1={x(scrubIndex)}
              x2={x(scrubIndex)}
              y1={0}
              y2={height}
              stroke="var(--personal-text-secondary)"
              strokeWidth="1"
            />
          )}
        </svg>
        {tickY
          .filter((tick) => !dropTick(tick.v))
          .map((tick) => (
            <span
              key={`yl-${tick.l}`}
              className="absolute text-[11px] leading-[13px] text-[var(--personal-text-tertiary)] tabular-nums"
              style={{ left: width + 6, top: tick.y - 7 }}
            >
              {tick.l}
            </span>
          ))}
        {warnY === null || warnLine === null ? null : (
          <span
            className="absolute text-[11px] leading-[13px] font-semibold text-[var(--personal-text-secondary)] tabular-nums"
            style={{ left: width + 6, top: warnY - 7 }}
          >
            {warnLine.l}
          </span>
        )}
        {gapLabels}
        {loadingNote === null || !empty ? null : (
          <div className="absolute inset-0 grid place-items-center">
            <span className="max-w-[200px] rounded-lg bg-[var(--personal-surface)] px-2 py-1 text-center text-[11px] leading-[13px] text-[var(--personal-text-tertiary)]">
              {loadingNote}
            </span>
          </div>
        )}
      </div>
      <div
        className={cn(
          "flex justify-between text-[11px] leading-[13px] text-[var(--personal-text-tertiary)]",
        )}
        style={{ width }}
      >
        <span>15 min ago</span>
        <span>Now</span>
      </div>
    </div>
  );
}
