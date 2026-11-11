import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useStartChat } from "../chat/useStartChat";
import type { NativePersonal } from "../personal/nativePersonalClient";
import { ScreenHeader } from "../shell/ScreenHeader";
import { tokens } from "../shell/tokens";
import { resolveNewChatTarget } from "../tile/ctoTarget";

/**
 * Opened by `hbots://bot/<id>?new=1` (the Quick Settings tile and the launcher
 * shortcut). It starts one new chat with the bot and replaces itself with it,
 * so Back from the chat returns to Bots.
 */
export function BotNewChatScreen({
  native,
  botId,
  onBack,
  onStarted,
}: {
  readonly native: NativePersonal;
  readonly botId: string;
  readonly onBack: () => void;
  readonly onStarted: (botId: string, threadId: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const list = native.bots.usePersonalBotsList(native.environmentId);
  const start = useStartChat(native);
  const [error, setError] = useState<string | null>(null);
  const begun = useRef(false);
  const target = list.data === null ? null : resolveNewChatTarget(botId, list.data.bots);
  const targetBotId = target?.kind === "bot" ? target.botId : null;

  useEffect(() => {
    // The chat starts once per opening of this screen, whatever re-renders.
    if (targetBotId === null || begun.current) return;
    begun.current = true;
    void start(targetBotId).then((result) => {
      if (result.kind === "started") onStarted(targetBotId, result.threadId);
      else setError(result.message);
    });
  }, [targetBotId, start, onStarted]);

  const notice =
    error ??
    (target?.kind === "no-cto"
      ? "You don't have a CTO bot yet. Make the lead of the Dev team your CTO, then try again."
      : target?.kind === "missing"
        ? "That bot isn't available any more."
        : list.error !== null
          ? "Couldn't load your bots."
          : null);

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <ScreenHeader title="New chat" onBack={onBack} />
      <View style={styles.body}>
        {notice === null ? (
          <ActivityIndicator color={tokens.textSecondary} accessibilityLabel="Starting a chat" />
        ) : (
          <Text style={styles.notice} accessibilityRole="alert" maxFontSizeMultiplier={1.6}>
            {notice}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: tokens.bg },
  body: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  notice: { color: tokens.textSecondary, fontSize: 14, lineHeight: 20, textAlign: "center" },
});
