// How memory ages: which entries lose weight with time (re-exported from the ranking module, where the weights live)
// and when the per-turn "context used" traces are cleared. Pure.
export {
  ageWeight,
  isStatusLike,
  STATUS_HALF_LIFE_DAYS,
  STATUS_MIN_WEIGHT,
  statedDateMs,
} from "./memoryRetrieval.ts";
export { TRACE_KEEP_DAYS } from "./memoryTurnTrace.ts";

/** Old traces are cleared at most this often (in memory per server): once an hour is plenty. */
export const TRACE_PRUNE_EVERY_MS = 3_600_000;

/** Whether the traces are due for clearing: never cleared yet, or the last clearing was long enough ago. */
export const tracePruneDue = (nowMs: number, lastPrunedAtMs: number): boolean =>
  nowMs - lastPrunedAtMs > TRACE_PRUNE_EVERY_MS;
