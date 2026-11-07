import { IconArrowUp, IconPlayerStop } from "@tabler/icons-react-native";
import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import type { GroupComposerMode } from "./groupScreenModel";
import { tokens } from "../shell/tokens";

/**
 * The group composer: one message opens one round, and Stop is the only thing
 * offered while that round owns the group.
 */
export function GroupComposer({
  mode,
  onSend,
  onStop,
}: {
  readonly mode: GroupComposerMode;
  readonly onSend: (text: string) => Promise<string | null>;
  readonly onStop: () => Promise<string | null>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (mode.kind === "blocked") {
    return (
      <View style={styles.blocked}>
        <Text style={styles.blockedText}>{mode.reason}</Text>
      </View>
    );
  }

  if (mode.kind === "stop") {
    return (
      <View style={styles.bar}>
        <Pressable
          disabled={busy}
          onPress={async () => {
            setBusy(true);
            setError(await onStop());
            setBusy(false);
          }}
          accessibilityRole="button"
          accessibilityLabel="Stop the group"
          style={[styles.stop, busy ? styles.disabled : null]}
        >
          {busy ? (
            <ActivityIndicator color={tokens.text} />
          ) : (
            <IconPlayerStop size={18} color={tokens.text} strokeWidth={1.75} />
          )}
          <Text style={styles.stopText}>Stop</Text>
        </Pressable>
        {error !== null ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    );
  }

  const canSend = text.trim().length > 0 && !busy;

  const send = async () => {
    if (!canSend) return;
    setBusy(true);
    setError(null);
    const failure = await onSend(text.trim());
    if (failure !== null) {
      setError(failure);
    } else {
      setText("");
    }
    setBusy(false);
  };

  return (
    <View style={styles.bar}>
      <View style={styles.inputRow}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Message the group"
          placeholderTextColor={tokens.textTertiary}
          accessibilityLabel="Message the group"
          multiline
          maxFontSizeMultiplier={1.5}
          style={styles.input}
        />
        <Pressable
          disabled={!canSend}
          onPress={() => void send()}
          accessibilityRole="button"
          accessibilityLabel="Send"
          accessibilityState={{ disabled: !canSend, busy }}
          style={[styles.send, !canSend ? styles.disabled : null]}
        >
          {busy ? (
            <ActivityIndicator color={tokens.primaryText} />
          ) : (
            <IconArrowUp size={20} color={tokens.primaryText} strokeWidth={2.25} />
          )}
        </Pressable>
      </View>
      {error !== null ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: tokens.border,
    backgroundColor: tokens.bg,
    paddingHorizontal: 12,
    paddingTop: 8,
    gap: 6,
  },
  inputRow: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  input: {
    flex: 1,
    minHeight: 42,
    maxHeight: 132,
    borderRadius: 21,
    backgroundColor: tokens.fillMuted,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    paddingHorizontal: 16,
    paddingTop: 11,
    paddingBottom: 11,
    color: tokens.text,
    fontSize: 15,
    lineHeight: 20,
  },
  send: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: tokens.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  stop: {
    minHeight: 44,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.borderStrong,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  stopText: { color: tokens.text, fontSize: 15, fontWeight: "600" },
  blocked: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: tokens.border,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  blockedText: { color: tokens.textSecondary, fontSize: 14, textAlign: "center" },
  error: { color: tokens.danger, fontSize: 13, lineHeight: 18 },
  disabled: { opacity: 0.4 },
});
