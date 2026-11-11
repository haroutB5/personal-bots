/**
 * The one door between the outside world and the app. Every deep link, share
 * intent, Quick Settings tile tap, launcher shortcut and notification tap reaches
 * the app as an `hbots://` link. While the app lock is closed (or the setting is
 * not read yet) such a link is held, not acted on: acting means navigating to a
 * screen that may write to the server (a new chat) or show content. After the
 * user unlocks, the held link is acted on once.
 */
export interface LinkGate {
  /** A link arrived from outside. Acts now when open, holds it when covered. */
  readonly receive: (raw: string) => void;
  /** The lock view changed. Uncovering releases the held link once. */
  readonly setCovered: (covered: boolean) => void;
  /** The link waiting for the unlock, if any. */
  readonly held: () => string | null;
}

/** A held link older than this is dropped: nobody expects it after a long wait. */
export const HELD_LINK_TTL_MS = 2 * 60_000;

export function createLinkGate(
  act: (raw: string) => void,
  now: () => number = Date.now,
  ttlMs: number = HELD_LINK_TTL_MS,
): LinkGate {
  // Closed until the lock says otherwise: the setting is read after the first link can arrive.
  let covered = true;
  let pending: { readonly raw: string; readonly at: number } | null = null;

  const fresh = () => (pending !== null && now() - pending.at <= ttlMs ? pending.raw : null);

  return {
    receive: (raw) => {
      if (covered) {
        // The newest link wins: tapping the tile twice must not queue two chats.
        pending = { raw, at: now() };
        return;
      }
      act(raw);
    },
    setCovered: (next) => {
      covered = next;
      if (covered) return;
      const raw = fresh();
      pending = null;
      if (raw !== null) act(raw);
    },
    held: fresh,
  };
}
