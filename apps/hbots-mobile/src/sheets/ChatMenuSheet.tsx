import type { PersonalBot, PersonalBotNotificationMute } from "@t3tools/contracts";

import { botMuteState, mutedUntilLabel } from "@hbots/personal-client/bots/botMuteModel";
import { SheetAction, SheetCancel, SheetShell } from "./SheetShell";

export function ChatMenuSheet({
  visible,
  bot,
  running,
  providerWait,
  nowMs,
  onClose,
  onStop,
  onSwitchModel,
  onChatSettings,
  onSearch,
  onCall,
  onNewChat,
  onAllChats,
  onMute,
}: {
  readonly visible: boolean;
  readonly bot: PersonalBot | null;
  readonly running: boolean;
  readonly providerWait: boolean;
  readonly nowMs: number;
  readonly onClose: () => void;
  readonly onStop: () => void;
  readonly onSwitchModel: () => void;
  readonly onChatSettings: () => void;
  readonly onSearch: () => void;
  readonly onCall: () => void;
  readonly onNewChat: () => void;
  readonly onAllChats: () => void;
  readonly onMute: (mute: PersonalBotNotificationMute) => void;
}) {
  const mute = bot === null ? { muted: false as const } : botMuteState(bot, nowMs);
  return (
    <SheetShell visible={visible} title="Chat options" onClose={onClose}>
      {running ? <SheetAction label="Stop" onPress={onStop} /> : null}
      {providerWait ? <SheetAction label="Switch model…" onPress={onSwitchModel} /> : null}
      <SheetAction label="Chat settings…" onPress={onChatSettings} />
      <SheetAction label="Search messages" onPress={onSearch} />
      {bot?.allowVoiceCalls === true ? (
        <SheetAction label={`Call ${bot.name}`} onPress={onCall} />
      ) : null}
      <SheetAction label="New chat" onPress={onNewChat} />
      <SheetAction label="All chats" onPress={onAllChats} />
      {mute.muted ? (
        <SheetAction
          label="Unmute notifications"
          detail={mutedUntilLabel(mute, nowMs)}
          onPress={() => onMute("on")}
        />
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
