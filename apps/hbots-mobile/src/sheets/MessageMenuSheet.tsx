import * as Clipboard from "expo-clipboard";
import { useEffect, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";

import { tokens } from "../shell/tokens";
import { SheetAction, SheetCancel, SheetShell } from "./SheetShell";

export interface MessageMenuTarget {
  readonly messageId: string;
  readonly name: string;
  readonly text: string;
  readonly sentAt: Date | null;
}

export function MessageMenuSheet({
  target,
  onClose,
  onReply,
}: {
  readonly target: MessageMenuTarget | null;
  readonly onClose: () => void;
  readonly onReply: (target: MessageMenuTarget) => void;
}) {
  const [selecting, setSelecting] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (target !== null) {
      // eslint-disable-next-line react/set-state-in-effect -- a new target starts a fresh menu
      setSelecting(false);
      setCopied(false);
    }
  }, [target]);

  return (
    <>
      <SheetShell visible={target !== null && !selecting} title="Message" onClose={onClose}>
        <SheetAction
          label="Reply"
          onPress={() => {
            if (target !== null) {
              onReply(target);
              onClose();
            }
          }}
        />
        <SheetAction
          label={copied ? "Copied" : "Copy text"}
          onPress={() => {
            if (target === null) return;
            void Clipboard.setStringAsync(target.text).then(() => setCopied(true));
          }}
        />
        <SheetAction label="Select text" onPress={() => setSelecting(true)} />
        {target?.sentAt != null ? (
          <Text style={styles.sentAt}>
            {`Sent ${target.sentAt.toLocaleDateString([], {
              weekday: "long",
              day: "numeric",
              month: "long",
            })}, ${target.sentAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
          </Text>
        ) : null}
        <SheetCancel onPress={onClose} />
      </SheetShell>
      <SheetShell
        visible={target !== null && selecting}
        title="Select text"
        onClose={() => {
          setSelecting(false);
          onClose();
        }}
      >
        <View style={styles.selectBody}>
          <TextInput
            value={target?.text ?? ""}
            editable={false}
            multiline
            selectTextOnFocus
            accessibilityLabel="Message text"
            style={styles.selectInput}
          />
        </View>
      </SheetShell>
    </>
  );
}

const styles = StyleSheet.create({
  sentAt: {
    color: tokens.textTertiary,
    fontSize: 12,
    lineHeight: 17,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  selectBody: { padding: 12, maxHeight: 460 },
  selectInput: {
    minHeight: 220,
    color: tokens.text,
    fontSize: 15,
    lineHeight: 21,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.bg,
    padding: 12,
    textAlignVertical: "top",
  },
});
