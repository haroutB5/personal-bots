/** The Bots home's screen states, in the order the screen resolves them. */
export type BotsHomeState =
  /** No live list, no cache: the muted skeleton. */
  | "loading"
  /** No live list, but the cache has rows: paint them before the socket. */
  | "snapshot"
  /** The live list failed and nothing was cached. */
  | "error"
  /** Live data, no bots, no search: the empty state with Create your first bot. */
  | "empty"
  /** Live data, a search that matches nothing. */
  | "no-match"
  /** Live data with rows to draw. */
  | "list";

export function botsHomeState(input: {
  readonly loaded: boolean;
  readonly failed: boolean;
  readonly hasSnapshot: boolean;
  readonly visibleCount: number;
  readonly query: string;
}): BotsHomeState {
  if (!input.loaded) {
    if (input.failed && !input.hasSnapshot) return "error";
    if (input.hasSnapshot) return "snapshot";
    return "loading";
  }
  if (input.visibleCount > 0) return "list";
  return input.query.trim().length > 0 ? "no-match" : "empty";
}
