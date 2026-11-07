import type {
  OrchestrationThreadShell,
  PersonalBotThreadShellStreamItem,
} from "@t3tools/contracts";
import * as Stream from "effect/Stream";

/** The phone's bot-chat shells, keyed by thread id. */
export type BotShellMap = ReadonlyMap<string, OrchestrationThreadShell>;

/** The empty fold, and so the store's value before the snapshot lands. */
export const EMPTY_BOT_SHELLS: BotShellMap = new Map();

/**
 * One stream item folded into the shell map. A snapshot replaces the map
 * because it is authoritative; an upsert is idempotent; a removed item drops
 * the named chats. Returns the same map when nothing changed, so screens do
 * not repaint for a no-op.
 */
export function applyShellStreamItem(
  shells: BotShellMap,
  item: PersonalBotThreadShellStreamItem,
): BotShellMap {
  switch (item.type) {
    case "snapshot":
      return new Map(item.threads.map((thread) => [thread.id, thread] as const));
    case "upsert": {
      if (item.threads.length === 0) return shells;
      const next = new Map(shells);
      for (const thread of item.threads) next.set(thread.id, thread);
      return next;
    }
    case "removed": {
      if (item.threadIds.length === 0 || item.threadIds.every((id) => !shells.has(id))) {
        return shells;
      }
      const next = new Map(shells);
      for (const id of item.threadIds) next.delete(id);
      return next;
    }
  }
}

/** The shared shells store's fold: replay the snapshot, then apply each item. */
export function foldBotShellStream<E, R>(
  stream: Stream.Stream<PersonalBotThreadShellStreamItem, E, R>,
): Stream.Stream<BotShellMap, E, R> {
  return stream.pipe(Stream.scan(() => EMPTY_BOT_SHELLS, applyShellStreamItem));
}
