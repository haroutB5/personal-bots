import {
  isAtomCommandInterrupted,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { commandFailureMessage } from "@hbots/personal-client/bots/commandFeedback";

/**
 * Extracts a user-facing error message from a failed secret RPC command.
 * Returns null when the command succeeded or was interrupted (e.g. unmount).
 */
export function secretCommandError(
  result: AtomCommandResult<unknown, unknown>,
  fallback: string,
): string | null {
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
  return commandFailureMessage(result, fallback);
}

/**
 * Updates the per-request error map without mutating the previous map,
 * returning the same reference when nothing changed.
 */
export function withSecretError(
  current: ReadonlyMap<string, string>,
  requestId: string,
  message: string | null,
): ReadonlyMap<string, string> {
  if (message === null) {
    if (!current.has(requestId)) return current;
    const next = new Map(current);
    next.delete(requestId);
    return next;
  }
  if (current.get(requestId) === message) return current;
  return new Map(current).set(requestId, message);
}

/**
 * The single error message shown in the card's always-visible footer:
 * client-side access validation takes priority after a submit attempt,
 * followed by any server/RPC error from the last attempt.
 */
export function secretCardAlert(input: {
  readonly showProblem: boolean;
  readonly problem: string | null;
  readonly serverError: string | null;
}): string | null {
  if (input.showProblem && input.problem !== null) return input.problem;
  return input.serverError;
}
