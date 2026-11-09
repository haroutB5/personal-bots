import {
  CommandId,
  MessageId,
  ThreadId,
  botEffectiveModelSelection,
  botTakesVoiceCalls,
  personalReplyContext,
  withPersonalFollowUp,
  type ChatAttachment,
  type PersonalBot,
  type PersonalReplyQuote,
} from "@t3tools/contracts";
import type { ThreadTurnFollowUp } from "@hbots/personal-client/conversation/wireTypes";
import type { ChatThread } from "@hbots/personal-client/conversation/chatThread";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import {
  enqueueOutboxEntry,
  hasOutboxForThread,
  newOutboxId,
  outboxCommandId,
  type OutboxEntry,
} from "@hbots/personal-client/composer/outbox";
import { putOutboxBlobs, deleteOutboxBlobs } from "@hbots/personal-client/composer/outboxBlobs";
import { classifySendFailure } from "@hbots/personal-client/composer/outboxFlush";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@hbots/personal-client/feed/composerText";
import type { PendingOutgoingMessage } from "@hbots/personal-client/feed/types";
import {
  IconArrowUp,
  IconFile,
  IconPhone,
  IconPlus,
  IconSquare,
  IconX,
} from "@tabler/icons-react-native";
import { useEffect, useRef, useState } from "react";
import { Image, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import type { ChatEnvironment } from "./chatEnvironment";
import { uploadDraftAttachments, type DraftAttachment } from "./outboxNative";
import type { NativePersonal } from "../personal/nativePersonalClient";
import { tokens } from "../shell/tokens";
import { attachmentName } from "./attachmentName";
import { SheetAction, SheetCancel, SheetShell } from "../sheets/SheetShell";

const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const DRAFT_DEBOUNCE_MS = 400;
const MAX_TITLE_SEED = 80;

function draftKey(environmentId: string, threadId: string): string {
  return `t3code:composer-draft:v1:${environmentId}:${threadId}`;
}

function titleSeedFor(text: string, attachments: ReadonlyArray<DraftAttachment>): string {
  const seed =
    text.trim().length > 0
      ? text.trim()
      : attachments[0] === undefined
        ? "New chat"
        : `${attachments[0].kind === "image" ? "Image" : "File"}: ${attachments[0].name}`;
  return seed.slice(0, MAX_TITLE_SEED);
}

function sizeOf(uri: string, fallback: number): number {
  if (fallback > 0) return fallback;
  try {
    return new File(uri).size ?? 0;
  } catch {
    return 0;
  }
}

/** Sends a plain message without touching the draft; used by tap-to-answer choices. */
export interface ComposerControl {
  readonly sendText: (text: string) => Promise<boolean>;
}

export function Composer({
  native,
  chat,
  thread,
  threadId,
  bot,
  botName,
  working,
  replyTo,
  onClearReply,
  onPendingChange,
  onSendError,
  onInterrupt,
  onSent,
  control,
}: {
  readonly native: NativePersonal;
  readonly chat: ChatEnvironment;
  readonly thread: ChatThread;
  readonly threadId: string;
  readonly bot: PersonalBot | null;
  readonly botName: string;
  readonly working: boolean;
  readonly replyTo: PersonalReplyQuote | null;
  readonly onClearReply: () => void;
  readonly onPendingChange: (
    update: (
      pending: ReadonlyArray<PendingOutgoingMessage>,
    ) => ReadonlyArray<PendingOutgoingMessage>,
  ) => void;
  readonly onSendError: (message: string | null) => void;
  readonly onInterrupt: () => Promise<void>;
  readonly onSent: () => void;
  readonly control?: { current: ComposerControl | null } | undefined;
}) {
  const key = draftKey(native.environmentId, threadId);
  const [text, setText] = useState(() => native.client.ports.kv.getItem(key) ?? "");
  const [attachments, setAttachments] = useState<ReadonlyArray<DraftAttachment>>([]);
  const [sending, setSending] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [sendMenuOpen, setSendMenuOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewAttachment, setPreviewAttachment] = useState<DraftAttachment | null>(null);
  const connection = native.useConnectionState();
  const startTurn = native.client.useAtomCommand(chat.thread.startTurn, {
    reportFailure: false,
  });
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const offline = connection.phase !== "connected";

  useEffect(() => {
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      if (text.length === 0) native.client.ports.kv.removeItem(key);
      else native.client.ports.kv.setItem(key, text);
    }, DRAFT_DEBOUNCE_MS);
    return () => {
      if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    };
  }, [key, native, text]);

  const hasContent = text.trim().length > 0 || attachments.length > 0;
  const showStop = working && !hasContent;
  const canSend = hasContent && !sending && !preparing;

  const addPicked = (next: ReadonlyArray<DraftAttachment>) => {
    setAttachments((current) => {
      const room = MAX_ATTACHMENTS - current.length;
      const accepted = next.slice(0, Math.max(0, room));
      const tooBig = accepted.filter((attachment) => attachment.sizeBytes > MAX_ATTACHMENT_BYTES);
      if (tooBig.length > 0) {
        setError(`Files must be 25 MB or less: ${tooBig.map((item) => item.name).join(", ")}`);
        return current;
      }
      return [...current, ...accepted.filter((attachment) => !tooBig.includes(attachment))];
    });
  };

  const pickPhotos = async () => {
    setAttachOpen(false);
    setPicking(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsMultipleSelection: true,
        selectionLimit: MAX_ATTACHMENTS,
        quality: 1,
      });
      if (result.canceled) return;
      addPicked(
        result.assets.map((asset, index) => {
          const uri = asset.uri;
          const name = attachmentName({
            fileName: asset.fileName,
            camera: false,
            index,
          });
          return {
            id: `${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
            kind: "image",
            name,
            mimeType: asset.mimeType ?? "image/jpeg",
            sizeBytes: sizeOf(uri, asset.fileSize ?? 0),
            uri,
          };
        }),
      );
    } catch {
      setError("Couldn't open the photo picker.");
    } finally {
      setPicking(false);
    }
  };

  const pickCamera = async () => {
    setAttachOpen(false);
    setPicking(true);
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        setError("Camera access is off for hbots.");
        return;
      }
      const result = await ImagePicker.launchCameraAsync({ quality: 1 });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (asset === undefined) return;
      addPicked([
        {
          id: `${Date.now()}-camera`,
          kind: "image",
          name: attachmentName({
            fileName: null,
            camera: true,
            index: 0,
          }),
          mimeType: asset.mimeType ?? "image/jpeg",
          sizeBytes: sizeOf(asset.uri, asset.fileSize ?? 0),
          uri: asset.uri,
        },
      ]);
    } catch {
      setError("Couldn't open the camera.");
    } finally {
      setPicking(false);
    }
  };

  const pickFiles = async () => {
    setAttachOpen(false);
    setPicking(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      addPicked(
        result.assets.map((asset, index) => {
          const name = asset.name ?? `File ${index + 1}`;
          const mimeType = asset.mimeType ?? "application/octet-stream";
          return {
            id: `${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
            kind: mimeType.startsWith("image/") ? "image" : "file",
            name,
            mimeType,
            sizeBytes: sizeOf(asset.uri, asset.size ?? 0),
            uri: asset.uri,
          };
        }),
      );
    } catch {
      setError("Couldn't open the file picker.");
    } finally {
      setPicking(false);
    }
  };

  const storeBlobs = async (
    messageId: string,
    snapshot: ReadonlyArray<DraftAttachment>,
  ): Promise<boolean> => {
    if (snapshot.length === 0) return true;
    try {
      await putOutboxBlobs(
        messageId,
        snapshot.map((attachment) => ({
          id: attachment.id,
          blob: {
            uri: attachment.uri,
            size: attachment.sizeBytes,
            mimeType: attachment.mimeType,
            name: attachment.name,
          },
        })),
      );
      return true;
    } catch {
      return false;
    }
  };

  const clearDraft = () => {
    setText("");
    setAttachments([]);
    native.client.ports.kv.removeItem(key);
    onClearReply();
  };

  const queue = async (
    messageId: string,
    textValue: string,
    createdAt: string,
    followUp: ThreadTurnFollowUp | null,
    snapshot: ReadonlyArray<DraftAttachment>,
    quote: PersonalReplyQuote | null,
  ): Promise<boolean> => {
    try {
      const stored = await storeBlobs(messageId, snapshot);
      if (!stored) {
        setError("Couldn't save those photos on this device. Your draft is still here.");
        return false;
      }
      const entry: OutboxEntry | null = enqueueOutboxEntry({
        id: messageId,
        commandId: outboxCommandId(messageId),
        kind: "turn",
        environmentId: native.environmentId,
        threadId,
        groupId: null,
        text: textValue,
        sendText: textValue || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
        createdAt,
        replyTo: quote,
        turn: {
          modelSelection: bot === null ? thread.modelSelection : botEffectiveModelSelection(bot),
          titleSeed: titleSeedFor(textValue, snapshot),
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          followUp,
        },
        attachments: snapshot.map((attachment) => ({
          id: attachment.id,
          kind: attachment.kind,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
        })),
      });
      if (entry === null) {
        void deleteOutboxBlobs(messageId);
        setError("Couldn't save that message on this device. Your draft is still here.");
        return false;
      }
      clearDraft();
      onSent();
      return true;
    } catch (cause) {
      console.warn("outbox queue failed", cause);
      setError("Couldn't queue that message. Your draft is still here.");
      return false;
    }
  };

  const sendingRef = useRef(false);

  const submit = async ({
    textValue,
    snapshot,
    followUp,
    quote,
    clearDraftAfter,
  }: {
    readonly textValue: string;
    readonly snapshot: ReadonlyArray<DraftAttachment>;
    readonly followUp: ThreadTurnFollowUp | undefined;
    readonly quote: PersonalReplyQuote | null;
    readonly clearDraftAfter: boolean;
  }): Promise<boolean> => {
    if (sendingRef.current) return false;
    sendingRef.current = true;
    const messageId = newOutboxId();
    const createdAt = new Date().toISOString();
    setSending(true);
    setError(null);
    onSendError(null);
    try {
      if (snapshot.length > 0) {
        const stored = await storeBlobs(messageId, snapshot);
        if (!stored) {
          setError("Couldn't save those photos on this device. Your draft is still here.");
          return false;
        }
      }
      if (offline || hasOutboxForThread(threadId)) {
        const queued = await queue(
          messageId,
          textValue,
          createdAt,
          followUp ?? null,
          snapshot,
          quote,
        );
        if (!queued) return false;
        if (clearDraftAfter) setText("");
        return true;
      }
      let uploaded: ReadonlyArray<ChatAttachment> = [];
      if (snapshot.length > 0) {
        setPreparing(true);
        uploaded = (await uploadDraftAttachments(native, chat, snapshot)) ?? [];
        setPreparing(false);
        if (uploaded.length !== snapshot.length) {
          setError("An attachment didn't upload. Remove it or try again.");
          void deleteOutboxBlobs(messageId);
          return false;
        }
      }
      const turn = {
        modelSelection: bot === null ? thread.modelSelection : botEffectiveModelSelection(bot),
        titleSeed: titleSeedFor(textValue, snapshot),
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        followUp: followUp ?? null,
      };
      const context = withPersonalFollowUp(
        quote !== null ? personalReplyContext(quote) : null,
        followUp,
      );
      onPendingChange((pending) => [
        ...pending,
        {
          id: messageId,
          threadId,
          text: textValue || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
          createdAt,
          attachments: snapshot.map((attachment) => ({
            id: attachment.id,
            name: attachment.name,
          })),
          ...(quote !== null ? { replyTo: quote } : {}),
        },
      ]);
      try {
        const result = await startTurn({
          environmentId: native.environmentId,
          input: {
            commandId: CommandId.make(outboxCommandId(messageId)),
            threadId: ThreadId.make(threadId),
            message: {
              messageId: MessageId.make(messageId),
              role: "user",
              text: textValue || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
              attachments: uploaded,
              ...(context !== null ? { context } : {}),
            },
            modelSelection: turn.modelSelection,
            titleSeed: turn.titleSeed,
            runtimeMode: turn.runtimeMode,
            interactionMode: turn.interactionMode,
            ...(followUp !== undefined ? { followUp } : {}),
            createdAt,
          },
        });
        onPendingChange((pending) => pending.filter((message) => message.id !== messageId));
        if (result._tag === "Success") {
          if (clearDraftAfter) clearDraft();
          void deleteOutboxBlobs(messageId);
          onSent();
          return true;
        }
        const outcome = classifySendFailure(squashAtomCommandFailure(result));
        if (outcome.kind === "rejected") {
          setError(outcome.message);
          void deleteOutboxBlobs(messageId);
          return false;
        }
        const queued = await queue(
          messageId,
          textValue,
          createdAt,
          followUp ?? null,
          snapshot,
          quote,
        );
        if (!queued) return false;
        onPendingChange((pending) => pending.filter((message) => message.id !== messageId));
        if (clearDraftAfter) setText("");
        return true;
      } catch {
        const queued = await queue(
          messageId,
          textValue,
          createdAt,
          followUp ?? null,
          snapshot,
          quote,
        );
        if (!queued) return false;
        onPendingChange((pending) => pending.filter((message) => message.id !== messageId));
        if (clearDraftAfter) setText("");
        return true;
      }
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const send = async (followUp?: ThreadTurnFollowUp) => {
    if (!canSend || sending) return;
    await submit({
      textValue: text.trim(),
      snapshot: attachments,
      followUp,
      quote: replyTo,
      clearDraftAfter: true,
    });
  };

  const sendChoice = async (option: string): Promise<boolean> => {
    if (sending || preparing) return false;
    return submit({
      textValue: option,
      snapshot: [],
      followUp: undefined,
      quote: null,
      clearDraftAfter: false,
    });
  };

  useEffect(() => {
    if (control === undefined) return;
    // eslint-disable-next-line react/immutability -- the chat screen owns this ref for choice sends
    control.current = { sendText: sendChoice };
    return () => {
      if (control.current?.sendText === sendChoice) control.current = null;
    };
  });

  const stop = async () => {
    await onInterrupt();
  };

  const attachmentCount = attachments.length;
  const placeholder = botName.length > 0 ? `Message ${botName}…` : "Message…";

  return (
    <View style={styles.root}>
      {error !== null ? (
        <Pressable onPress={() => setError(null)} accessibilityRole="alert" style={styles.error}>
          <Text style={styles.errorText}>{error}</Text>
        </Pressable>
      ) : null}
      {replyTo !== null ? (
        <View style={styles.replyBar}>
          <View style={styles.replyBody}>
            <Text style={styles.replyName} numberOfLines={1}>
              {replyTo.name}
            </Text>
            <Text style={styles.replyExcerpt} numberOfLines={1}>
              {replyTo.excerpt}
            </Text>
          </View>
          <Pressable
            onPress={onClearReply}
            accessibilityRole="button"
            accessibilityLabel="Cancel reply"
            style={styles.replyClose}
          >
            <IconX size={18} color={tokens.textSecondary} strokeWidth={2} />
          </Pressable>
        </View>
      ) : null}
      {attachments.length > 0 ? (
        <View style={styles.tray}>
          {attachments.map((attachment, index) => (
            <View key={attachment.id} style={styles.thumb}>
              <Pressable
                onPress={() => setPreviewAttachment(attachment)}
                accessibilityRole="button"
                accessibilityLabel={`Preview ${attachment.name}`}
                style={styles.thumbBody}
              >
                {attachment.kind === "image" ? (
                  <Image source={{ uri: attachment.uri }} style={styles.thumbImage} />
                ) : (
                  <IconFile size={20} color={tokens.textSecondary} strokeWidth={1.75} />
                )}
              </Pressable>
              <Pressable
                onPress={() =>
                  setAttachments((current) => current.filter((item) => item.id !== attachment.id))
                }
                accessibilityRole="button"
                accessibilityLabel={`Remove ${attachment.name}, ${index + 1} of ${attachmentCount}`}
                style={styles.thumbRemove}
              >
                <IconX size={12} color={tokens.text} strokeWidth={2.5} />
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
      <View style={styles.row}>
        <Pressable
          onPress={() => setAttachOpen(true)}
          disabled={picking || sending || preparing}
          accessibilityRole="button"
          accessibilityLabel="Add photos, camera or files"
          style={styles.roundButton}
        >
          <IconPlus size={22} color={tokens.text} strokeWidth={1.75} />
        </Pressable>
        <View style={styles.fieldBox}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder={placeholder}
            placeholderTextColor={tokens.textSecondary}
            accessibilityLabel={placeholder}
            multiline
            maxFontSizeMultiplier={1.6}
            style={styles.field}
          />
          {bot !== null && botTakesVoiceCalls(bot) ? (
            <Pressable
              onPress={() => onSendError("Voice calls arrive with the voice update.")}
              accessibilityRole="button"
              accessibilityLabel={`Call ${botName}`}
              style={styles.callButton}
            >
              <IconPhone size={19} color={tokens.textSecondary} strokeWidth={1.75} />
            </Pressable>
          ) : null}
        </View>
        {showStop ? (
          <Pressable
            onPress={() => void stop()}
            accessibilityRole="button"
            accessibilityLabel="Stop"
            style={[styles.sendButton, styles.stopButton]}
          >
            <IconSquare
              size={18}
              color={tokens.primaryText}
              strokeWidth={0}
              fill={tokens.primaryText}
            />
          </Pressable>
        ) : (
          <Pressable
            onPress={() => void send()}
            onLongPress={() => {
              if (canSend && working) setSendMenuOpen(true);
            }}
            delayLongPress={350}
            disabled={!canSend}
            accessibilityRole="button"
            accessibilityLabel={offline ? "Send, waits here until your laptop reconnects" : "Send"}
            style={[styles.sendButton, !canSend ? styles.disabled : null]}
          >
            <IconArrowUp size={21} color={tokens.primaryText} strokeWidth={2.5} />
          </Pressable>
        )}
      </View>
      {offline ? (
        <Text style={styles.offline}>
          Offline. Your draft is saved and sends when the laptop is back.
        </Text>
      ) : null}
      <SheetShell visible={attachOpen} title="Attach" onClose={() => setAttachOpen(false)}>
        <SheetAction
          label="Photos"
          detail="From your photo library"
          onPress={() => void pickPhotos()}
        />
        <SheetAction label="Camera" detail="Take a photo" onPress={() => void pickCamera()} />
        <SheetAction
          label="Files"
          detail="Documents and anything else"
          onPress={() => void pickFiles()}
        />
        <SheetCancel onPress={() => setAttachOpen(false)} />
      </SheetShell>
      <SheetShell
        visible={previewAttachment !== null}
        title={previewAttachment?.name ?? "Attachment"}
        onClose={() => setPreviewAttachment(null)}
      >
        {previewAttachment?.kind === "image" ? (
          <Image
            source={{ uri: previewAttachment.uri }}
            style={styles.previewImage}
            resizeMode="contain"
            accessibilityLabel={previewAttachment.name}
          />
        ) : (
          <Text style={styles.previewFile}>{previewAttachment?.name ?? ""}</Text>
        )}
      </SheetShell>
      <SheetShell visible={sendMenuOpen} title="Send" onClose={() => setSendMenuOpen(false)}>
        <SheetAction
          label="Send now"
          onPress={() => {
            setSendMenuOpen(false);
            void send();
          }}
        />
        <SheetAction
          label="Queue after this turn"
          onPress={() => {
            setSendMenuOpen(false);
            void send("queue");
          }}
        />
        <SheetCancel onPress={() => setSendMenuOpen(false)} />
      </SheetShell>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: tokens.border,
    backgroundColor: tokens.bg,
    paddingHorizontal: 12,
    paddingTop: 8,
    gap: 6,
  },
  row: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  roundButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: tokens.fillMuted,
  },
  fieldBox: {
    flex: 1,
    minHeight: 44,
    maxHeight: 132,
    borderRadius: 22,
    backgroundColor: tokens.fillMuted,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 14,
    paddingRight: 4,
  },
  field: { flex: 1, color: tokens.text, fontSize: 16, lineHeight: 22, paddingVertical: 10 },
  callButton: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: tokens.primary,
  },
  stopButton: { backgroundColor: tokens.primary },
  disabled: { opacity: 0.35 },
  error: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.dangerBorder,
    backgroundColor: tokens.dangerBg,
    padding: 9,
  },
  errorText: { color: tokens.danger, fontSize: 13, lineHeight: 18 },
  replyBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 10,
    backgroundColor: tokens.surface,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  replyBody: { flex: 1, borderLeftWidth: 2, borderLeftColor: tokens.borderStrong, paddingLeft: 8 },
  replyName: { color: tokens.text, fontSize: 12, fontWeight: "600" },
  replyExcerpt: { color: tokens.textSecondary, fontSize: 12, lineHeight: 16 },
  replyClose: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  tray: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: 12,
    backgroundColor: tokens.fillMuted,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  thumbBody: { width: "100%", height: "100%", alignItems: "center", justifyContent: "center" },
  thumbImage: { width: "100%", height: "100%" },
  thumbRemove: {
    position: "absolute",
    top: 2,
    right: 2,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: "rgba(0,0,0,0.6)",
    alignItems: "center",
    justifyContent: "center",
  },
  offline: { color: tokens.textSecondary, fontSize: 12, lineHeight: 16, paddingBottom: 4 },
  previewImage: { width: "100%", height: 420, borderRadius: 12, backgroundColor: tokens.bg },
  previewFile: { color: tokens.text, fontSize: 15, paddingVertical: 24, textAlign: "center" },
});
