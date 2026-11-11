import { formatCallDuration } from "@hbots/personal-client/conversation/voice/callState";
import { IconMicrophone, IconMicrophoneOff, IconPhoneOff } from "@tabler/icons-react-native";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { tokens } from "../shell/tokens";
import type { CallView } from "./callSession";
import { CALL_BAR_GAP, CALL_BAR_HEIGHT, callBarLabel } from "./callViewModel";

export function CallBar({
  view,
  onReturn,
  onToggleMute,
  onEnd,
}: {
  readonly view: CallView;
  readonly onReturn: () => void;
  readonly onToggleMute: () => void;
  readonly onEnd: () => void;
}) {
  const insets = useSafeAreaInsets();
  const call = view.call;
  if (call === null) return null;
  const muted = view.snapshot.state.muted;
  return (
    <View style={[styles.wrap, { paddingTop: insets.top + CALL_BAR_GAP }]} pointerEvents="box-none">
      <View style={styles.bar}>
        <Pressable
          onPress={onReturn}
          accessibilityRole="button"
          accessibilityLabel={`Return to the call with ${call.botName}, ${formatCallDuration(view.snapshot.elapsedMs)}`}
          style={styles.main}
        >
          <View style={[styles.dot, { backgroundColor: tokens.working }]} />
          <Text style={styles.name} numberOfLines={1} maxFontSizeMultiplier={1.3}>
            {call.botName}
          </Text>
          <Text style={styles.time} maxFontSizeMultiplier={1.3}>
            {callBarLabel(view)}
          </Text>
        </Pressable>
        <Pressable
          onPress={onToggleMute}
          accessibilityRole="button"
          accessibilityLabel={muted ? "Unmute" : "Mute"}
          accessibilityState={{ selected: muted }}
          style={[styles.button, muted ? styles.buttonOn : null]}
        >
          {muted ? (
            <IconMicrophoneOff size={20} color={tokens.bg} strokeWidth={1.75} />
          ) : (
            <IconMicrophone size={20} color={tokens.text} strokeWidth={1.75} />
          )}
        </Pressable>
        <Pressable
          onPress={onEnd}
          accessibilityRole="button"
          accessibilityLabel="End call"
          style={[styles.button, styles.end]}
        >
          <IconPhoneOff size={20} color={tokens.dangerBg} strokeWidth={1.75} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "absolute", top: 0, left: 0, right: 0, paddingHorizontal: 8 },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    height: CALL_BAR_HEIGHT,
    borderRadius: CALL_BAR_HEIGHT / 2,
    borderWidth: 1,
    borderColor: tokens.border,
    backgroundColor: tokens.raised,
    paddingLeft: 14,
    paddingRight: 4,
    gap: 4,
  },
  main: { flex: 1, minHeight: 48, flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  name: { flexShrink: 1, color: tokens.text, fontSize: 15, fontWeight: "600" },
  time: { color: tokens.textSecondary, fontSize: 14, fontVariant: ["tabular-nums"] },
  button: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: tokens.fillMuted,
  },
  buttonOn: { backgroundColor: tokens.text },
  end: { backgroundColor: tokens.danger },
});
