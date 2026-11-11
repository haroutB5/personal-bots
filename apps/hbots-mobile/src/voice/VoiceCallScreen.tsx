import {
  callEverConnected,
  callMetaLine,
  endReasonLine,
  limitBannerText,
  pillLabel,
  voiceCaptionLabel,
} from "@hbots/personal-client/conversation/voice/callState";
import type { BotAvatarShape } from "@t3tools/contracts";
import {
  IconBadgeCc,
  IconChevronDown,
  IconLoader2,
  IconMicrophone,
  IconMicrophoneOff,
  IconPhoneOff,
} from "@tabler/icons-react-native";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  BackHandler,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { tokens } from "../shell/tokens";
import { CallStage } from "./CallStage";
import { CallWorkCard } from "./CallWorkCard";
import type { CallErrorCopy } from "./callErrorCopy";
import type { CallView } from "./callSession";
import { CALL_TIP, routeLine } from "./callViewModel";
import { phoneWording } from "./phoneWording";

let tipShown = false;

export function VoiceCallScreen({
  view,
  error,
  onMinimise,
  onToggleCaptions,
  onToggleMute,
  onEnd,
  onUndo,
  onOpenChat,
  onDismissRecovered,
  readLevel,
  maxCallMinutes,
}: {
  readonly view: CallView;
  readonly error: CallErrorCopy | null;
  readonly onMinimise: () => void;
  readonly onToggleCaptions: () => void;
  readonly onToggleMute: () => void;
  readonly onEnd: () => void;
  readonly onUndo: () => void;
  readonly onOpenChat: () => void;
  readonly onDismissRecovered: () => void;
  readonly readLevel: () => number;
  readonly maxCallMinutes: number;
}) {
  const insets = useSafeAreaInsets();
  const call = view.call;
  const state = view.snapshot.state;

  useEffect(() => {
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      onMinimise();
      return true;
    });
    return () => back.remove();
  }, [onMinimise]);

  const live = state.status === "live";
  const [tipArmed] = useState(() => !tipShown);
  useEffect(() => {
    if (live) tipShown = true;
  }, [live]);
  const showTip = tipArmed && live;

  if (call === null) return null;
  const botName = call.botName;
  const shape = call.avatarShape as BotAvatarShape;
  const speaking = state.pill === "speaking" || state.pill === "reading";
  const inCall = state.status === "live" || state.status === "reconnecting";
  const caption = state.caption;
  const route = routeLine(view.route);

  const hint =
    state.status === "ended"
      ? (state.hint ??
        (state.endReason ? endReasonLine(state.endReason, view.snapshot.quietMinutes) : ""))
      : state.hint;

  return (
    <View
      style={[
        styles.screen,
        { paddingTop: insets.top, paddingBottom: Math.max(insets.bottom, 12) },
      ]}
      accessibilityViewIsModal
      accessibilityLabel={`Call with ${botName}`}
    >
      <View style={styles.topBar}>
        <Pressable
          onPress={onMinimise}
          accessibilityRole="button"
          accessibilityLabel={`Back to the chat. The call with ${botName} keeps going`}
          style={styles.topButton}
        >
          <IconChevronDown size={26} color={tokens.text} strokeWidth={1.75} />
        </Pressable>
        <Pressable
          onPress={onToggleCaptions}
          accessibilityRole="button"
          accessibilityLabel={view.captionsOn ? "Hide captions" : "Show captions"}
          accessibilityState={{ selected: view.captionsOn }}
          style={[styles.topButton, view.captionsOn ? styles.topButtonOn : null]}
        >
          <IconBadgeCc
            size={24}
            color={view.captionsOn ? tokens.text : tokens.textSecondary}
            strokeWidth={1.75}
          />
        </Pressable>
      </View>

      {view.recovered ? (
        <Pressable
          onPress={onDismissRecovered}
          accessibilityRole="button"
          accessibilityLabel="Dismiss: the last call ended when hbots was closed"
          style={styles.notice}
        >
          <Text style={styles.noticeText} maxFontSizeMultiplier={1.4}>
            Your last call ended when hbots was closed.
          </Text>
        </Pressable>
      ) : null}

      {state.nearLimit && state.status === "live" ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText} maxFontSizeMultiplier={1.4}>
            {limitBannerText(maxCallMinutes)}
          </Text>
        </View>
      ) : null}

      <ScrollView
        contentContainerStyle={styles.body}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.stage}>
          <CallStage
            shape={shape}
            color={call.avatarColor}
            label={botName}
            speaking={speaking}
            live={inCall}
            readLevel={readLevel}
          />
        </View>
        <Text
          style={styles.name}
          numberOfLines={1}
          accessibilityRole="header"
          maxFontSizeMultiplier={1.3}
        >
          {botName}
        </Text>
        <Text style={styles.meta} maxFontSizeMultiplier={1.4}>
          {callMetaLine({
            status: state.status,
            elapsedMs: view.snapshot.elapsedMs,
            everConnected: callEverConnected(state.status),
          })}
        </Text>

        <View style={styles.pillRow}>
          {inCall ? (
            <View
              accessibilityRole="text"
              accessibilityLiveRegion="polite"
              style={[styles.pill, state.pill === "muted" ? styles.pillMuted : null]}
            >
              {state.status === "reconnecting" ||
              state.pill === "checking_memory" ||
              state.pill === "searching" ? (
                <ActivityIndicator size="small" color={tokens.text} />
              ) : state.pill === "muted" ? (
                <IconMicrophoneOff size={18} color={tokens.bg} strokeWidth={2} />
              ) : (
                <IconMicrophone size={18} color={tokens.text} strokeWidth={2} />
              )}
              <Text
                style={[styles.pillText, state.pill === "muted" ? styles.pillTextMuted : null]}
                maxFontSizeMultiplier={1.4}
              >
                {pillLabel(state.status === "reconnecting" ? "reconnecting" : state.pill, botName)}
              </Text>
            </View>
          ) : state.status === "connecting" ? (
            <IconLoader2 size={20} color={tokens.textSecondary} strokeWidth={1.75} />
          ) : null}
        </View>

        {view.held && inCall ? (
          <Text style={styles.small} maxFontSizeMultiplier={1.4}>
            Paused. Another app is using the audio.
          </Text>
        ) : null}
        {route !== null && inCall ? (
          <Text style={styles.small} maxFontSizeMultiplier={1.4}>
            {route}
          </Text>
        ) : null}

        <View style={styles.captions} accessibilityLiveRegion="none">
          {state.status === "ended" || hint !== null ? (
            <Text style={styles.hint} maxFontSizeMultiplier={1.4}>
              {phoneWording(hint ?? "")}
            </Text>
          ) : view.captionsOn && caption !== null ? (
            <>
              <Text style={styles.captionWho} maxFontSizeMultiplier={1.4}>
                {caption.who === "you" ? "You" : voiceCaptionLabel(botName)}
              </Text>
              <Text style={styles.captionText} maxFontSizeMultiplier={1.4}>
                {caption.text}
              </Text>
            </>
          ) : null}
        </View>

        {showTip ? (
          <Text style={styles.small} maxFontSizeMultiplier={1.4}>
            {CALL_TIP}
          </Text>
        ) : null}
        {state.quietWarning && state.status === "live" ? (
          <Text style={styles.quiet} maxFontSizeMultiplier={1.4}>
            Still there? The call ends in 15 seconds.
          </Text>
        ) : null}
      </ScrollView>

      {error !== null ? (
        <ErrorBlock error={error} />
      ) : state.status === "ended" ? null : (
        <>
          {state.work !== null && state.work.kind !== "replied" ? (
            <CallWorkCard
              card={state.work}
              botName={botName}
              shape={shape}
              color={call.avatarColor}
              onUndo={onUndo}
              onOpenChat={onOpenChat}
            />
          ) : null}
          <Controls
            muted={state.muted}
            connecting={state.status === "connecting"}
            onToggleMute={onToggleMute}
            onEnd={onEnd}
          />
        </>
      )}
    </View>
  );
}

