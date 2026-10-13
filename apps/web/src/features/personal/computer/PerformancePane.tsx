import type { JSX, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";

import type { PerformanceGroup, PerformanceGroups, PerformanceSample } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronRight } from "lucide-react";

import { cn } from "~/lib/utils";

import { PerfChart } from "./PerfChart";
import { PcAvatar, type PcPose } from "./PcAvatar";
import {
  evaluateThresholds,
  fmt,
  fmtClock,
  meanOver,
  NO_WARNINGS,
  PERF_STALE_AFTER_MS,
  summaryFor,
  WINDOW_MS,
  warnPill,
} from "./performanceModel";
import { PerfSpark } from "./PerfSpark";
import { usePerformanceFeed, type PerformanceFeedState } from "./usePerformanceFeed";

/*
 * Computer > Performance (SPEC-performance.md): one line that says how the PC
 * is doing, then scrolling sections. Dark first, 390 px first, calm by
 * default - only a real threshold takes amber. Every number comes from the
 * server's feed; this file only formats and lays out.
 */

const ICON_STROKE = 1.75;

/** The bold segments `summaryFor` marks with \u0001. */
function Marked({ text }: { readonly text: string }): JSX.Element {
  const parts = text.split("\u0001");
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <b key={index} className="font-semibold">
            {part}
          </b>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </>
  );
}

function Card({
  id,
  label,
  children,
  dim = false,
}: {
  readonly id?: string;
  readonly label: string;
  readonly children: ReactNode;
  readonly dim?: boolean;
}): JSX.Element {
  return (
    <section
      {...(id === undefined ? {} : { id })}
      aria-label={label}
      className={cn(
        "mb-3 rounded-2xl border border-[var(--personal-border)] bg-[var(--personal-surface)] p-4",
        dim && "opacity-45",
      )}
    >
      {children}
    </section>
  );
}

function CardHead({
  title,
  meta,
  warn = null,
}: {
  readonly title: ReactNode;
  readonly meta?: ReactNode;
  readonly warn?: string | null;
}): JSX.Element {
  return (
    <div className="flex min-h-6 items-center justify-between gap-2">
      <h2 className="text-[15px] leading-5 font-bold text-[var(--personal-text)]">{title}</h2>
      {warn !== null ? (
        <span className="flex items-center gap-1.5 rounded-full bg-[var(--personal-fill-muted)] px-2.5 py-0.5 text-[12px] font-semibold text-[var(--personal-text)]">
          <i
            aria-hidden="true"
            className="inline-block size-1.5 rounded-full bg-[var(--perf-warn)]"
          />
          {warn}
        </span>
      ) : (
        <span className="text-[13px] leading-4 text-[var(--personal-text-secondary)]">{meta}</span>
      )}
    </div>
  );
}

function Value({
  main,
  unit,
  context,
  className,
}: {
  readonly main: string;
  readonly unit?: string | undefined;
  readonly context?: ReactNode;
  readonly className?: string;
}): JSX.Element {
  return (
    <div className={cn("mt-1 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5", className)}>
      <span className="text-[30px] leading-9 font-bold tabular-nums">
        {main}
        {unit === undefined ? null : (
          <small className="ml-px text-[13px] font-semibold text-[var(--personal-text-secondary)]">
            {unit}
          </small>
        )}
      </span>
      {context === undefined ? null : (
        <span className="text-[13px] leading-4 text-[var(--personal-text-secondary)]">
          {context}
        </span>
      )}
    </div>
  );
}

function Meter({
  fraction,
  warn = false,
  charge = false,
}: {
  readonly fraction: number;
  readonly warn?: boolean;
  readonly charge?: boolean;
}): JSX.Element {
  return (
    <span className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-[var(--perf-cell)]">
      <span
        className={cn(
          "block h-full rounded-full",
          warn
            ? "bg-[var(--perf-warn)]"
            : charge
              ? "bg-[var(--perf-charge,var(--personal-live))]"
              : "bg-[var(--perf-pc)]",
        )}
        style={{ width: `${Math.max(0, Math.min(100, fraction))}%` }}
      />
    </span>
  );
}

function Row({
  name,
  detail,
  value,
  meter,
  spark,
}: {
  readonly name: ReactNode;
  readonly detail?: ReactNode;
  readonly value: ReactNode;
  readonly meter?: { readonly fraction: number; readonly warn?: boolean } | null;
  readonly spark?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex min-h-12 items-center gap-3 border-t border-[var(--personal-border)] py-1.5 first:border-t-0">
      <span className="min-w-0 flex-1 text-[15px] leading-5 font-semibold">{name}</span>
      <span className="flex shrink-0 items-center gap-2 text-[13px] leading-4 text-[var(--personal-text-secondary)]">
        {detail}
        {spark}
      </span>
      <span className="w-[92px] shrink-0 text-right">
        <span className="block text-[15px] leading-5 font-semibold tabular-nums">{value}</span>
        {meter == null ? null : <Meter fraction={meter.fraction} warn={meter.warn === true} />}
      </span>
    </div>
  );
}

const series = (
  samples: ReadonlyArray<PerformanceSample>,
  pick: (sample: PerformanceSample) => number | null,
): ReadonlyArray<number | null> => samples.map(pick);

const gpuEngineLabel = (engine: string | null): string => {
  if (engine === null) return "GPU";
  if (engine === "3D") return "3D engine";
  const spaced = engine.replace(/([a-z])([A-Z])/g, "$1 $2");
  return `${spaced.toLowerCase()} engine`;
};

function statsLine(
  samples: ReadonlyArray<PerformanceSample>,
  pick: (sample: PerformanceSample) => number | null,
  unit: string,
  digits = 0,
): string | null {
  let peak = -Infinity;
  let peakAt = 0;
  for (const sample of samples) {
    const value = pick(sample);
    if (value !== null && value > peak) {
      peak = value;
      peakAt = sample.t;
    }
  }
  if (peak === -Infinity) return null;
  const average = meanOver(samples, samples.at(-1)?.t ?? 0, WINDOW_MS, pick);
  if (average === null) return null;
  const avgText = digits === 0 ? Math.round(average) : average.toFixed(digits);
  const peakText = digits === 0 ? Math.round(peak) : peak.toFixed(digits);
  return `Avg ${avgText}${unit} · Peak ${peakText}${unit} at ${fmtClock(peakAt)}`;
}

