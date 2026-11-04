import { classifyFailure, RequestFailure } from "./failure";

const BACKOFF_FIRST_MS = 1_000;
const BACKOFF_MAX_MS = 10_000;

export function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_FIRST_MS * 2 ** Math.max(attempt, 0), BACKOFF_MAX_MS);
}

export function describePairFailure(cause: unknown): string {
  const failure = classifyFailure(cause);
  if (failure.kind === "authDead") {
    return "That pairing link was already used or has expired. Make a new one in hbots Settings > Connections.";
  }
  if (cause instanceof RequestFailure) {
    return "Can't reach your laptop. It may be off or restarting.";
  }
  return cause instanceof Error ? cause.message : String(cause);
}
