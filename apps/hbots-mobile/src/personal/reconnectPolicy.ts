/** Failures in a row before the shared HTTP pool is reset. */
export const RESET_AFTER_FAILURES = 3;

/** `consecutiveFailures` includes the failure that just happened. */
export function shouldResetNetworkClient(consecutiveFailures: number): boolean {
  return consecutiveFailures >= RESET_AFTER_FAILURES;
}
