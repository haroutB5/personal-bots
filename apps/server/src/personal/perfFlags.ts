/**
 * Server-side kill switches for performance changes. Each optimization is on
 * by default and is turned off, without a release, by naming it in the
 * server's environment and restarting:
 *
 *   PB_PERF_OFF=session-prewarm,task-summaries
 *
 * The client-side switches live in apps/web/src/features/personal/perfFlags.ts
 * (scripts/personal/perf/README.md lists both).
 */
export const SERVER_PERF_OFF_ENV = "PB_PERF_OFF";

export type ServerPerfOptimization =
  /** Start a personal bot chat's provider session when the chat is opened. */
  | "session-prewarm"
  /** Send task summaries, not full bodies, on `personalTasks.subscribe`. */
  | "task-summaries";

export function serverPerfOptimizationOn(
  name: ServerPerfOptimization,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const off = env[SERVER_PERF_OFF_ENV];
  if (!off) return true;
  return !off
    .split(",")
    .map((entry) => entry.trim())
    .includes(name);
}
