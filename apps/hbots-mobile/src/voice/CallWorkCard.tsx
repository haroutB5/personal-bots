import {
  VOICE_UNDO_MS,
  type VoiceWorkCard,
} from "@hbots/personal-client/conversation/voice/callState";
import { motionDuration } from "@hbots/personal-client/motion/motionTokens";
import type { BotAvatarShape } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { Animated, Easing, Pressable, StyleSheet, Text, View } from "react-native";

import { RiseIn } from "../motion/RiseIn";
import { BotAvatar } from "../shell/BotAvatar";
import { tokens } from "../shell/tokens";
import { workCardTitle } from "./callViewModel";

export function CallWorkCard({
  card,
  botName,
  shape,
  color,
  onUndo,
  onOpenChat,
}: {
  readonly card: VoiceWorkCard;
  readonly botName: string;
  readonly shape: BotAvatarShape;
  readonly color: string;
  readonly onUndo: () => void;
  readonly onOpenChat: () => void;
}) {
  const sending = card.kind === "sending";
  const [track] = useState(() => new Animated.Value(1));
  useEffect(() => {
    if (!sending) return;
    track.setValue(1);
    const run = Animated.timing(track, {
      toValue: 0,
      duration: VOICE_UNDO_MS,
      easing: Easing.linear,
      useNativeDriver: true,
    });
    run.start();
    return () => run.stop();
  }, [sending, track]);

  const review = card.kind === "asking" || card.kind === "login";
  const title = workCardTitle(card, botName);

  return (
    <RiseIn enabled duration={motionDuration.callCard}>
      <View
        accessibilityLiveRegion="polite"
        style={[styles.card, review ? styles.review : styles.plain]}
      >
        {sending ? (
          <View style={styles.row}>
            <View style={styles.flex}>
              <Text style={styles.title} maxFontSizeMultiplier={1.4}>
                {title}
              </Text>
              <Text style={styles.detail} numberOfLines={2} maxFontSizeMultiplier={1.4}>
                {card.detail}
              </Text>
            </View>
            <Pressable
              onPress={onUndo}
              accessibilityRole="button"
              accessibilityLabel="Undo the message"
              style={styles.undo}
            >
              <Text style={styles.undoText} maxFontSizeMultiplier={1.4}>
                Undo
              </Text>
            </Pressable>
          </View>
        ) : (
          <Pressable
            onPress={onOpenChat}
            accessibilityRole="button"
            accessibilityLabel={`${title}. Open the chat`}
            style={styles.row}
          >
            <BotAvatar shape={shape} color={color} size={32} label="" />
            <View style={styles.flex}>
              <View style={styles.titleRow}>
                {card.kind === "working" ? <View style={styles.dot} /> : null}
                <Text
                  style={[styles.title, styles.flex]}
                  numberOfLines={1}
                  maxFontSizeMultiplier={1.4}
                >
                  {title}
                </Text>
              </View>
              {card.detail.length > 0 ? (
                <Text
                  style={[styles.detail, review ? styles.detailReview : null]}
                  numberOfLines={card.kind === "replied" || card.kind === "asking" ? 2 : 1}
                  maxFontSizeMultiplier={1.4}
                >
                  {card.detail}
                </Text>
              ) : null}
            </View>
          </Pressable>
        )}
        {sending ? (
          <View style={styles.trackBed} accessibilityElementsHidden>
            <Animated.View
              style={[styles.trackFill, { transform: [{ scaleX: track }] }]}
              testID="voice-undo-track"
            />
          </View>
        ) : null}
      </View>
    </RiseIn>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 16,
    marginBottom: 18,
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
    overflow: "hidden",
  },
  plain: { backgroundColor: tokens.surface, borderColor: tokens.border },
  review: { backgroundColor: tokens.reviewBg, borderColor: tokens.reviewBorder },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  flex: { flex: 1, minWidth: 0 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: tokens.working },
  title: { color: tokens.text, fontSize: 15, lineHeight: 20, fontWeight: "600" },
  detail: { color: tokens.textSecondary, fontSize: 13, lineHeight: 18, marginTop: 4 },
  detailReview: { color: tokens.textPreview },
  undo: {
    minHeight: 44,
    minWidth: 64,
    paddingHorizontal: 16,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: tokens.borderStrong,
    backgroundColor: tokens.fillMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  undoText: { color: tokens.text, fontSize: 15, fontWeight: "600" },
  trackBed: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: 3,
    backgroundColor: tokens.track,
  },
  trackFill: { flex: 1, backgroundColor: tokens.primary, transformOrigin: "left" },
});
