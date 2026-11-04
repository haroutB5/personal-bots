export type CrashKind = "crash" | "anr";

const ALLOWED_KEYS = new Set(["event", "path", "error", "reason", "at", "warm", "snapshot"]);

/** The body the server receives. It carries no message text, stack or token. */
export function crashDiagBody(
  kind: CrashKind,
  errorName: string,
  nowMs: number,
): Record<string, unknown> {
  return {
    event: "page-boot",
    path: kind === "anr" ? "/android/anr" : "/android/crash",
    error: errorName.slice(0, 80).replace(/[^A-Za-z0-9 ._:-]/g, ""),
    reason: "android",
    at: nowMs,
    warm: false,
    snapshot: false,
  };
}

export function isCrashDiagKey(key: string): boolean {
  return ALLOWED_KEYS.has(key);
}
