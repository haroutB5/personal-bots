// What a turn's memory block repeats: which apps a chat keeps carrying and whether the session already holds the rules
// list. Pure.
import type { ActiveApp } from "./memoryApps.ts";
import type { SentPreferences } from "./memoryCore.ts";

/**
 * The apps a turn is about: the ones detected now, then the ones the session was already about (they only grow until
 * the session key changes), so a chat that flips between apps lists each one's rules once. At most `max`.
 */
export const carryActiveApps = (input: {
  readonly detected: ReadonlyArray<ActiveApp>;
  readonly session: { readonly key: string; readonly fresh: boolean } | undefined;
  readonly sticky: { readonly sessionKey: string; readonly slugs: ReadonlySet<string> } | undefined;
  readonly max: number;
}): Array<ActiveApp> => {
  const { detected, session, sticky } = input;
  const carried =
    session !== undefined &&
    !session.fresh &&
    sticky !== undefined &&
    sticky.sessionKey === session.key
      ? [...sticky.slugs]
      : [];
  const detectedSlugs = new Set(detected.map((app) => app.slug));
  return [
    ...detected,
    ...carried
      .filter((slug) => !detectedSlugs.has(slug))
      .map((slug): ActiveApp => ({ slug, via: ["earlier"] })),
  ].slice(0, input.max);
};

/**
 * Whether the session still holds the rules list sent earlier, so this turn may send a reminder (or only the added
 * rules) instead of the full list: same session, not fresh, rules to list, and fewer than `resendEvery` turns since the
 * last full send. Whether the provider compacted the chat since is the caller's check (it reads the database).
 */
export const sessionHoldsRules = (input: {
  readonly session: { readonly key: string; readonly fresh: boolean } | undefined;
  readonly listedCount: number;
  readonly previous: SentPreferences | undefined;
  readonly resendEvery: number;
}): boolean =>
  input.session !== undefined &&
  !input.session.fresh &&
  input.listedCount > 0 &&
  input.previous !== undefined &&
  input.previous.sessionKey === input.session.key &&
  input.previous.turns + 1 < input.resendEvery;

/**
 * Given that the session holds the rules sent earlier: what changed since, as
 * lines to send on top of that list instead of the whole list.
 *
 * `repeat` when nothing changed (a one-line reminder). Otherwise `delta` is
 * true when every listed rule can be accounted for: added rules, rules whose
 * version moved (they are sent again, marked as the new text), and rules that
 * were forgotten or replaced (named by id so the bot stops applying them).
 * `delta` stays false when an edited rule's new version did not make the
 * listed set, because then the new text cannot be sent and the full list is
 * the only honest answer. A rule that merely fell out of the caps is not a
 * removal: its earlier line still applies and `allIds` still holds it.
 */
export const preferenceSend = <
  T extends {
    readonly memoryId: string;
    readonly version: number;
    readonly apps?: ReadonlyArray<string> | null | undefined;
  },
>(input: {
  readonly reusable: boolean;
  readonly previous: SentPreferences | undefined;
  readonly setKey: string;
  readonly currentIds: ReadonlyMap<string, number>;
  /** Every rule the bot can see right now, listed or not. */
  readonly allIds: ReadonlyMap<string, number>;
  readonly listed: ReadonlyArray<T>;
}) => {
  const { reusable, previous, listed } = input;
  if (!reusable || previous === undefined) {
    return { repeat: false, added: [], updated: [], removed: [], delta: false };
  }
  const repeat = previous.setKey === input.setKey;
  if (repeat) {
    return { repeat, added: [], updated: [], removed: [], delta: false };
  }
  const added = listed.filter((entry) => !previous.ids.has(entry.memoryId));
  const updated = listed.filter((entry) => {
    const before = previous.ids.get(entry.memoryId);
    return before !== undefined && before !== entry.version;
  });
  const removed = [...previous.ids.keys()].filter((id) => !input.allIds.has(id));
  // An edit whose new version the caps kept out of the list cannot be described here.
  const stale = [...previous.ids].some(([id, version]) => {
    const current = input.allIds.get(id);
    return current !== undefined && current !== version && input.currentIds.get(id) !== current;
  });
  const changed = added.length + updated.length + removed.length > 0;
  // Nothing changed at all — including a rule that merely left this turn's
  // listed set but is still visible — so the earlier list is still exactly
  // right and a reminder says so.
  return { repeat: !changed && !stale, added, updated, removed, delta: changed && !stale };
};

/**
 * The notes to show this turn: all picked notes on a full-refresh turn, and
 * only those this session has not shown yet (or whose text changed) on the
 * turns between. A chat that has run for an hour stops repeating the same
 * three notes twenty times, but a note is still shown once when first picked.
 */
export const freshNotes = <
  T extends { readonly memoryId: string; readonly version: number },
>(input: {
  readonly picked: ReadonlyArray<T>;
  readonly shown: ReadonlyMap<string, number> | undefined;
  readonly refresh: boolean;
}): ReadonlyArray<T> =>
  input.refresh
    ? input.picked
    : input.picked.filter((e) => input.shown?.get(e.memoryId) !== e.version);
