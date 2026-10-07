import { useEffect, useMemo, useState } from "react";

import type { ChatChip } from "./chatChipRows";

/**
 * The order of the chat chips holds still while the owner stays in a bot's
 * chats, so a chip never moves under a finger: sending in a chat, another chat
 * finishing a turn, switching chips or "+" all leave it alone. A new order is
 * taken on the next entry to the bot's chats, and when the app comes back
 * after a minute or more in the background.
 *
 * `buildChatChips` gives the fresh order (pinned first, then newest activity
 * first). `applyFrozenChipOrder` lays it over the order the owner last saw.
 */

/** What the order looked like when the freeze was taken: the chips in order and who was pinned. */
export interface FrozenChipOrder {
  readonly ids: ReadonlyArray<string>;
  readonly pinned: ReadonlyMap<string, boolean>;
}

/** A page hidden for this long or more is re-sorted when it shows again. */
export const RESORT_AFTER_HIDDEN_MS = 60_000;

function freezeOf(chips: ReadonlyArray<ChatChip>): FrozenChipOrder {
  return {
    ids: chips.map((chip) => chip.threadId),
    pinned: new Map(chips.map((chip) => [chip.threadId, chip.pinned] as const)),
  };
}

/**
 * `fresh` is the owner's chips as `buildChatChips` orders them (pinned first,
 * newest first), without the temporary chip. A chip the freeze knows (same id,
 * same pinned state) keeps its frozen place. Any other chip (a new chat, a
 * woken snooze, a chip whose pin changed) goes where a fresh sort puts it
 * among the known chips of its own group (pinned or not): first in the group
 * when no known chip is newer, else just before the first known chip that
 * follows it in `fresh`, or last. Chips that left (archived, snoozed,
 * deleted) are simply not in `fresh`, so the rest close the gap and a chip
 * that comes back counts as new. Pinned chips stay ahead of the rest because
 * each group is ordered on its own. Returns the chips in display order and the
 * freeze to keep.
 */
export function applyFrozenChipOrder(
  fresh: ReadonlyArray<ChatChip>,
  frozen: FrozenChipOrder | null,
): { readonly chips: ReadonlyArray<ChatChip>; readonly next: FrozenChipOrder } {
  if (frozen === null) return { chips: fresh, next: freezeOf(fresh) };

  const isKnown = (chip: ChatChip) => frozen.pinned.get(chip.threadId) === chip.pinned;
  const knownById = new Map(fresh.filter(isKnown).map((chip) => [chip.threadId, chip] as const));
  // Known chips, in the order they were frozen in.
  const known = frozen.ids.flatMap((id) => {
    const chip = knownById.get(id);
    return chip === undefined ? [] : [chip];
  });

  const orderGroup = (pinned: boolean): ChatChip[] => {
    const group = fresh.filter((chip) => chip.pinned === pinned);
    const kept = known.filter((chip) => chip.pinned === pinned);
    // Each newcomer waits for the first known chip after it in `fresh`; one with no known
    // chip before it is the newest of the group and leads it.
    const head: ChatChip[] = [];
    const before = new Map<string, ChatChip[]>();
    let waiting: ChatChip[] = [];
    let seenKnown = false;
    for (const chip of group) {
      if (!isKnown(chip)) {
        waiting.push(chip);
        continue;
      }
      if (waiting.length > 0) {
        if (seenKnown) before.set(chip.threadId, waiting);
        else head.push(...waiting);
        waiting = [];
      }
      seenKnown = true;
    }
    const ordered: ChatChip[] = [...head];
    for (const chip of kept) ordered.push(...(before.get(chip.threadId) ?? []), chip);
    // Newcomers with no known chip in the group at all lead it too (head holds them); the
    // rest, after every known chip, trail.
    ordered.push(...waiting);
    return ordered;
  };

  const chips = [...orderGroup(true), ...orderGroup(false)];
  return { chips, next: freezeOf(chips) };
}

// --- The freeze, kept per bot for as long as the owner stays in its chats ---------------

const frozenByBot = new Map<string, FrozenChipOrder>();
const presentByBot = new Map<string, number>();

export function readChipFreeze(botId: string): FrozenChipOrder | null {
  return frozenByBot.get(botId) ?? null;
}

export function rememberChipFreeze(botId: string, order: FrozenChipOrder): void {
  frozenByBot.set(botId, order);
}

/** Next time the chips show for `botId` (or every bot), they take a fresh order. */
export function clearChipFreeze(botId?: string): void {
  if (botId === undefined) frozenByBot.clear();
  else frozenByBot.delete(botId);
}

/**
 * The owner is in `botId`'s chats until the returned function runs. Leaving
 * clears that bot's freeze, unless the same bot's chat screen is back right
 * away: switching to another chat of the bot may unmount one screen and mount
 * the next in the same commit, and that is not leaving.
 */
export function enterBotChats(botId: string): () => void {
  presentByBot.set(botId, (presentByBot.get(botId) ?? 0) + 1);
  let left = false;
  return () => {
    if (left) return;
    left = true;
    presentByBot.set(botId, (presentByBot.get(botId) ?? 1) - 1);
    queueMicrotask(() => {
      if ((presentByBot.get(botId) ?? 0) > 0) return;
      presentByBot.delete(botId);
      clearChipFreeze(botId);
    });
  };
}

/** Whether a page that was hidden at `hiddenAtMs` and shows at `nowMs` should take a fresh order. */
export function shouldResortOnResume(hiddenAtMs: number | null, nowMs: number): boolean {
  return hiddenAtMs !== null && nowMs - hiddenAtMs >= RESORT_AFTER_HIDDEN_MS;
}

/**
 * Calls `onResort` when the page shows again after `RESORT_AFTER_HIDDEN_MS` or
 * more hidden. Returns the stop function.
 */
export function watchResumeAfterHidden(
  onResort: () => void,
  now: () => number = Date.now,
): () => void {
  if (typeof document === "undefined") return () => {};
  let hiddenAt: number | null = document.visibilityState === "hidden" ? now() : null;
  const onChange = () => {
    if (document.visibilityState === "hidden") {
      hiddenAt ??= now();
      return;
    }
    const resort = shouldResortOnResume(hiddenAt, now());
    hiddenAt = null;
    if (resort) onResort();
  };
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

/**
 * The owner's chips in the order they last saw, for `botId`. `resortEpoch`
 * moves when the order was re-taken because the app came back after a while:
 * the row centres the open chip again at once.
 */
export function useFrozenChipOrder(
  botId: string,
  ownerChips: ReadonlyArray<ChatChip> | null,
): { readonly chips: ReadonlyArray<ChatChip> | null; readonly resortEpoch: number } {
  const [resortEpoch, setResortEpoch] = useState(0);
  useEffect(() => enterBotChats(botId), [botId]);
  useEffect(
    () =>
      watchResumeAfterHidden(() => {
        clearChipFreeze(botId);
        setResortEpoch((epoch) => epoch + 1);
      }),
    [botId],
  );
  const ordered = useMemo(
    () => (ownerChips === null ? null : applyFrozenChipOrder(ownerChips, readChipFreeze(botId))),
    // The epoch is what makes a cleared freeze take effect when no chip changed.
    [ownerChips, botId, resortEpoch],
  );
  const next = ordered?.next ?? null;
  useEffect(() => {
    if (next !== null) rememberChipFreeze(botId, next);
  }, [botId, next]);
  return { chips: ordered?.chips ?? null, resortEpoch };
}
