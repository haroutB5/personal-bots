import type { PersonalBotUpdateThreadsInput, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { BulkChatAction, ChatStateAction } from "./chatSelection.ts";

/** What a state action needs besides the chats: when a snooze ends. */
export interface BulkChatOptions {
  readonly snoozeUntilMs?: number | undefined;
}

export type BulkChatOutcome =
  | { readonly status: "cancelled" }
  | {
      readonly status: "settled";
      readonly notice: string;
      /** Chats the server refused or could not reach; they stay selected. */
      readonly failedIds: ReadonlyArray<string>;
      readonly anyFailed: boolean;
    };

export const BULK_NOT_CONNECTED_NOTICE = "Not connected to your computer.";

export function bulkChatStateInput(
  action: ChatStateAction,
  threadIds: ReadonlyArray<ThreadId>,
  options: BulkChatOptions | undefined,
  nowMs: number,
): PersonalBotUpdateThreadsInput {
  switch (action) {
    case "pin":
      return { threadIds, pinned: true };
    case "unpin":
      return { threadIds, pinned: false };
    case "snooze":
      return { threadIds, snoozedUntil: DateTime.makeUnsafe(options?.snoozeUntilMs ?? nowMs) };
    case "wake":
      return { threadIds, snoozedUntil: null };
    case "markUnread":
      return { threadIds, markUnread: true };
  }
}

/** The verb in "Couldn't <verb> these chats." */
export function bulkChatFailureVerb(action: BulkChatAction): string {
  switch (action) {
    case "delete":
      return "delete";
    case "markUnread":
      return "mark";
    case "wake":
      return "wake";
    default:
      return action;
  }
}

export function bulkChatFailureFallback(action: BulkChatAction): string {
  return `Couldn't ${bulkChatFailureVerb(action)} these chats. Try again.`;
}
