/**
 * The one door for every deep link, share, tile tap and shortcut. While the app
 * lock is closed a link is held, not acted on; after the unlock it is acted on once.
 */
export interface LinkGate {
  /** A link arrived from outside. Acts now when open, holds it when covered. */
  readonly receive: (raw: string) => void;
  /** The lock view changed. Uncovering releases the held link once. */
  readonly setCovered: (covered: boolean) => void;
  /** The link waiting for the unlock, if any. */
  readonly held: () => string | null;
  /** Replaces what a released link does, so a re-rendered owner is always the one called. */
  readonly setAct: (act: (raw: string) => void) => void;
  /** The app is going away: whatever is still held will never be acted on. */
  readonly dispose: () => void;
}

/** A held link older than this is dropped: nobody expects it after a long wait. */
export const HELD_LINK_TTL_MS = 2 * 60_000;

export function createLinkGate(
  initialAct: (raw: string) => void,
  now: () => number = Date.now,
  ttlMs: number = HELD_LINK_TTL_MS,
  /** A held link that will never be acted on (replaced, expired, abandoned): free what it points at. */
  drop: (raw: string) => void = () => undefined,
): LinkGate {
  // Closed until the lock says otherwise: the setting is read after the first link can arrive.
  let act = initialAct;
  let covered = true;
  let pending: { readonly raw: string; readonly at: number } | null = null;

  const fresh = () => (pending !== null && now() - pending.at <= ttlMs ? pending.raw : null);

  return {
    receive: (raw) => {
      if (covered) {
        // The newest link wins: tapping the tile twice must not queue two chats.
        if (pending !== null) drop(pending.raw);
        pending = { raw, at: now() };
        return;
      }
      act(raw);
    },
    setCovered: (next) => {
      covered = next;
      if (covered) return;
      const raw = fresh();
      if (pending !== null && raw === null) drop(pending.raw);
      pending = null;
      if (raw !== null) act(raw);
    },
    held: fresh,
    setAct: (next) => {
      act = next;
    },
    dispose: () => {
      if (pending !== null) drop(pending.raw);
      pending = null;
    },
  };
}
