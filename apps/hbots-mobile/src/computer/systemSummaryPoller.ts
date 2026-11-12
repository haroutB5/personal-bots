import { systemPollDelayMs, type SystemSummary } from "@hbots/personal-client/computer/systemStats";

export const SUMMARY_POLL_MS = 10_000;
export const SUMMARY_RETRY_MS = 30_000;

export interface SummaryPollerDeps {
  readonly read: () => Promise<SystemSummary | null>;
  readonly onSummary: (summary: SystemSummary) => void;
  readonly initiallyActive: boolean;
}

export interface SummaryPoller {
  /** The app came to the foreground (true) or left it (false). */
  readonly appStateChanged: (active: boolean) => void;
  readonly stop: () => void;
}

/**
 * Polls the summary every 10 s while the app is in the foreground: 30 s after
 * a failed read, 3 s while the gaming PC link is starting. In the background
 * it asks nothing (so the server's gaming PC link can idle out), and it asks
 * at once on return. One read at a time.
 */
export function startSummaryPoller(deps: SummaryPollerDeps): SummaryPoller {
  let active = deps.initiallyActive;
  let stopped = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const schedule = (delayMs: number) => {
    if (stopped || !active) return;
    clear();
    timer = setTimeout(() => {
      timer = null;
      void ask();
    }, delayMs);
  };

  const ask = async () => {
    if (stopped || !active || inFlight) return;
    inFlight = true;
    const next = await deps.read();
    inFlight = false;
    if (stopped) return;
    if (next === null) {
      schedule(SUMMARY_RETRY_MS);
      return;
    }
    deps.onSummary(next);
    schedule(systemPollDelayMs(next, SUMMARY_POLL_MS));
  };

  void ask();

  return {
    appStateChanged: (nowActive) => {
      if (stopped) return;
      active = nowActive;
      clear();
      if (nowActive) void ask();
    },
    stop: () => {
      stopped = true;
      clear();
    },
  };
}
