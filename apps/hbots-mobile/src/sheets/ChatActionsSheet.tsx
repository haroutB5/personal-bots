import type { PersonalBotThread } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@hbots/personal-client/bots/threadShell";

import type { ChatEnvironment } from "../chat/chatEnvironment";
import type { NativePersonal } from "../personal/nativePersonalClient";
import { SheetAction, SheetCancel, SheetShell } from "./SheetShell";

export interface ChatActionRow {
  readonly link: PersonalBotThread;
  readonly shell: EnvironmentThreadShell;
}

export function ChatActionsSheet({
  row,
  onClose,
  onRename,
  onTogglePin,
  onArchive,
  onDelete,
  onSnooze,
}: {
  readonly native: NativePersonal;
  readonly chat: ChatEnvironment;
  readonly row: ChatActionRow | null;
  readonly onClose: () => void;
  readonly onRename: (row: ChatActionRow) => void;
  readonly onTogglePin: (row: ChatActionRow) => void;
  readonly onArchive: (row: ChatActionRow) => void;
  readonly onDelete: (row: ChatActionRow) => void;
  readonly onSnooze: (row: ChatActionRow) => void;
}) {
  const title = row?.shell.title ?? "Chat";
  const pinned = row?.link.pinnedAt !== undefined;
  return (
    <SheetShell visible={row !== null} title={title} onClose={onClose}>
      <SheetAction
        label="Rename chat"
        onPress={() => {
          if (row !== null) onRename(row);
        }}
      />
      <SheetAction
        label={pinned ? "Unpin from Bots" : "Pin to Bots"}
        onPress={() => {
          if (row !== null) onTogglePin(row);
        }}
      />
      <SheetAction
        label="Snooze"
        onPress={() => {
          if (row !== null) onSnooze(row);
        }}
      />
      <SheetAction
        label={row?.shell.archivedAt != null ? "Unarchive chat" : "Archive chat"}
        onPress={() => {
          if (row !== null) onArchive(row);
        }}
      />
      <SheetAction
        label="Delete chat"
        danger
        onPress={() => {
          if (row !== null) onDelete(row);
        }}
      />
      <SheetCancel onPress={onClose} />
    </SheetShell>
  );
}
