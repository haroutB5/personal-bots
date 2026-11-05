import type { PersonalBot, PersonalBotNotificationMute } from "@t3tools/contracts";

import { botMuteState, mutedUntilLabel } from "@hbots/personal-client/bots/botMuteModel";
import { SheetAction, SheetCancel, SheetShell } from "./SheetShell";

export function BotActionsSheet({
  visible,
  bot,
  threadTitle,
  hasThread,
  pinned,
  nowMs,
  onClose,
  onNewChat,
  onAllChats,
  onRename,
  onSnooze,
  onTogglePin,
  onArchive,
  onDeleteChat,
  onMute,
}: {
  readonly visible: boolean;
  readonly bot: PersonalBot | null;
  readonly threadTitle: string | null;
  readonly hasThread: boolean;
  readonly pinned: boolean;
  readonly nowMs: number;
  readonly onClose: () => void;
  readonly onNewChat: () => void;
  readonly onAllChats: () => void;
  readonly onRename: () => void;
  readonly onSnooze: () => void;
  readonly onTogglePin: () => void;
  readonly onArchive: () => void;
  readonly onDeleteChat: () => void;
  readonly onMute: (mute: PersonalBotNotificationMute) => void;
}) {
  const mute = bot === null ? { muted: false as const } : botMuteState(bot, nowMs);
  return (
    <SheetShell visible={visible} title={bot?.name ?? "Bot"} onClose={onClose}>
      <SheetAction label={`New chat with ${bot?.name ?? "this bot"}`} onPress={onNewChat} />
      <SheetAction label="All chats" onPress={onAllChats} />
      {hasThread ? (
        <>
          <SheetAction label="Rename chat" detail={threadTitle ?? undefined} onPress={onRename} />
          <SheetAction label="Snooze" onPress={onSnooze} />
          <SheetAction label={pinned ? "Unpin from Bots" : "Pin to Bots"} onPress={onTogglePin} />
          <SheetAction label="Archive chat" onPress={onArchive} />
          <SheetAction label="Delete chat" danger onPress={onDeleteChat} />
        </>
      ) : null}
      {mute.muted ? (
        <>
          <SheetAction
            label="Unmute notifications"
            detail={mutedUntilLabel(mute, nowMs)}
            onPress={() => onMute("on")}
          />
        </>
      ) : (
        <>
          <SheetAction
            label="For 1 hour"
            detail="Mute notifications"
            onPress={() => onMute({ forMinutes: 60 })}
          />
          <SheetAction
            label="For 8 hours"
            detail="Mute notifications"
            onPress={() => onMute({ forMinutes: 480 })}
          />
          <SheetAction
            label="Mute"
            detail="Until I turn it back on"
            onPress={() => onMute("indefinitely")}
          />
        </>
      )}
      <SheetCancel onPress={onClose} />
    </SheetShell>
  );
}