function Controls({
  muted,
  connecting,
  onToggleMute,
  onEnd,
}: {
  readonly muted: boolean;
  readonly connecting: boolean;
  readonly onToggleMute: () => void;
  readonly onEnd: () => void;
}) {
  return (
    <View style={styles.controls}>
      <View style={styles.control}>
        <Pressable
          onPress={onToggleMute}
          accessibilityRole="button"
          accessibilityLabel={muted ? "Unmute" : "Mute"}
          accessibilityState={{ selected: muted }}
          style={[styles.round, muted ? styles.roundOn : null]}
        >
          {muted ? (
            <IconMicrophoneOff size={30} color={tokens.bg} strokeWidth={1.75} />
          ) : (
            <IconMicrophone size={30} color={tokens.text} strokeWidth={1.75} />
          )}
        </Pressable>
        <Text style={styles.controlLabel} maxFontSizeMultiplier={1.4}>
          {muted ? "Unmute" : "Mute"}
        </Text>
      </View>
      <View style={styles.control}>
        <Pressable
          onPress={onEnd}
          accessibilityRole="button"
          accessibilityLabel={connecting ? "Cancel call" : "End call"}
          style={[styles.round, styles.roundEnd]}
        >
          <IconPhoneOff size={30} color={tokens.dangerBg} strokeWidth={1.75} />
        </Pressable>
        <Text style={styles.controlLabel} maxFontSizeMultiplier={1.4}>
          {connecting ? "Cancel" : "End"}
        </Text>
      </View>
    </View>
  );
}

