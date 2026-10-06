import { PersonalGroupId, type EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { useAtomCommand } from "~/state/use-atom-command";

import { commandFailureMessage } from "./commandFeedback";
import { personalGroupUpdate } from "./usePersonalGroups";

export interface GroupChatStateActions {
  /** Pin or unpin. Resolves to the message to show when it failed, else null. */
  readonly setPinned: (groupId: string, pinned: boolean) => Promise<string | null>;
  /** A time snoozes the group, null wakes it now. */
  readonly snooze: (groupId: string, untilMs: number | null) => Promise<string | null>;
}

/**
 * Pin and snooze a group (`personalGroups.update`). The command refreshes the
 * groups and bots lists, so the Chats screen redraws from the server's answer.
 * A group has no unread state, so there is no "mark unread" here.
 */
export function useGroupChatState(environmentId: EnvironmentId | null): GroupChatStateActions {
  const updateGroup = useAtomCommand(personalGroupUpdate, { reportFailure: false });
  const send = async (
    groupId: string,
    change: { pinned: boolean } | { snoozedUntil: DateTime.Utc | null },
    fallback: string,
  ): Promise<string | null> => {
    if (environmentId === null) return "Not connected to your computer.";
    const result = await updateGroup({
      environmentId,
      input: { groupId: PersonalGroupId.make(groupId), ...change },
    });
    return commandFailureMessage(result, fallback);
  };
  return {
    setPinned: (groupId, pinned) =>
      send(
        groupId,
        { pinned },
        pinned ? "Couldn't pin this group. Try again." : "Couldn't unpin this group. Try again.",
      ),
    snooze: (groupId, untilMs) =>
      send(
        groupId,
        { snoozedUntil: untilMs === null ? null : DateTime.makeUnsafe(untilMs) },
        untilMs === null
          ? "Couldn't wake this group. Try again."
          : "Couldn't snooze this group. Try again.",
      ),
  };
}
