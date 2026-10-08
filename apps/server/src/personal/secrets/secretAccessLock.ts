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