export interface PerformancePaneProps {
  /** Bots working + thinking, from the app's own store (the same words as home). */
  readonly botsBusy: number;
  readonly tasksRunning: number;
}

/**
 * Staleness flips once, at the moment it happens: a timer armed on each
 * sample instead of a once-a-second re-render of every card.
 */
function useStaleFlip(lastSampleAt: number | null): boolean {
  const [, bump] = useState(0);
  useEffect(() => {
    if (lastSampleAt === null) return;
    const timer = window.setTimeout(() => bump((count) => count + 1), PERF_STALE_AFTER_MS + 50);
    return () => window.clearTimeout(timer);
  }, [lastSampleAt]);
  return lastSampleAt !== null && Date.now() - lastSampleAt > PERF_STALE_AFTER_MS;
}

/** "2 h 14 min", ticking once a minute, in its own tiny component. */
function UpFor({
  since,
  withDays = false,
  prefix = "",
}: {
  readonly since: number;
  readonly withDays?: boolean;
  readonly prefix?: string;
}): JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <>
      {prefix}
      {upFor(since, now, withDays)}
    </>
  );
}

export function PerformancePane({ botsBusy, tasksRunning }: PerformancePaneProps): JSX.Element {
  const feed = usePerformanceFeed(true);
  const { samples, groups, slow, statics } = feed;
  const newest = samples.at(-1) ?? null;
  const loading = samples.length === 0;
  const stale = useStaleFlip(feed.lastSampleAt);

  // Every heavy derivation below runs once per 2 s sample, not per render:
  // `now` is the newest sample's own time, so no wall-clock dependency leaks
  // into the memo (the profile on 13 Oct showed per-second recomputation was
  // the hot path at 4x throttle).
  const now = newest?.t ?? 0;
  const threshold = useMemo(
    () => evaluateThresholds({ samples, slow, now, previous: NO_WARNINGS }),
    [samples, slow, now],
  );
  const summary = useMemo(
    () =>
      summaryFor({
        ...threshold,
        samples,
        groups,
        slow,
        now,
        stale,
        lastSampleAt: feed.lastSampleAt,
        botsBusy,
      }),
    [threshold, samples, groups, slow, now, stale, feed.lastSampleAt, botsBusy],
  );
  const pose: PcPose = summary.stale
    ? "paused"
    : summary.headline === "Under strain"
      ? "strain"
      : summary.headline === "Busy"
        ? "busy"
        : "calm";

  const live = feed.status === "live" && !stale;
  const [scrub, setScrub] = useState<number | null>(null);
  const scrubIndex = scrub === null ? null : Math.min(scrub, Math.max(0, samples.length - 1));
  const shown = scrubIndex === null ? newest : (samples[scrubIndex] ?? newest);

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({
      block: "start",
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  };

  if (loading) {
    return (
      <div className="mt-3">
        <Card label="How the PC is doing">
          <div className="flex items-center gap-3">
            <PcAvatar pose="calm" size={48} />
            <div className="min-w-0 flex-1">
              <h2 className="text-[20px] leading-6 font-bold">Measuring…</h2>
              <p className="text-[13px] leading-4 text-[var(--personal-text-secondary)]">
                First numbers in a moment.
              </p>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  const cpuTempWarn = threshold.active.includes("cpuTemp");
  const memoryWarn = threshold.active.includes("memory");
  const cpuWarn = threshold.active.includes("cpu");
  const batteryWarn = threshold.active.includes("battery");
  const charging = slow?.batteryState === "charging" || slow?.batteryState === "full";
  const threads = shown?.threadPct ?? null;
  const threadMax = threads === null ? 0 : Math.max(...threads);
  const fansFastest = (() => {
    let top = 0;
    for (const sample of samples) {
      top = Math.max(top, sample.fan1Rpm ?? 0, sample.fan2Rpm ?? 0);
    }
    return top;
  })();

  // One array per charted field, built once per sample (not per render): a
  // scrub or a stale flip reuses these identities, so the memoized chart and
  // spark components below skip redrawing.
  const gpuSeries = useMemo(() => series(samples, (sample) => sample.gpuPct), [samples]);
  const diskSeries = useMemo(() => series(samples, (sample) => sample.diskActivePct), [samples]);
  const downSeries = useMemo(() => series(samples, (sample) => sample.netDownMbps), [samples]);
  const upSeries = useMemo(() => series(samples, (sample) => sample.netUpMbps), [samples]);
  const cpuPowerSeries = useMemo(() => series(samples, (sample) => sample.powerCpuW), [samples]);
  const gpuPowerSeries = useMemo(() => series(samples, (sample) => sample.powerGpuW), [samples]);
  const platformPowerSeries = useMemo(
    () => series(samples, (sample) => sample.powerPlatformW),
    [samples],
  );
  const cpuSeries = useMemo(() => series(samples, (sample) => sample.cpuPct), [samples]);
  const hbotsSeries = useMemo(() => series(samples, (sample) => sample.hbotsPct), [samples]);
  const memSeries = useMemo(() => series(samples, (sample) => sample.memUsedGB), [samples]);
  const hbotsMemSeries = useMemo(() => series(samples, (sample) => sample.hbotsGB), [samples]);
  const tempSeries = useMemo(() => series(samples, (sample) => sample.cpuTempC), [samples]);
  const fan1Series = useMemo(() => series(samples, (sample) => sample.fan1Rpm), [samples]);
  const fan2Series = useMemo(() => series(samples, (sample) => sample.fan2Rpm), [samples]);

  const hbotsRows = groups?.hbots ?? null;
  const storageHbotsGB =
    slow === null || (slow.dataGB === null && slow.backupsGB === null && slow.releasesGB === null)
      ? null
      : (slow.dataGB ?? 0) + (slow.backupsGB ?? 0) + (slow.releasesGB ?? 0);

  return (
    <div className="mt-3">
      {/* 1. Summary */}
      <Card label="How the PC is doing" dim={stale}>
        <div className="flex items-start gap-3">
          <PcAvatar pose={pose} size={48} />
          <div className="min-w-0 flex-1">
            <h2 className="text-[20px] leading-6 font-bold">{summary.headline}</h2>
            <p className="mt-0.5 text-[13px] leading-4 text-[var(--personal-text-secondary)]">
              <Marked text={summary.reason} />
            </p>
          </div>
          {stale ? null : (
            <span className="flex shrink-0 items-center gap-1.5 text-[11px] leading-[13px] text-[var(--personal-text-secondary)]">
              <i
                aria-hidden="true"
                className={cn(
                  "inline-block size-1.5 rounded-full",
                  live
                    ? "perf-live-dot bg-[var(--perf-charge,var(--personal-live))]"
                    : "bg-[var(--personal-text-tertiary)]",
                )}
              />
              {loading ? "Starting" : "Live"}
            </span>
          )}
        </div>
        <div className="mt-3 grid grid-cols-4 gap-1 border-t border-[var(--personal-border)] pt-3">
          <Kpi
            label="CPU"
            value={fmt(shown?.cpuPct ?? null)}
            unit="%"
            fraction={shown?.cpuPct ?? 0}
            warn={cpuWarn}
            onTap={() => scrollTo("perf-cpu")}
          />
          <Kpi
            label="Memory"
            value={fmt(shown?.memUsedGB ?? null, 1)}
            unit="GB"
            fraction={
              shown?.memUsedGB != null && shown?.memTotalGB
                ? (shown.memUsedGB / shown.memTotalGB) * 100
                : 0
            }
            warn={memoryWarn}
            onTap={() => scrollTo("perf-mem")}
          />
          {slow?.batteryPct === undefined || slow?.batteryPct === null ? (
            <Kpi
              label="Graphics"
              value={fmt(shown?.gpuPct ?? null)}
              unit="%"
              fraction={shown?.gpuPct ?? 0}
              onTap={() => scrollTo("perf-more")}
            />
          ) : (
            <Kpi
              label="CPU temp"
              value={
                shown?.cpuTempC === null || shown?.cpuTempC === undefined
                  ? "–"
                  : fmt(shown.cpuTempC)
              }
              unit={shown?.cpuTempC == null ? undefined : "°C"}
              fraction={
                shown?.cpuTempC == null ? 0 : Math.max(0, ((shown.cpuTempC - 30) / 70) * 100)
              }
              warn={cpuTempWarn}
              onTap={() => scrollTo("perf-temps")}
            />
          )}
          {slow?.batteryPct === undefined || slow?.batteryPct === null ? (
            <Kpi label="Battery" value="–" fraction={0} onTap={() => scrollTo("perf-power")} />
          ) : (
            <Kpi
              label="Battery"
              value={fmt(slow.batteryPct)}
              unit="%"
              fraction={slow.batteryPct}
              warn={batteryWarn}
              charge={charging}
              onTap={() => scrollTo("perf-power")}
            />
          )}
        </div>
      </Card>

      {/* 2. CPU */}
      <Card id="perf-cpu" label="CPU" dim={stale}>
        <CardHead
          title="CPU"
          meta={shown?.clockGHz == null ? "–" : `${shown.clockGHz.toFixed(1)} GHz`}
          warn={cpuWarn ? "Over 90%" : null}
        />
        <Value
          main={fmt(shown?.cpuPct ?? null)}
          unit="%"
          context={
            scrubIndex === null ? (
              threshold.cpuBusy ? (
                "Over 70% for the last minute"
              ) : (
                (statsLine(samples, (s) => s.cpuPct, "%") ?? "")
              )
            ) : (
              <>
                hbots <b className="font-semibold">{fmt(shown?.hbotsPct ?? null)}%</b> · at{" "}
                {shown === null ? "–" : fmtClock(shown.t, true)}
              </>
            )
          }
        />
        <PerfChart
          series={[
            { name: "This PC", hbots: false, values: cpuSeries },
            { name: "hbots", hbots: true, values: hbotsSeries },
          ]}
          min={0}
          max={100}
          ticks={[
            { v: 50, l: "50%" },
            { v: 100, l: "100%" },
          ]}
          warnLine={cpuWarn ? { v: 90, l: "90%" } : null}
          scrubIndex={scrubIndex}
          onScrub={setScrub}
          ariaLabel={`CPU, last 15 minutes: now ${fmt(shown?.cpuPct ?? null)} percent, hbots ${fmt(shown?.hbotsPct ?? null)} percent`}
        />
        <div className="mt-1 flex items-center justify-between text-[13px] leading-4 text-[var(--personal-text-secondary)]">
          <span>
            <LegendKey /> This PC{" "}
            <b className="font-semibold text-[var(--personal-text)]">
              {fmt(shown?.cpuPct ?? null)}%
            </b>
          </span>
          <span>
            <LegendKey hbots /> hbots{" "}
            <b className="font-semibold text-[var(--personal-text)]">
              {fmt(shown?.hbotsPct ?? null)}%
            </b>
          </span>
        </div>
        {threads === null ? null : (
          <>
            <div className="mt-3 flex items-center justify-between text-[13px] leading-4 text-[var(--personal-text-secondary)]">
              <span>{threads.length} threads</span>
              <span>Busiest {Math.round(threadMax)}%</span>
            </div>
            <div
              className="mt-1 flex h-10 items-end gap-1.5"
              role="img"
              aria-label={`Load per thread: busiest ${Math.round(threadMax)} percent`}
            >
              {threads.slice(0, 12).map((value, index) => (
                <ThreadBar key={`p${index}`} value={value} />
              ))}
              <span className="w-1.5" />
              {threads.slice(12).map((value, index) => (
                <ThreadBar key={`e${index}`} value={value} />
              ))}
            </div>
            <div className="mt-1 flex text-[11px] leading-[13px] text-[var(--personal-text-tertiary)]">
              <span style={{ flex: 12 }}>Performance cores</span>
              <span style={{ flex: 8 }}>Efficient cores</span>
            </div>
          </>
        )}
      </Card>

      {/* 3. Memory */}
      <Card id="perf-mem" label="Memory" dim={stale}>
        <CardHead
          title="Memory"
          meta={shown?.memTotalGB == null ? "–" : `${shown.memTotalGB.toFixed(1)} GB usable`}
          warn={memoryWarn ? "Over 90%" : null}
        />
        <Value
          main={fmt(shown?.memUsedGB ?? null, 1)}
          unit="GB"
          context={
            shown?.memUsedGB == null || shown?.memTotalGB == null
              ? undefined
              : `${Math.round((shown.memUsedGB / shown.memTotalGB) * 100)}% used · ${fmt(shown.memFreeGB, 1)} GB free`
          }
        />
        <PerfChart
          series={[
            { name: "This PC", hbots: false, values: memSeries },
            { name: "hbots", hbots: true, values: hbotsMemSeries },
          ]}
          min={0}
          max={16}
          ticks={[
            { v: 8, l: "8 GB" },
            { v: 16, l: "16 GB" },
          ]}
          scrubIndex={scrubIndex}
          onScrub={setScrub}
          ariaLabel={`Memory, last 15 minutes: ${fmt(shown?.memUsedGB ?? null, 1)} of ${fmt(shown?.memTotalGB ?? null, 1)} gigabytes used`}
        />
        <div className="mt-1 flex items-center justify-between text-[13px] leading-4 text-[var(--personal-text-secondary)]">
          <span>
            <LegendKey /> This PC{" "}
            <b className="font-semibold text-[var(--personal-text)]">
              {fmt(shown?.memUsedGB ?? null, 1)} GB
            </b>
          </span>
          <span>
            <LegendKey hbots /> hbots{" "}
            <b className="font-semibold text-[var(--personal-text)]">
              {fmt(shown?.hbotsGB ?? null, 1)} GB
            </b>
          </span>
        </div>
        {hbotsRows === null ? null : (
          <p className="mt-2.5 text-[13px] leading-4 text-[var(--personal-text-secondary)]">
            hbots: server{" "}
            <b className="font-semibold text-[var(--personal-text)]">
              {hbotsRows.server.memGB.toFixed(1)} GB
            </b>{" "}
            · bots{" "}
            <b className="font-semibold text-[var(--personal-text)]">
              {hbotsRows.bots.memGB.toFixed(1)} GB
            </b>{" "}
            · browser{" "}
            <b className="font-semibold text-[var(--personal-text)]">
              {hbotsRows.browser.memGB.toFixed(1)} GB
            </b>
          </p>
        )}
      </Card>

      {/* 4. Temperatures and fans */}
      <TempsCard
        samples={samples}
        stale={stale}
        scrubIndex={scrubIndex}
        onScrub={setScrub}
        warnPillHot={cpuTempWarn}
        fansFastest={fansFastest}
        tempSeries={tempSeries}
        fan1Series={fan1Series}
        fan2Series={fan2Series}
      />

      {/* 5. hbots */}
      <Card id="perf-hbots" label="hbots on this PC" dim={stale}>
        <CardHead
          title={
            <span className="flex items-center gap-1.5">
              <LegendKey hbots />
              hbots
            </span>
          }
          meta={
            statics === null ? (
              ""
            ) : (
              <>
                {statics.hbotsVersion ?? "?"} · up <UpFor since={statics.hbotsStartedAt} />
              </>
            )
          }
        />
        <div className="mt-1 flex items-center gap-2 text-[15px] leading-5">
          <i
            aria-hidden="true"
            className={cn(
              "inline-block size-2 rounded-full",
              botsBusy > 0
                ? "bg-[var(--perf-charge,var(--personal-live))]"
                : "bg-[var(--personal-text-tertiary)]",
            )}
          />
          <span>
            <b className="font-semibold">{botsBusy}</b> {botsBusy === 1 ? "bot" : "bots"} busy
          </span>
          <span aria-hidden="true" className="text-[var(--personal-text-tertiary)]">
            ·
          </span>
          <span>
            <b className="font-semibold">{tasksRunning}</b> {tasksRunning === 1 ? "task" : "tasks"}{" "}
            running
          </span>
        </div>
        <table className="mt-2 w-full border-collapse text-[15px] leading-5">
          <thead>
            <tr className="text-[13px] leading-4 font-semibold text-[var(--personal-text-secondary)]">
              <th scope="col" className="py-1 text-left">
                <span className="sr-only">Part</span>
              </th>
              <th scope="col" className="w-[92px] py-1 text-right">
                CPU
              </th>
              <th scope="col" className="w-[92px] py-1 text-right">
                Memory
              </th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {hbotsRows === null ? null : (
              <>
                <HbotsRow row={hbotsRows.server} count={null} />
                <HbotsRow row={hbotsRows.bots} count={hbotsRows.bots.processCount} />
                <HbotsRow row={hbotsRows.browser} count={hbotsRows.browser.processCount} />
                <tr className="border-t border-[var(--personal-border)] font-semibold">
                  <td className="py-1.5">Total</td>
                  <td className="py-1.5 text-right">{hbotsRows.total.cpuPct.toFixed(1)}%</td>
                  <td className="py-1.5 text-right">{hbotsRows.total.memGB.toFixed(1)} GB</td>
                </tr>
              </>
            )}
          </tbody>
        </table>
      </Card>

      {/* 6. Heaviest right now */}
      <HeaviestCard groups={groups} dim={stale} />

      {/* 7. Battery */}
      <BatteryCard
        feed={feed}
        stale={stale}
        cpuPower={cpuPowerSeries}
        gpuPower={gpuPowerSeries}
        platformPower={platformPowerSeries}
      />

      {/* 8. Tiles */}
      <div id="perf-more" className={cn("grid grid-cols-2 gap-3", stale && "opacity-45")}>
        <Tile
          label="Graphics"
          value={fmt(shown?.gpuPct ?? null)}
          unit="%"
          lines={[statics?.pcGpu ?? "GPU", gpuEngineLabel(shown?.gpuEngine ?? null)]}
          spark={<PerfSpark values={gpuSeries} min={0} max={100} />}
        />
        <Tile
          label="Disk activity"
          value={fmt(shown?.diskActivePct ?? null)}
          unit="%"
          lines={[
            `Read ${fmt(shown?.diskReadMBps ?? null, 1)} MB/s`,
            `Write ${fmt(shown?.diskWriteMBps ?? null, 1)} MB/s`,
          ]}
          spark={<PerfSpark values={diskSeries} min={0} max={100} />}
        />
        <Tile
          label="Download"
          value={fmt(shown?.netDownMbps ?? null, 1)}
          unit="Mb/s"
          lines={[shown?.netAdapter ?? "Network", `Peak ${fmt(highest(downSeries), 1)} Mb/s`]}
          spark={<PerfSpark values={downSeries} />}
        />
        <Tile
          label="Upload"
          value={fmt(shown?.netUpMbps ?? null, 1)}
          unit="Mb/s"
          lines={[shown?.netAdapter ?? "Network", `Peak ${fmt(highest(upSeries), 1)} Mb/s`]}
          spark={<PerfSpark values={upSeries} />}
        />
      </div>

      {/* 9. Storage */}
      <div className="mt-3">
        <Card id="perf-storage" label="Storage" dim={stale}>
          <CardHead title="Storage" meta="Drive C:" />
          <Value
            main={fmt(slow?.diskFreeGB ?? null)}
            unit="GB free"
            context={slow?.diskTotalGB == null ? undefined : `of ${fmt(slow.diskTotalGB)} GB`}
          />
          {slow?.diskTotalGB == null || slow?.diskFreeGB == null ? null : (
            <>
              <span
                className="mt-2 flex h-2 w-full gap-0.5 overflow-hidden rounded-full"
                role="img"
                aria-label={`hbots ${fmt(storageHbotsGB)} gigabytes, everything else ${fmt(slow.diskTotalGB - slow.diskFreeGB - (storageHbotsGB ?? 0) < 0 ? 0 : slow.diskTotalGB - slow.diskFreeGB - (storageHbotsGB ?? 0))}, free ${fmt(slow.diskFreeGB)}`}
              >
                <i
                  className="block h-full rounded-full bg-[var(--perf-hbots)]"
                  style={{ width: `${((storageHbotsGB ?? 0) / slow.diskTotalGB) * 100}%` }}
                />
                <i
                  className="block h-full rounded-full bg-[var(--perf-pc)]"
                  style={{
                    width: `${(Math.max(0, slow.diskTotalGB - slow.diskFreeGB - (storageHbotsGB ?? 0)) / slow.diskTotalGB) * 100}%`,
                  }}
                />
              </span>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] leading-4 text-[var(--personal-text-secondary)]">
                <span>
                  <LegendSquare hbots /> hbots{" "}
                  <b className="font-semibold text-[var(--personal-text)]">
                    {fmt(storageHbotsGB)} GB
                  </b>
                </span>
                <span>
                  <LegendSquare /> Everything else{" "}
                  <b className="font-semibold text-[var(--personal-text)]">
                    {fmt(Math.max(0, slow.diskTotalGB - slow.diskFreeGB - (storageHbotsGB ?? 0)))}{" "}
                    GB
                  </b>
                </span>
                <span>
                  <LegendSquare free /> Free{" "}
                  <b className="font-semibold text-[var(--personal-text)]">
                    {fmt(slow.diskFreeGB)} GB
                  </b>
                </span>
              </div>
            </>
          )}
          {slow?.backupsGB == null ? null : (
            <p className="mt-2 text-[13px] leading-4 text-[var(--personal-text-secondary)]">
              <b className="font-semibold text-[var(--personal-text)]">{fmt(slow.backupsGB)} GB</b>{" "}
              of that is release backups
              {slow.backupsCount === null ? "" : ` (${slow.backupsCount} kept)`}.
            </p>
          )}
        </Card>
      </div>

      {/* 10. Footer */}
      <p className="px-1 pb-4 text-[11px] leading-[15px] text-[var(--personal-text-tertiary)]">
        {statics?.pcModel ?? "This PC"}
        {statics?.pcCpu === null || statics?.pcCpu === undefined
          ? ""
          : ` · ${statics.pcCpu}, ${statics.pcCores ?? "?"} cores, ${statics.pcThreads ?? "?"} threads`}
        {statics?.pcGpu === null || statics?.pcGpu === undefined ? "" : ` · ${statics.pcGpu}`}
        {statics?.ramGB == null ? "" : ` · ${statics.ramGB} GB`}
        {statics?.pcBootAt == null ? null : (
          <>
            {" · "}
            <UpFor since={statics.pcBootAt} withDays prefix="On for " />
          </>
        )}
      </p>
      <p className="px-1 pb-6 text-[11px] leading-[15px] text-[var(--personal-text-tertiary)]">
        Updates every 2 seconds while this tab is open. Charts keep the last 15 minutes it was open.
      </p>
    </div>
  );
}

function Kpi({
  label,
  value,
  unit,
  fraction,
  warn = false,
  charge = false,
  onTap,
}: {
  readonly label: string;
  readonly value: string;
  readonly unit?: string | undefined;
  readonly fraction: number;
  readonly warn?: boolean;
  readonly charge?: boolean;
  readonly onTap: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onTap}
      aria-label={`${label} ${value}${unit ?? ""}. Go to ${label}`}
      className="flex h-[72px] flex-col items-stretch justify-between rounded-[10px] px-1.5 pt-1.5 pb-1 outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
    >
      <span className="text-left text-[11px] leading-[13px] text-[var(--personal-text-secondary)]">
        {label}
      </span>
      <span className="text-left text-[20px] leading-6 font-bold tabular-nums">
        {value}
        {unit === undefined ? null : (
          <small className="ml-px text-[13px] font-semibold text-[var(--personal-text-secondary)]">
            {unit}
          </small>
        )}
        {charge ? <small className="ml-1 text-[12px]">⚡</small> : null}
      </span>
      <Meter fraction={fraction} warn={warn} charge={charge} />
    </button>
  );
}

function ThreadBar({ value }: { readonly value: number }): JSX.Element {
  return (
    <span className="flex h-full flex-1 items-end rounded-t bg-[var(--perf-cell)]">
      <i
        className="block w-full rounded-t bg-[var(--perf-pc)]"
        style={{ height: `${Math.max(3, Math.min(100, value))}%` }}
      />
    </span>
  );
}

function LegendKey({ hbots = false }: { readonly hbots?: boolean }): JSX.Element {
  return (
    <i
      aria-hidden="true"
      className={cn(
        "mr-1 inline-block h-0.5 w-3.5 align-middle",
        hbots ? "bg-[var(--perf-hbots)]" : "bg-[var(--perf-pc)]",
      )}
    />
  );
}

function LegendSquare({
  hbots = false,
  free = false,
}: {
  readonly hbots?: boolean;
  readonly free?: boolean;
}): JSX.Element {
  return (
    <i
      aria-hidden="true"
      className={cn(
        "mr-1 inline-block size-2 rounded-[3px] align-middle",
        free
          ? "border border-[var(--personal-border)] bg-[var(--perf-cell)]"
          : hbots
            ? "bg-[var(--perf-hbots)]"
            : "bg-[var(--perf-pc)]",
      )}
    />
  );
}

function HbotsRow({
  row,
  count,
}: {
  readonly row: PerformanceGroup;
  readonly count: number | null;
}): JSX.Element {
  return (
    <tr className="border-t border-[var(--personal-border)]">
      <td className="py-1.5">
        {row.name === "hbots server" ? "Server" : row.name === "Bots" ? "Bots" : "Browser"}
        {count === null ? null : (
          <small className="ml-1 text-[12px] text-[var(--personal-text-tertiary)]">
            {count} processes
          </small>
        )}
      </td>
      <td className="py-1.5 text-right">{row.cpuPct.toFixed(1)}%</td>
      <td className="py-1.5 text-right">{row.memGB.toFixed(1)} GB</td>
    </tr>
  );
}

function TempsCard({
  samples,
  stale,
  scrubIndex,
  onScrub,
  warnPillHot,
  fansFastest,
  tempSeries,
  fan1Series,
  fan2Series,
}: {
  readonly samples: ReadonlyArray<PerformanceSample>;
  readonly stale: boolean;
  readonly scrubIndex: number | null;
  readonly onScrub: (index: number | null) => void;
  readonly warnPillHot: boolean;
  readonly fansFastest: number;
  readonly tempSeries: ReadonlyArray<number | null>;
  readonly fan1Series: ReadonlyArray<number | null>;
  readonly fan2Series: ReadonlyArray<number | null>;
}): JSX.Element {
  const newest = samples.at(-1) ?? null;
  const shown = scrubIndex === null ? newest : (samples[scrubIndex] ?? newest);
  const sensorsDown = newest?.lhm === "down";
  const fansUnavailable =
    newest === null || newest.fanStatus === "unavailable" || newest.fans === "down";

  if (sensorsDown) {
    return (
      <Card id="perf-temps" label="Temperatures" dim={stale}>
        <CardHead title="Temperatures and fans" />
        <div className="mt-2 flex items-start gap-3 rounded-[10px] bg-[var(--personal-fill-muted)] p-3">
          <span
            aria-hidden="true"
            className="grid size-10 shrink-0 place-items-center rounded-full bg-[var(--personal-surface)] text-[18px]"
          >
            🌡
          </span>
          <div className="min-w-0">
            <p className="text-[15px] leading-5 font-semibold">Sensors app not running</p>
            <p className="mt-0.5 text-[13px] leading-4 text-[var(--personal-text-secondary)]">
              Temperatures and power use come from the sensors app on the laptop. It starts when you
              sign in to Windows. Everything else on this page still works.
            </p>
          </div>
        </div>
        <div className="mt-2">
          <FanRows
            newest={newest}
            fan1Series={fan1Series}
            fan2Series={fan2Series}
            fansUnavailable={true}
            fastest={0}
          />
        </div>
      </Card>
    );
  }

  const pCores = shown?.pCoreC ?? null;
  const eCores = shown?.eCoreC ?? null;
  const allCores = pCores === null || eCores === null ? null : [...pCores, ...eCores];
  const hottest = allCores === null ? null : Math.max(...allCores);
  const hottestIndex = allCores === null ? -1 : allCores.indexOf(hottest!);

  return (
    <Card id="perf-temps" label="Temperatures and fans" dim={stale}>
      <CardHead
        title="Temperatures and fans"
        meta={scrubIndex === null ? "CPU package" : "Lift to go back to now"}
        warn={warnPillHot ? "Hot" : null}
      />
      <Value
        main={fmt(shown?.cpuTempC ?? null)}
        unit={shown?.cpuTempC == null ? undefined : "°C"}
        context={
          newest?.cpuTempC != null && newest.cpuTempC >= 85 && !warnPillHot
            ? "Warm"
            : (statsLine(samples, (s) => s.cpuTempC, " °C") ?? "")
        }
      />
      <PerfChart
        series={[
          { name: "CPU temperature", hbots: false, values: series(samples, (s) => s.cpuTempC) },
        ]}
        min={30}
        max={100}
        ticks={[
          { v: 40, l: "40°" },
          { v: 70, l: "70°" },
          { v: 100, l: "100°" },
        ]}
        scrubIndex={scrubIndex}
        onScrub={onScrub}
        loadingNote="History builds while this tab is open, up to 15 minutes."
        ariaLabel={`CPU temperature, last 15 minutes: now ${fmt(shown?.cpuTempC ?? null)} degrees`}
      />
      <p className="mt-1 text-[13px] leading-4 text-[var(--personal-text-secondary)]">
        Up to about 85 °C is normal when it works hard. At 100 °C the CPU slows itself down to stay
        safe.
      </p>
      {allCores === null || pCores === null || eCores === null ? null : (
        <>
          <div className="mt-3 flex items-center justify-between text-[13px] leading-4 text-[var(--personal-text-secondary)]">
            <span>Cores</span>
            <span>
              Hottest {hottestIndex < 6 ? `P${hottestIndex + 1}` : `E${hottestIndex - 5}`} ·{" "}
              {Math.round(hottest!)} °C
            </span>
          </div>
          <div
            className="mt-1 flex h-10 items-end gap-1.5"
            role="img"
            aria-label={`Core temperatures: hottest core at ${Math.round(hottest!)} degrees`}
          >
            {pCores.map((value, index) => (
              <CoreBar key={`p${index}`} value={value} />
            ))}
            <span className="w-1.5" />
            {eCores.map((value, index) => (
              <CoreBar key={`e${index}`} value={value} />
            ))}
          </div>
          <div className="mt-1 flex text-[11px] leading-[13px] text-[var(--personal-text-tertiary)]">
            <span style={{ flex: 6 }}>P-cores 1–6</span>
            <span style={{ flex: 8 }}>E-cores 1–8</span>
          </div>
        </>
      )}
      <div className="mt-2">
        <Row
          name="SSD"
          detail={
            shown?.ssdC == null ? null : <span>Warns at {Math.round(shown.ssdWarnC ?? 82)} °C</span>
          }
          value={shown?.ssdC == null ? "–" : `${fmt(shown.ssdC)} °C`}
          meter={
            shown?.ssdC == null
              ? null
              : {
                  fraction: ((shown.ssdC - 20) / 69) * 100,
                  warn: thresholdSsd(shown.ssdC, shown.ssdWarnC ?? 82),
                }
          }
        />
        <Row
          name="Memory"
          detail={shown?.ramC == null ? null : "Normal"}
          value={shown?.ramC == null ? "–" : `${fmt(shown.ramC)} °C`}
        />
        <FanRows
          newest={newest}
          fan1Series={fan1Series}
          fan2Series={fan2Series}
          fansUnavailable={fansUnavailable}
          fastest={fansFastest}
        />
      </div>
    </Card>
  );
}

const thresholdSsd = (value: number, warn: number): boolean => value >= warn;

function CoreBar({ value }: { readonly value: number }): JSX.Element {
  const fraction = Math.max(3, Math.min(100, ((value - 30) / 70) * 100));
  return (
    <span className="flex h-full flex-1 items-end rounded-t bg-[var(--perf-cell)]">
      <i
        className="block w-full rounded-t bg-[var(--perf-pc)]"
        style={{ height: `${fraction}%` }}
      />
    </span>
  );
}

function FanRows({
  newest,
  fan1Series,
  fan2Series,
  fansUnavailable,
  fastest = 0,
}: {
  readonly newest: PerformanceSample | null;
  readonly fan1Series: ReadonlyArray<number | null>;
  readonly fan2Series: ReadonlyArray<number | null>;
  readonly fansUnavailable: boolean;
  readonly fastest?: number;
}): JSX.Element {
  if (fansUnavailable || newest === null) {
    return (
      <div className="flex min-h-12 items-center border-t border-[var(--personal-border)] py-1.5">
        <span className="flex-1 text-[15px] leading-5 font-semibold">Fans</span>
        <span className="text-[13px] leading-4 text-[var(--personal-text-tertiary)]">
          Fan reading not available right now
        </span>
      </div>
    );
  }
  const shared = { min: 0, max: Math.max(1, fastest) };
  return (
    <>
      <div className="flex min-h-12 items-center gap-3 border-t border-[var(--personal-border)] py-1.5">
        <span className="flex-1 text-[15px] leading-5 font-semibold">Fans</span>
        <span className="text-[13px] leading-4 text-[var(--personal-text-secondary)]">
          Fastest <b className="font-semibold">{fastest.toLocaleString("en-GB")} rpm</b>
        </span>
      </div>
      <Row
        name="Fan 1"
        value={
          newest.fan1Rpm === null
            ? "Not available right now"
            : `${newest.fan1Rpm.toLocaleString("en-GB")} rpm`
        }
        spark={
          newest.fan1Rpm !== null ? (
            <PerfSpark values={fan1Series} width={128} height={28} {...shared} />
          ) : null
        }
      />
      <Row
        name="Fan 2"
        value={
          newest.fan2Rpm === null
            ? "Not available right now"
            : `${newest.fan2Rpm.toLocaleString("en-GB")} rpm`
        }
        spark={
          newest.fan2Rpm !== null ? (
            <PerfSpark values={fan2Series} width={128} height={28} {...shared} />
          ) : null
        }
      />
      <p className="mt-1 text-[13px] leading-4 text-[var(--personal-text-secondary)]">
        Both charts run from 0 to the fastest speed in the last 15 minutes. Dell doesn't report a
        top speed, so there's no percentage.
      </p>
    </>
  );
}

function HeaviestCard({
  groups,
  dim,
}: {
  readonly groups: PerformanceGroups | null;
  readonly dim: boolean;
}): JSX.Element {
  const [by, setBy] = useState<"cpu" | "mem">("cpu");
  const [showAll, setShowAll] = useState(false);
  const list = groups === null ? [] : by === "cpu" ? groups.cpu : groups.mem;
  const visible = showAll ? list.slice(0, 15) : list.slice(0, 6);
  const top = list[0];
  const max =
    top === undefined ? 1 : by === "cpu" ? Math.max(1, top.cpuPct) : Math.max(0.1, top.memGB);
  return (
    <Card id="perf-apps" label="Heaviest right now" dim={dim}>
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h2 className="text-[15px] leading-5 font-bold">Heaviest right now</h2>
        <div role="group" aria-label="Sort by" className="flex gap-1">
          {(["cpu", "mem"] as const).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={by === key}
              onClick={() => setBy(key)}
              className={cn(
                "h-8 rounded-full px-3 text-[13px] font-semibold",
                by === key
                  ? "bg-[var(--personal-primary)] text-[var(--personal-primary-text)]"
                  : "bg-[var(--personal-fill-muted)] text-[var(--personal-text-secondary)]",
              )}
            >
              {key === "cpu" ? "CPU" : "Memory"}
            </button>
          ))}
        </div>
      </div>
      <ul className="mt-1">
        {visible.map((group) => {
          const row = (
            <>
              <span className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-[var(--personal-fill-muted)] text-[13px] font-semibold">
                {group.kind === "bot"
                  ? group.name.charAt(0) || "?"
                  : group.kind === "system"
                    ? "⊞"
                    : "▤"}
              </span>
              <span className="min-w-0 flex-1 text-left">
                <span className="block truncate text-[15px] leading-5 font-semibold">
                  {group.name}
                </span>
                <span className="block text-[12px] leading-4 text-[var(--personal-text-secondary)]">
                  {group.kind === "bot"
                    ? `Claude Code · ${group.processCount} processes`
                    : `${group.processCount} processes`}
                </span>
              </span>
              <span className="w-[86px] shrink-0 text-right">
                <span className="block text-[15px] leading-5 font-semibold tabular-nums">
                  {by === "cpu" ? `${group.cpuPct.toFixed(1)}%` : `${group.memGB.toFixed(1)} GB`}
                </span>
                <span className="mt-0.5 block h-1 w-full overflow-hidden rounded-full bg-[var(--perf-cell)]">
                  <span
                    className={cn(
                      "block h-full rounded-full",
                      group.kind === "bot" || group.kind === "hbots"
                        ? "bg-[var(--perf-hbots)]"
                        : "bg-[var(--perf-pc)]",
                    )}
                    style={{
                      width: `${Math.min(100, ((by === "cpu" ? group.cpuPct : group.memGB) / max) * 100)}%`,
                    }}
                  />
                </span>
              </span>
              {group.botId === null ? (
                <span className="w-3 shrink-0" />
              ) : (
                <ChevronRight
                  aria-hidden="true"
                  className="size-3 shrink-0"
                  strokeWidth={ICON_STROKE}
                />
              )}
            </>
          );
          return (
            <li
              key={`${group.kind}:${group.botId ?? group.name}`}
              className="border-t border-[var(--personal-border)] first:border-t-0"
            >
              {group.botId === null ? (
                <div className="flex min-h-[60px] items-center gap-3 py-1.5">{row}</div>
              ) : (
                <Link
                  to="/bots/$botId"
                  params={{ botId: group.botId }}
                  className="flex min-h-[60px] items-center gap-3 py-1.5"
                  aria-label={`${group.name}, ${group.processCount} processes, ${by === "cpu" ? `${group.cpuPct.toFixed(1)} percent` : `${group.memGB.toFixed(1)} gigabytes`}. Open ${group.name}`}
                >
                  {row}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
      {list.length > 6 ? (
        <button
          type="button"
          onClick={() => setShowAll((current) => !current)}
          className="mt-2 flex h-11 w-full items-center justify-center gap-1 rounded-[10px] text-[15px] font-semibold text-[var(--personal-text-secondary)]"
        >
          {showAll ? "Show fewer" : `Show all ${list.length}`}
          <ChevronDown
            aria-hidden="true"
            className={cn("size-4 transition-transform", showAll && "rotate-180")}
            strokeWidth={ICON_STROKE}
          />
        </button>
      ) : null}
    </Card>
  );
}

function BatteryCard({
  feed,
  stale,
  cpuPower,
  gpuPower,
  platformPower,
}: {
  readonly feed: PerformanceFeedState;
  readonly stale: boolean;
  readonly cpuPower: ReadonlyArray<number | null>;
  readonly gpuPower: ReadonlyArray<number | null>;
  readonly platformPower: ReadonlyArray<number | null>;
}): JSX.Element {
  const { slow, samples, statics } = feed;
  const sensorsDown = (samples.at(-1)?.lhm ?? "down") === "down";
  const charging = slow?.batteryState === "charging" || slow?.batteryState === "full";
  const newest = samples.at(-1) ?? null;
  return (
    <Card id="perf-power" label="Battery" dim={stale}>
      <CardHead
        title="Battery"
        meta={
          slow?.batteryState === undefined || slow?.batteryState === "unknown"
            ? ""
            : charging
              ? `Charging at ${fmt(newest?.batteryRateW ?? null, 1)} W`
              : slow.batteryState === "discharging"
                ? "On battery"
                : "Plugged in"
        }
      />
      <Value
        main={fmt(slow?.batteryPct ?? null)}
        unit={slow?.batteryPct == null ? undefined : "%"}
        context={
          slow?.batteryMinutesLeft == null
            ? undefined
            : charging
              ? `Full in about ${fmt(slow.batteryMinutesLeft)} min`
              : `About ${fmt(slow.batteryMinutesLeft)} min left`
        }
      />
      <span className="mt-2 block h-2 w-full overflow-hidden rounded-full bg-[var(--perf-cell)]">
        <span
          className={cn(
            "block h-full rounded-full",
            charging
              ? "bg-[var(--perf-charge,var(--personal-live))]"
              : (slow?.batteryPct ?? 100) < 15
                ? "bg-[var(--perf-warn)]"
                : "bg-[var(--perf-pc)]",
          )}
          style={{ width: `${slow?.batteryPct ?? 0}%` }}
        />
      </span>
      <p className="mt-2 text-[13px] leading-4 text-[var(--personal-text-secondary)]">
        {sensorsDown
          ? "Battery health and power use need the sensors app."
          : slow?.batteryFullWh == null || slow?.batteryDesignWh == null
            ? ""
            : `Holds ${fmt(slow.batteryFullWh, 1)} of ${fmt(slow.batteryDesignWh, 1)} Wh when full (${Math.round((slow.batteryFullWh / slow.batteryDesignWh) * 100)}% health).`}
      </p>
      {sensorsDown ? null : (
        <div className="mt-1">
          <Row
            name="CPU"
            value={`${fmt(newest?.powerCpuW ?? null, 1)} W`}
            spark={<PerfSpark values={cpuPower} width={128} height={28} />}
          />
          <Row
            name="Graphics"
            value={`${fmt(newest?.powerGpuW ?? null, 1)} W`}
            spark={<PerfSpark values={gpuPower} width={128} height={28} />}
          />
          <Row
            name="Whole laptop"
            value={`${fmt(newest?.powerPlatformW ?? null, 1)} W`}
            spark={<PerfSpark values={platformPower} width={128} height={28} />}
          />
        </div>
      )}
      {statics?.pcBootAt == null ? null : null}
    </Card>
  );
}

function Tile({
  label,
  value,
  unit,
  lines,
  spark,
}: {
  readonly label: string;
  readonly value: string;
  readonly unit: string;
  readonly lines: ReadonlyArray<string>;
  readonly spark: JSX.Element;
}): JSX.Element {
  return (
    <div className="rounded-2xl border border-[var(--personal-border)] bg-[var(--personal-surface)] p-4">
      <div className="text-[13px] leading-4 font-semibold text-[var(--personal-text-secondary)]">
        {label}
      </div>
      <div className="mt-0.5 text-[20px] leading-6 font-bold tabular-nums">
        {value}
        <small className="ml-px text-[13px] font-semibold text-[var(--personal-text-secondary)]">
          {unit}
        </small>
      </div>
      {lines.map((line) => (
        <div
          key={line}
          className="mt-0.5 text-[12px] leading-4 text-[var(--personal-text-secondary)]"
        >
          {line}
        </div>
      ))}
      <div className="mt-1.5">{spark}</div>
    </div>
  );
}

const highest = (values: ReadonlyArray<number | null>): number | null => {
  let top: number | null = null;
  for (const value of values) if (value !== null && (top === null || value > top)) top = value;
  return top;
};

const upFor = (since: number, now: number, withDays = false): string => {
  const minutes = Math.max(0, Math.round((now - since) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${minutes % 60} min`;
  const days = Math.floor(hours / 24);
  if (!withDays) return `${hours} h ${minutes % 60} min`;
  return `${days} days ${hours % 24} h`;
};
