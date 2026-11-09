import { ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";
import { StyleSheet, Text } from "react-native";

import { snoozePresets } from "@hbots/personal-client/bots/chatState";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { useNow } from "../chat/useNow";
import type { NativePersonal } from "../personal/nativePersonalClient";
import { tokens } from "../shell/tokens";
import { SheetAction, SheetCancel, SheetShell } from "./SheetShell";

export function SnoozeSheet({
  native,
  visible,
  threadIds,
  onClose,
  onSnoozed,
  onError,
}: {
  readonly native: NativePersonal;
  readonly visible: boolean;
  readonly threadIds: ReadonlyArray<string>;
  readonly onClose: () => void;
  readonly onSnoozed: () => void;
  readonly onError: (message: string) => void;
}) {
  const now = useNow();
  const presets = useMemo(() => snoozePresets(new Date(now)), [now]);
  const updateThreads = native.client.useAtomCommand(native.bots.personalBotUpdateThreads, {
    reportFailure: false,
  });

  const pick = async (untilMs: number) => {
    onClose();
    try {
      const result = await updateThreads({
        environmentId: native.environmentId,
        input: {
          threadIds: threadIds.map((threadId) => ThreadId.make(threadId)),
          snoozedUntil: new Date(untilMs).toISOString() as never,
        },
      });
      if (result._tag === "Success") {
        onSnoozed();
        return;
      }
      const cause = squashAtomCommandFailure(result);
      onError(cause instanceof Error ? cause.message : "Couldn't snooze that chat.");
    } catch {
      onError("Couldn't snooze that chat.");
    }
  };

  return (
    <SheetShell visible={visible} title="Snooze until" onClose={onClose}>
      <Text style={styles.hint}>
        The chat comes back at the top of your list when the snooze ends.
      </Text>
      {presets.map((preset) => (
        <SheetAction
          key={preset.key}
          label={preset.label}
          detail={preset.detail}
          accessibilityLabel={`${preset.label}, ${preset.detail}`}
          onPress={() => void pick(preset.untilMs)}
        />
      ))}
      <SheetCancel onPress={onClose} />
    </SheetShell>
  );
}

const styles = StyleSheet.create({
  hint: {
    color: tokens.textSecondary,
    fontSize: 14,
    lineHeight: 19,
    paddingHorizontal: 12,
    paddingTop: 2,
    paddingBottom: 8,
  },
});
