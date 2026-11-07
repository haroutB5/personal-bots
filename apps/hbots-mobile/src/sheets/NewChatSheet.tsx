import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ThreadId } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { chatNameClash } from "@hbots/personal-client/feed/chatNames";
import {
  RENAME_CHAT_MAX_CHARS,
  renameChatDraftTitle,
} from "@hbots/personal-client/feed/renameChat";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { tokens } from "../shell/tokens";
import { SheetShell } from "./SheetShell";

export function NewChatSheet({
  native,
  visible,
  botId,
  botName,
  openChatTitles,
  onClose,
  onCreated,
}: {
  readonly native: NativePersonal;
  readonly visible: boolean;
  readonly botId: string;
  readonly botName: string;
  readonly openChatTitles: ReadonlyArray<string>;
  readonly onClose: () => void;
  readonly onCreated: (threadId: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = native.client.useAtomCommand(native.bots.personalBotCreateThread, {
    reportFailure: false,
  });

  useEffect(() => {
    if (visible) {
      // eslint-disable-next-line react/set-state-in-effect -- opening the sheet resets its draft
      setDraft("");
      setError(null);
      setStarting(false);
    }
  }, [visible]);

  const title = renameChatDraftTitle(draft, "");
  const clash = title === null ? null : chatNameClash(title, openChatTitles);
  const problem = clash ?? error;

  const start = async () => {
    if (starting || clash !== null) return;
    setStarting(true);
    setError(null);
    const threadId = native.client.ports.ids.randomUUID();
    try {
      const result = await create({
        environmentId: native.environmentId,
        input: {
          botId: botId as never,
          threadId: ThreadId.make(threadId),
          ...(title === null ? {} : { title }),
        },
      });
      if (result._tag === "Success") {
        onCreated(threadId);
        onClose();
        return;
      }
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Couldn't start a chat. Try again.");
    } catch {
      setError("Couldn't start a chat. Try again.");
    } finally {
      setStarting(false);
    }
  };

  return (
    <SheetShell inline visible={visible} title={`New chat with ${botName}`} onClose={onClose}>
      <View style={styles.body}>
        <TextInput
          value={draft}
          onChangeText={(next) => {
            setDraft(next);
            setError(null);
          }}
          maxLength={RENAME_CHAT_MAX_CHARS}
          autoFocus
          placeholder="Name (optional)"
          placeholderTextColor={tokens.textSecondary}
          accessibilityLabel="Chat name (optional)"
          autoComplete="off"
          autoCapitalize="sentences"
          maxFontSizeMultiplier={1.6}
          style={styles.input}
        />
        {problem !== null ? (
          <Text style={styles.error} accessibilityRole="alert">
            {problem}
          </Text>
        ) : null}
        <View style={styles.buttons}>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            style={[styles.button, styles.secondary]}
          >
            <Text style={styles.secondaryText} maxFontSizeMultiplier={1.6}>
              Cancel
            </Text>
          </Pressable>
          <Pressable
            onPress={() => void start()}
            disabled={starting || clash !== null}
            accessibilityRole="button"
            accessibilityState={{ disabled: starting || clash !== null }}
            style={[
              styles.button,
              styles.primary,
              starting || clash !== null ? styles.disabled : null,
            ]}
          >
            <Text style={styles.primaryText} maxFontSizeMultiplier={1.6}>
              {starting ? "Starting…" : "Start chat"}
            </Text>
          </Pressable>
        </View>
      </View>
    </SheetShell>
  );
}

const styles = StyleSheet.create({
  body: { padding: 12, gap: 12 },
  input: {
    minHeight: 44,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.bg,
    color: tokens.text,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  error: { color: tokens.error, fontSize: 14, lineHeight: 19 },
  buttons: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
  button: { minHeight: 44, paddingHorizontal: 16, borderRadius: 12, justifyContent: "center" },
  secondary: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.borderStrong,
    backgroundColor: tokens.raised,
  },
  secondaryText: { color: tokens.text, fontSize: 15, fontWeight: "600" },
  primary: { backgroundColor: tokens.primary },
  primaryText: { color: tokens.primaryText, fontSize: 15, fontWeight: "600" },
  disabled: { opacity: 0.4 },
});
