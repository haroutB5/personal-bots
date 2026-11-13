import { createSecureKeyValueStore } from "../platform/nativePorts";
import type { UpdateSnapshot } from "../updater";
import { crashDiagBody } from "./diagBody";
import { createUpdaterStateTracker } from "./updaterDiag";

const EXIT_MARKER_KEY = "hbots.exit-marker.v1";
const MARKER_ALIVE = "alive";
const MARKER_BACKGROUND = "background";

const kv = createSecureKeyValueStore();

let previousExit: string | null = null;
let reported = false;
let baseUrl: string | null = null;
const updaterStates = createUpdaterStateTracker();

/**
 * Called once at module load, before anything can crash. The previous value is
 * read before this run claims the marker, so an unexpected exit is visible on
 * the next launch.
 */
export function markThisRunAlive(): void {
  previousExit = kv.getItem(EXIT_MARKER_KEY);
  kv.setItem(EXIT_MARKER_KEY, MARKER_ALIVE);
}

export function markBackgrounded(): void {
  kv.setItem(EXIT_MARKER_KEY, MARKER_BACKGROUND);
}

export function markForegrounded(): void {
  kv.setItem(EXIT_MARKER_KEY, MARKER_ALIVE);
}

async function post(baseUrl: string, body: Record<string, unknown>): Promise<void> {
  await fetch(`${baseUrl.replace(/\/$/u, "")}/api/personal/client-diag`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function setCrashBaseUrl(url: string): void {
  baseUrl = url;
}

/**
 * A previous run left the marker on `alive`: Android killed the process
 * without a background transition, which is what a native crash or an ANR
 * looks like from JavaScript. Report once per launch.
 */
export async function reportPreviousUncleanExit(nowMs = Date.now()): Promise<void> {
  if (reported || baseUrl === null || previousExit !== MARKER_ALIVE) {
    return;
  }
  reported = true;
  await post(baseUrl, crashDiagBody("crash", "UnexpectedExit", nowMs)).catch(() => undefined);
}

/** Fatal JavaScript errors are reported immediately, then the original handler runs. */
export function installJavascriptCrashHandler(): void {
  const errorUtils = (
    globalThis as typeof globalThis & {
      ErrorUtils?: {
        getGlobalHandler?: () => (error: unknown, isFatal?: boolean) => void;
        setGlobalHandler?: (handler: (error: unknown, isFatal?: boolean) => void) => void;
      };
    }
  ).ErrorUtils;
  if (errorUtils?.setGlobalHandler === undefined) {
    return;
  }
  const previous = errorUtils.getGlobalHandler?.();
  errorUtils.setGlobalHandler((error, isFatal) => {
    if (isFatal === true && baseUrl !== null) {
      const name = error instanceof Error ? error.name : "Error";
      void post(baseUrl, crashDiagBody("crash", name, Date.now())).catch(() => undefined);
    }
    previous?.(error, isFatal);
  });
}

/** A deliberate ANR report for tests and for the Settings diagnostics row later. */
export async function reportAnrForTest(): Promise<void> {
  if (baseUrl === null) return;
  await post(baseUrl, crashDiagBody("anr", "ApplicationNotResponding", Date.now())).catch(
    () => undefined,
  );
}

/** One timing line (chatOpenPerf.ts): durations and sizes only. Dropped before pairing. */
export function reportPerf(body: Record<string, number | string>): void {
  if (baseUrl === null) return;
  void post(baseUrl, body).catch(() => undefined);
}

/**
 * A stalled updater leaves no other trace on the server. Nothing is sent until
 * a session gives the base URL, so a state seen before pairing is still
 * reported once the URL is known.
 */
export function reportUpdaterState(snapshot: UpdateSnapshot | null): void {
  if (snapshot === null || baseUrl === null) return;
  const body = updaterStates.next(snapshot);
  if (body === null) return;
  void post(baseUrl, { ...body }).catch(() => undefined);
}
