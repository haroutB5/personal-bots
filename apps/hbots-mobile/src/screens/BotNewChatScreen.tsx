import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { startUntilConnected } from "../chat/startRetry";
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
  const [connecting, setConnecting] = useState(false);
  const [round, setRound] = useState(0);
  const begun = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // One id for this opening, reused by every retry: the chat is created once.
  const threadId = useRef<string | null>(null);
  const target = list.data === null ? null : resolveNewChatTarget(botId, list.data.bots);
  const targetBotId = target?.kind === "bot" ? target.botId : null;

  useEffect(() => {
    // The chat starts once per opening of this screen, whatever re-renders.
    if (targetBotId === null || begun.current) return;
    begun.current = true;
    threadId.current ??= native.client.ports.ids.randomUUID();
    const id = threadId.current;
    void startUntilConnected(() => start(targetBotId, undefined, id), {
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      onConnecting: () => setConnecting(true),
      abandoned: () => !mounted.current,
    }).then((result) => {
      if (!mounted.current) return;
      setConnecting(false);
      if (result.kind === "started") onStarted(targetBotId, result.threadId);
      else setError(result.message);
    });
    // `round` is the Try again button: it reopens the start with the same id.
  }, [targetBotId, start, onStarted, native, round]);

  const tryAgain = () => {
    begun.current = false;
    setError(null);
    setRound((value) => value + 1);
  };

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
          <>
            <ActivityIndicator
              color={tokens.textSecondary}
              accessibilityLabel={connecting ? "Connecting to your laptop" : "Starting a chat"}
            />
            {connecting ? (
              <Text style={styles.notice} accessibilityLiveRegion="polite" maxFontSizeMultiplier={1.6}>
                Connecting to your laptop...
              </Text>
            ) : null}
          </>
        ) : (
          <>
            <Text style={styles.notice} accessibilityRole="alert" maxFontSizeMultiplier={1.6}>
              {notice}
            </Text>
            {error !== null ? (
              <Pressable onPress={tryAgain} accessibilityRole="button" style={styles.retry}>
                <Text style={styles.retryText} maxFontSizeMultiplier={1.6}>
                  Try again
                </Text>
              </Pressable>
            ) : null}
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: tokens.bg },
  body: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  notice: { color: tokens.textSecondary, fontSize: 14, lineHeight: 20, textAlign: "center" },
  retry: {
    minHeight: 48,
    marginTop: 16,
    paddingHorizontal: 24,
    borderRadius: 12,
    backgroundColor: tokens.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  retryText: { color: tokens.primaryText, fontSize: 16, fontWeight: "700" },
});
