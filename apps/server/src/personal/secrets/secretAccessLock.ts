import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

/**
 * One lock for a saved key's value and its access policy. A save writes the
 * bytes (secret store) and the mode, origins and placement (SQL) in two steps;
 * a session read in between would pair new bytes with the old policy. Every
 * save, sharing change, mode change and removal holds this lock, and so does
 * every read that pairs a row's policy with its bytes, so a reader sees a key
 * either entirely before or entirely after a change.
 *
 * Not re-entrant: never read secrets from inside a locked section.
 */
export const secretAccessLock = Semaphore.makeUnsafe(1);

/**
 * A change to a saved key, run while holding the lock and uninterruptible from
 * the first write to the last, rollback included. Waiting for the permit stays
 * interruptible. A cancelled request (a closed socket, an RPC Interrupt) must not stop a save between
 * the new bytes and their access, or new bytes would sit under the old policy.
 * Keep work that restarts sessions (which read secrets) outside it.
 */
export const withSecretAccessLock = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => secretAccessLock.withPermit(Effect.uninterruptible(effect));
