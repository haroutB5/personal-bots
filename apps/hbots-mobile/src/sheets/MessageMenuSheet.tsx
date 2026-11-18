import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import { StyleSheet, Text } from "react-native";

import type { TextHit } from "../chat/readerDoc";
import { tokens } from "../shell/tokens";
import { MessageReader } from "./MessageReader";
import { SheetAction, SheetCancel, SheetShell } from "./SheetShell";

export interface MessageMenuTarget {
  readonly messageId: string;
  readonly name: string;
  readonly text: string;
  readonly sentAt: Date | null;
  /** True when the reply was still growing as the menu opened. */
  readonly streaming: boolean;
}

/** A selection hit exists only in select mode: a menu with a preselected word cannot be built. */
export type MessageSheetRequest =
  | { readonly kind: "menu"; readonly message: MessageMenuTarget }
  | { readonly kind: "select"; readonly message: MessageMenuTarget; readonly hit: TextHit | null };

export function MessageMenuSheet({
  request,
  onRequest,
  onClose,
  onReply,
}: {
  readonly request: MessageSheetRequest | null;
  readonly onRequest: (request: MessageSheetRequest) => void;
  readonly onClose: () => void;
  readonly onReply: (target: MessageMenuTarget) => void;
}) {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const message = request?.message ?? null;
  const copied = message !== null && copiedId === message.messageId;
  const close = () => {
    setCopiedId(null);
    onClose();
  };

  return (
    <>
      <SheetShell visible={request?.kind === "menu"} title="Message" onClose={close}>
        <SheetAction
          label="Reply"
          onPress={() => {
            if (message !== null) {
              onReply(message);
              close();
            }
          }}
        />
        <SheetAction
          label={copied ? "Copied" : "Copy text"}
          onPress={() => {
            if (message === null) return;
            void Clipboard.setStringAsync(message.text).then(() => setCopiedId(message.messageId));
          }}
        />
        <SheetAction
          label="Select text"
          onPress={() => {
            if (message !== null) onRequest({ kind: "select", message, hit: null });
          }}
        />
        {message?.sentAt != null ? (
          <Text style={styles.sentAt}>
            {`Sent ${message.sentAt.toLocaleDateString([], {
              weekday: "long",
              day: "numeric",
              month: "long",
            })}, ${message.sentAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
          </Text>
        ) : null}
        <SheetCancel onPress={close} />
      </SheetShell>
      <SheetShell visible={request?.kind === "select"} title="Select text" onClose={close}>
        <MessageReader text={message?.text ?? ""} />
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
});
