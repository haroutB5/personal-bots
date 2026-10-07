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
 * Given that the session holds the rules sent earlier: `repeat` when the set is unchanged (a one-line reminder);
 * `addedRules` when app scoping is on and only rules were added, each limited to an app (sent alone, on top of the
 * list there); `delta` when that is the case. Otherwise the full list goes again.
 */
export const preferenceSend = <
  T extends { readonly memoryId: string; readonly apps?: ReadonlyArray<string> | null | undefined },
>(input: {
  readonly reusable: boolean;
  readonly previous: SentPreferences | undefined;
  readonly setKey: string;
  readonly currentIds: ReadonlyMap<string, number>;
  readonly listed: ReadonlyArray<T>;
  readonly scoping: boolean;
}) => {
  const { reusable, previous, listed } = input;
  const repeat = reusable && previous !== undefined && previous.setKey === input.setKey;
  const addedRules =
    reusable &&
    !repeat &&
    previous !== undefined &&
    input.scoping &&
    [...previous.ids].every(([id, version]) => input.currentIds.get(id) === version)
      ? listed.filter((entry) => !previous.ids.has(entry.memoryId))
      : [];
  const delta = addedRules.length > 0 && addedRules.every((entry) => (entry.apps ?? null) !== null);
  return { repeat, addedRules, delta };
};
