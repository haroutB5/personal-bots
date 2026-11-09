import type { ChoicesState } from "@hbots/personal-client/conversation/choices";
import { IconCheck } from "@tabler/icons-react-native";
import { useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { tokens } from "../shell/tokens";

/**
 * A bot's tap-to-answer options as full-width buttons. A tap sends the option
 * as the owner's own message through `onChoose`, once: a second tap while the
 * first is on its way does nothing, and a send that fails frees the set again.
 */
export function ChoiceButtons({
  options,
  state,
  onChoose,
}: {
  readonly options: ReadonlyArray<string>;
  readonly state: ChoicesState;
  /** Resolves true once the message was sent. */
  readonly onChoose: ((text: string) => Promise<boolean>) | undefined;
}) {
  const [sent, setSent] = useState<string | null>(null);
  const sendingRef = useRef(false);
  const used = state.kind === "used";
  const picked = used ? state.picked : sent;
  const locked = used || sent !== null || state.disabled || onChoose === undefined;

  const choose = (option: string) => {
    if (locked || sendingRef.current || onChoose === undefined) return;
    sendingRef.current = true;
    setSent(option);
    void onChoose(option)
      .then((ok) => {
        if (ok) return;
        sendingRef.current = false;
        setSent(null);
      })
      .catch(() => {
        sendingRef.current = false;
        setSent(null);
      });
  };

  return (
    <View style={styles.group} accessibilityLabel="Quick answers">
      {options.map((option) => {
        const isPicked = picked === option;
        const disabled = locked;
        return (
          <Pressable
            key={option}
            accessibilityRole="button"
            accessibilityState={{ disabled, selected: isPicked }}
            disabled={disabled}
            onPress={() => choose(option)}
            style={({ pressed }) => [
              styles.button,
              isPicked ? styles.picked : null,
              locked && !isPicked ? styles.quiet : null,
              pressed ? styles.pressed : null,
            ]}
          >
            {isPicked ? <IconCheck size={17} color={tokens.text} strokeWidth={2.25} /> : null}
            <Text style={styles.label}>{option}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  group: { alignSelf: "stretch", width: "100%", gap: 8, marginTop: 4 },
  button: {
    width: "100%",
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.borderStrong,
    backgroundColor: tokens.surface,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  picked: {
    borderColor: tokens.textSecondary,
    backgroundColor: tokens.fillMuted,
  },
  quiet: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
  label: { color: tokens.text, fontSize: 15, lineHeight: 20, fontWeight: "500", flexShrink: 1 },
});
