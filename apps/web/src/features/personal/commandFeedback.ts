import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

/**
 * What a confirm-then-delete flow did. `useAtomCommand`'s own `reportFailure`
 * only warns to the console, so a bare boolean made a refused delete look
 * exactly like a cancelled one: the dialog closed, the row stayed, and the
 * natural next move was to tap Confirm again. Callers get the message instead
 * and put it on screen.
 */
export type DestructiveOutcome =
  | { readonly status: "done" }
  | { readonly status: "cancelled" }
  | { readonly status: "failed"; readonly message: string };

/** The server's message for a failed command (null on success). */
export function commandFailureMessage(
  result: AtomCommandResult<unknown, unknown>,
  fallback: string,
): string | null {
  if (result._tag === "Success") return null;
  if (result._tag !== "Failure") return fallback;
  const error = squashAtomCommandFailure(result);
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { readonly message: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) return message;
  }
  return fallback;
}
