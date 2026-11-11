import { useEffect, useReducer, useRef } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useStartChat } from "../chat/useStartChat";
import type { NativePersonal } from "../personal/nativePersonalClient";
import { ScreenHeader } from "../shell/ScreenHeader";
import { tokens } from "../shell/tokens";
import { resolveNewChatTarget } from "../tile/ctoTarget";
import { NEW_CHAT_INITIAL, NEW_CHAT_RETRY_MS, stepNewChat } from "./newChatStart";

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
  const connection = native.useConnectionState();
  const connected = connection.phase === "connected";
  const [step, dispatch] = useReducer(stepNewChat, NEW_CHAT_INITIAL);
  const target = list.data === null ? null : resolveNewChatTarget(botId, list.data.bots);
  const targetBotId = target?.kind === "bot" ? target.botId : null;

  // Tell the machine what the screen can see. It starts only on a connected link and a known bot, and
  // asks again when a start was dropped under; a failed start waits a moment so a link that still
  // claims to be up does not spin.
  useEffect(() => {
    if (step.kind !== "waiting") return undefined;
    const event = { type: "inputs", connected, hasTarget: targetBotId !== null } as const;
    if (step.failures === 0) {
      dispatch(event);
      return undefined;
    }
    const timer = setTimeout(() => dispatch(event), NEW_CHAT_RETRY_MS);
    return () => clearTimeout(timer);
  }, [step, connected, targetBotId]);

  // `start` is a new function every render, so the effect reads it through a ref and fires once per
  // entry into "starting" (the key changes with each retry), never on a re-render.
  const startRef = useRef(start);
  useEffect(() => {
    startRef.current = start;
  });
  const startKey = step.kind === "starting" ? step.failures : null;
  useEffect(() => {
    if (startKey === null || targetBotId === null) return;
    let live = true;
    void startRef.current(targetBotId).then((result) => {
      if (live) dispatch({ type: "result", result });
    });
    return () => {
      live = false;
    };
  }, [startKey, targetBotId]);

  const announced = useRef(false);
  useEffect(() => {
    if (step.kind !== "started" || targetBotId === null || announced.current) return;
    announced.current = true;
    onStarted(targetBotId, step.threadId);
  }, [step, targetBotId, onStarted]);

  const error = step.kind === "failed" ? step.message : null;
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
            <ActivityIndicator color={tokens.textSecondary} accessibilityLabel="Starting a chat" />
            {connected ? null : (
              <Text style={styles.waiting} maxFontSizeMultiplier={1.6}>
                Waiting for the connection…
              </Text>
            )}
          </>
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
  waiting: { color: tokens.textSecondary, fontSize: 13, marginTop: 12, textAlign: "center" },
  notice: { color: tokens.textSecondary, fontSize: 14, lineHeight: 20, textAlign: "center" },
});
