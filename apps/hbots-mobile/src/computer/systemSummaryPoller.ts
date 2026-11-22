import { phonePollDelayMs, type PhoneSystemSummary } from "./serverStats";

export const SUMMARY_POLL_MS = 10_000;
export const SUMMARY_RETRY_MS = 30_000;

export interface SummaryPollerDeps {
  readonly read: () => Promise<PhoneSystemSummary | null>;
  readonly onSummary: (summary: PhoneSystemSummary) => void;
  readonly initiallyActive: boolean;
}

export interface SummaryPoller {
  /** The app came to the foreground (true) or left it (false). */
  readonly appStateChanged: (active: boolean) => void;
  readonly stop: () => void;
}

/**
 * Polls every 10 s in the foreground (30 s after a failure, 3 s while a server
 * part is starting), one read at a time. Silent in the background so the
 * server's ssh link idles out; asks at once on return.
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
    schedule(phonePollDelayMs(next, SUMMARY_POLL_MS));
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
