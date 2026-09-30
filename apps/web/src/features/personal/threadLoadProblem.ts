import type { EnvironmentThreadState } from "@t3tools/client-runtime/state/threads";
import * as Option from "effect/Option";

/**
 * Why a chat that has nothing on screen will not load, or null while it is
 * still loading. The server answers a subscription for a chat that no longer
 * exists (deleted, or a made-up id in a saved link) with "Thread … was not
 * found", and the client keeps retrying with that error set: without this the
 * screen said "Loading chat" forever.
 *
 * - "missing": deleted, or never existed. Nothing to retry.
 * - "error": any other failure. The stream keeps retrying; Retry asks again now.
 */
export type ThreadLoadProblem =
  | { readonly kind: "missing" }
  | { readonly kind: "error"; readonly message: string };

const NOT_FOUND = /\bnot found\b/i;

export function threadLoadProblem(
  state: Pick<EnvironmentThreadState, "status" | "error" | "data">,
): ThreadLoadProblem | null {
  if (state.status === "deleted") return { kind: "missing" };
  // Loaded data wins: a later hiccup on a chat already on screen is not a
  // reason to replace it.
  if (Option.isSome(state.data)) return null;
  if (Option.isNone(state.error)) return null;
  const message = state.error.value;
  return NOT_FOUND.test(message) ? { kind: "missing" } : { kind: "error", message };
}