function ErrorBlock({ error }: { readonly error: CallErrorCopy }) {
  return (
    <View style={styles.error}>
      <Text style={styles.errorTitle} accessibilityRole="header" maxFontSizeMultiplier={1.4}>
        {error.title}
      </Text>
      <Text style={styles.errorBody} maxFontSizeMultiplier={1.4}>
        {error.body}
      </Text>
      <Pressable onPress={error.onPrimary} accessibilityRole="button" style={styles.errorPrimary}>
        <Text style={styles.errorPrimaryText} maxFontSizeMultiplier={1.4}>
          {error.primary}
        </Text>
      </Pressable>
      {error.secondary !== undefined && error.onSecondary !== undefined ? (
        <Pressable
          onPress={error.onSecondary}
          accessibilityRole="button"
          style={styles.errorSecondary}
        >
          <Text style={styles.errorSecondaryText} maxFontSizeMultiplier={1.4}>
            {error.secondary}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: tokens.bg,
  },
  topBar: {
    height: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 8,
  },
  topButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  topButtonOn: { backgroundColor: tokens.fillMuted },
  notice: {
    marginHorizontal: 16,
    marginBottom: 8,
    minHeight: 40,
    borderRadius: 20,
    backgroundColor: tokens.fillMuted,
    paddingHorizontal: 16,
    justifyContent: "center",
  },
  noticeText: { color: tokens.textSecondary, fontSize: 13, lineHeight: 18, textAlign: "center" },
  banner: {
    marginHorizontal: 16,
    marginBottom: 8,
    minHeight: 36,
    borderRadius: 18,
    backgroundColor: tokens.reviewBg,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  bannerText: { color: tokens.reviewText, fontSize: 13, fontWeight: "600" },
  body: { flexGrow: 1, paddingBottom: 12 },
  stage: { paddingTop: 16 },
  name: {
    marginTop: 24,
    paddingHorizontal: 24,
    textAlign: "center",
    color: tokens.text,
    fontSize: 28,
    lineHeight: 34,
    fontWeight: "700",
  },
  meta: {
    marginTop: 4,
    textAlign: "center",
    color: tokens.textSecondary,
    fontSize: 15,
    lineHeight: 20,
    fontVariant: ["tabular-nums"],
  },
  pillRow: { marginTop: 18, minHeight: 32, alignItems: "center", justifyContent: "center" },
  pill: {
    height: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    borderRadius: 16,
    backgroundColor: tokens.fillMuted,
  },
  pillMuted: { backgroundColor: tokens.text },
  pillText: { color: tokens.text, fontSize: 15, fontWeight: "600" },
  pillTextMuted: { color: tokens.bg },
  small: {
    marginTop: 8,
    paddingHorizontal: 28,
    textAlign: "center",
    color: tokens.textTertiary,
    fontSize: 13,
    lineHeight: 18,
  },
  quiet: {
    marginTop: 8,
    paddingHorizontal: 28,
    textAlign: "center",
    color: tokens.reviewText,
    fontSize: 13,
    lineHeight: 18,
  },
  captions: { marginTop: 14, minHeight: 84, paddingHorizontal: 28, justifyContent: "flex-end" },
  hint: { textAlign: "center", color: tokens.textSecondary, fontSize: 15, lineHeight: 21 },
  captionWho: { textAlign: "center", color: tokens.textTertiary, fontSize: 13, fontWeight: "600" },
  captionText: {
    textAlign: "center",
    color: tokens.text,
    fontSize: 20,
    lineHeight: 28,
    fontWeight: "500",
  },
  controls: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 72,
    paddingHorizontal: 24,
    paddingBottom: 12,
  },
  control: { alignItems: "center", gap: 6 },
  round: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 1,
    borderColor: tokens.border,
    backgroundColor: tokens.fillMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  roundOn: { backgroundColor: tokens.text, borderColor: tokens.text },
  roundEnd: { backgroundColor: tokens.danger, borderColor: tokens.danger },
  controlLabel: { color: tokens.textSecondary, fontSize: 13, fontWeight: "500" },
  error: {
    marginHorizontal: 16,
    marginBottom: 16,
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
    gap: 8,
  },
  errorTitle: { color: tokens.text, fontSize: 20, lineHeight: 26, fontWeight: "700" },
  errorBody: { color: tokens.textSecondary, fontSize: 15, lineHeight: 21 },
  errorPrimary: {
    marginTop: 8,
    minHeight: 48,
    borderRadius: 24,
    backgroundColor: tokens.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  errorPrimaryText: { color: tokens.primaryText, fontSize: 15, fontWeight: "600" },
  errorSecondary: {
    minHeight: 48,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: tokens.border,
    backgroundColor: tokens.fillMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  errorSecondaryText: { color: tokens.text, fontSize: 15, fontWeight: "600" },
});
