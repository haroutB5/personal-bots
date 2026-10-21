/**
 * The PC at a glance under the Bots header: "CPU 12% · RAM 63% · C: 120 GB
 * free", small and secondary, a figure turning amber when it is nearly full.
 * A tap opens Computer > Performance for the full picture.
 *
 * Polling is cheap and quiet, like the update status line: only while the
 * page is visible, every 10 s, and every 30 s after a failed request. The
 * server answers from a 5 s CPU/RAM cache and a one-minute disk cache, and
 * never starts the Performance sampler. The line keeps its height from the
 * first paint (an empty row until the first answer), so the list never jumps.
 */
import type { JSX } from "react";
import { Fragment, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";

import { cn } from "~/lib/utils";

import { requestComputerPerformance } from "./computer/computerModel";
import {
  fetchSystemSummary,
  systemStatParts,
  systemStatsAriaLabel,
  type SystemSummary,
} from "./systemStats";
import { usePersonalEnvironmentId } from "./usePersonalBots";

export const SYSTEM_POLL_MS = 10_000;
export const SYSTEM_RETRY_MS = 30_000;

/** The latest answer outlives the page, so coming back shows numbers at once. */
let lastSummary: SystemSummary | null = null;

export function useSystemSummary(): SystemSummary | null {
  const environmentId = usePersonalEnvironmentId();
  const [summary, setSummary] = useState<SystemSummary | null>(lastSummary);

  useEffect(() => {
    if (environmentId === null || typeof document === "undefined") return;
    let cancelled = false;
    let timer: number | null = null;
    let inFlight = false;
    const pageVisible = () => document.visibilityState !== "hidden";

    const schedule = (delayMs: number) => {
      if (cancelled || !pageVisible()) return;
      timer = window.setTimeout(() => {
        timer = null;
        void ask();
      }, delayMs);
    };

    const ask = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      const next = await fetchSystemSummary();
      inFlight = false;
      if (cancelled) return;
      if (next === null) {
        schedule(SYSTEM_RETRY_MS);
        return;
      }
      lastSummary = next;
      setSummary(next);
      schedule(SYSTEM_POLL_MS);
    };

    const onVisibility = () => {
      if (cancelled) return;
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      if (pageVisible()) void ask();
    };

    document.addEventListener("visibilitychange", onVisibility);
    if (pageVisible()) void ask();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [environmentId]);

  return summary;
}

export function SystemStatsLine(): JSX.Element {
  const summary = useSystemSummary();
  const parts = summary === null ? [] : systemStatParts(summary);

  return (
    <div className="-mt-1.5 mb-1 h-4">
      {summary !== null && parts.length > 0 ? (
        <Link
          to="/computer"
          onClick={() => requestComputerPerformance()}
          aria-label={systemStatsAriaLabel(summary)}
          className="inline-flex max-w-full items-center truncate rounded text-[12px] leading-4 font-medium text-[var(--personal-text-secondary)] tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
        >
          {parts.map((part, index) => (
            <Fragment key={part.key}>
              {index > 0 ? <span aria-hidden="true">{" · "}</span> : null}
              <span
                aria-hidden="true"
                className={cn(part.busy && "text-[var(--personal-review-text)]")}
              >
                {part.text}
              </span>
            </Fragment>
          ))}
        </Link>
      ) : null}
    </div>
  );
}
