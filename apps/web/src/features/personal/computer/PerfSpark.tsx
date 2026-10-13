import type { JSX } from "react";

/*
 * The small sparkline beside a row's value (spec section 5): same rules as
 * the big charts minus axes. One drawn point per ~2 px, the mean of its
 * bucket; a gap (nobody watched) breaks the line. Pure render: the values are
 * whatever the feed holds, nulls and all.
 */

export interface PerfSparkProps {
  readonly values: ReadonlyArray<number | null>;
  readonly width?: number;
  readonly height?: number;
  /** Fixed scale; without one, 0 to 1.15x the highest reading. */
  readonly min?: number;
  readonly max?: number | null;
  readonly className?: string;
}

export function sparkPoints(
  values: ReadonlyArray<number | null>,
  width: number,
  height: number,
  min: number,
  max: number,
): { readonly line: string; readonly area: string; readonly end: { x: number; y: number } | null } {
  const total = values.length;
  if (total === 0) return { line: "", area: "", end: null };
  const bucketSize = Math.max(1, Math.round(total / (width / 2)));
  const x = (index: number) => 2 + (index / Math.max(1, total - 1)) * (width - 8);
  const y = (value: number) => {
    const span = Math.max(0.0001, max - min);
    const clamped = Math.min(max, Math.max(min, value));
    return 4 + (1 - (clamped - min) / span) * (height - 6);
  };
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
    const index = Math.min(total - 1, bucket * bucketSize + (bucketSize - 1) / 2);
    const mean = numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
    current.push([index, mean]);
  }
  const line = runs
    .map(
      (run) =>
        "M" +
        run.map(([index, value]) => `${x(index).toFixed(1)} ${y(value).toFixed(1)}`).join("L"),
    )
    .join("");
  const lastRun = runs.at(-1);
  const last = lastRun?.at(-1);
  const first = runs[0]?.[0];
  const area =
    lastRun === undefined || last === undefined || first === undefined
      ? ""
      : `${line}L${x(lastRun.at(-1)![0]).toFixed(1)} ${height}L${x(first[0]).toFixed(1)} ${height}Z`;
  return {
    line: line === "" ? "" : line,
    area,
    end: last === undefined ? null : { x: x(lastRun!.at(-1)![0]), y: y(last[1]) },
  };
}

export function PerfSpark({
  values,
  width = 140,
  height = 32,
  min = 0,
  max = null,
  className,
}: PerfSparkProps): JSX.Element {
  const highest = (() => {
    let top = min;
    for (const value of values) if (value !== null && value > top) top = value;
    return top;
  })();
  const ceiling = max ?? Math.max(min + 0.0001, highest * 1.15);
  const { line, area, end } = sparkPoints(values, width, height, min, ceiling);
  return (
    <svg
      className={className}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      {area === "" ? null : <path d={area} fill="var(--perf-wash-pc)" />}
      {line === "" ? null : (
        <path
          d={line}
          fill="none"
          stroke="var(--perf-pc)"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}
      {end === null ? null : (
        <circle
          cx={end.x}
          cy={end.y}
          r="4"
          fill="var(--perf-pc)"
          stroke="var(--personal-surface)"
          strokeWidth="2"
        />
      )}
    </svg>
  );
}
