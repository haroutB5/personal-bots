import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ThreadId } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { chatNameClash, isChatNameTakenFailure } from "@hbots/personal-client/feed/chatNames";
import {
  RENAME_CHAT_MAX_CHARS,
  renameChatDraftTitle,
} from "@hbots/personal-client/feed/renameChat";
import { chatNameTakenMessage } from "@t3tools/contracts";

import type { ChatEnvironment } from "../chat/chatEnvironment";
import type { NativePersonal } from "../personal/nativePersonalClient";
import { tokens } from "../shell/tokens";
import { SheetShell } from "./SheetShell";

export function RenameChatSheet({
  native,
  chat,
  visible,
  threadId,
  initialTitle,
  takenTitles,
  onClose,
  onSaved,
}: {
  readonly native: NativePersonal;
  readonly chat: ChatEnvironment;
  readonly visible: boolean;
  readonly threadId: string;
  readonly initialTitle: string;
  readonly takenTitles: ReadonlyArray<string>;
  readonly onClose: () => void;
  readonly onSaved: (title: string) => void;
}) {
  const [draft, setDraft] = useState(initialTitle);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const updateMetadata = native.client.useAtomCommand(chat.thread.updateMetadata, {
    reportFailure: false,
  });

  useEffect(() => {
    if (!visible) return;
    // eslint-disable-next-line react/set-state-in-effect -- opening the sheet seeds its draft
    setDraft(initialTitle);
    setSaving(false);
    setError(null);
  }, [initialTitle, visible]);

  const title = renameChatDraftTitle(draft, initialTitle);
  const clash = title === null ? null : chatNameClash(title, takenTitles);
  const problem = clash ?? error;

  const save = async () => {
    if (title === null || clash !== null || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await updateMetadata({
        environmentId: native.environmentId,
        input: { threadId: ThreadId.make(threadId), title },
      });
      if (result._tag === "Success") {
        onSaved(title);
        onClose();
        return;
      }
      setError(
        isChatNameTakenFailure(result)
          ? chatNameTakenMessage(title)
          : squashAtomCommandFailure(result) instanceof Error
            ? (squashAtomCommandFailure(result) as Error).message
            : "Couldn't rename this chat. Try again.",
      );
    } catch {
      setError("Couldn't rename this chat. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SheetShell inline visible={visible} title="Rename chat" onClose={onClose}>
      <View style={styles.body}>
        <TextInput
          value={draft}
          onChangeText={(next) => {
            setDraft(next);
            setError(null);
          }}
          maxLength={RENAME_CHAT_MAX_CHARS}
          autoFocus
          placeholder="Chat title"
          placeholderTextColor={tokens.textSecondary}
          accessibilityLabel="Chat title"
          autoComplete="off"
          selectTextOnFocus
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
            onPress={() => void save()}
            disabled={title === null || clash !== null || saving}
            accessibilityRole="button"
            accessibilityState={{ disabled: title === null || clash !== null || saving }}
            style={[
              styles.button,
              styles.primary,
              title === null || clash !== null || saving ? styles.disabled : null,
            ]}
          >
            <Text style={styles.primaryText} maxFontSizeMultiplier={1.6}>
              {saving ? "Saving…" : "Save"}
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
