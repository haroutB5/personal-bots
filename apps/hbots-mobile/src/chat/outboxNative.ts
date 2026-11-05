import {
  CommandId,
  MessageId,
  ThreadId,
  withPersonalFollowUp,
  personalReplyContext,
  type ChatAttachment,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { runAttachmentUploadCycle } from "@t3tools/client-runtime/state/attachments";
import {
  configureOutbox,
  useOutboxSnapshot,
  type OutboxEntry,
} from "@hbots/personal-client/composer/outbox";
import {
  configureOutboxBlobs,
  deleteOutboxBlobs,
  getOutboxBlob,
  sweepOutboxBlobs,
} from "@hbots/personal-client/composer/outboxBlobs";
import {
  classifySendFailure,
  createOutboxFlusher,
  type SendOutcome,
} from "@hbots/personal-client/composer/outboxFlush";
import type { NativeBlob } from "../platform/nativePorts";
import { appAtomRegistry } from "../personal/atomRegistry";
import type { NativePersonal } from "../personal/nativePersonalClient";
import type { ChatEnvironment } from "./chatEnvironment";
import { useEffect, useRef } from "react";

export function configureNativeOutbox(native: NativePersonal): void {
  configureOutbox({ store: native.client.ports.kv, ids: native.client.ports.ids });
  configureOutboxBlobs(native.client.ports.blobs);
}

async function uploadFile(
  uri: string,
  url: string,
  mimeType: string,
  signal: AbortSignal,
): Promise<void> {
  const { File, UploadType } = await import("expo-file-system");
  if (signal.aborted) throw new Error("Upload cancelled.");
  const file = new File(uri);
  const result = await file.upload(url, {
    httpMethod: "POST",
    uploadType: UploadType.BINARY_CONTENT,
    headers: { "Content-Type": mimeType },
    signal,
  });
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`Upload rejected (${result.status})`);
  }
}

export interface DraftAttachment {
  readonly id: string;
  readonly kind: "image" | "file";
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly uri: string;
}

async function uploadOne(
  native: NativePersonal,
  chat: ChatEnvironment,
  meta: {
    readonly name: string;
    readonly mimeType: string;
    readonly sizeBytes: number;
    readonly kind: "image" | "file";
  },
  uri: string,
): Promise<ChatAttachment | null> {
  const controller = new AbortController();
  const result = await runAttachmentUploadCycle({
    registry: appAtomRegistry,
    createUploadUrl: chat.attachments.createUploadUrl,
    remove: chat.attachments.remove,
    environmentId: native.environmentId,
    upload:
      meta.kind === "file"
        ? {
            type: "file" as const,
            name: meta.name,
            mimeType: meta.mimeType,
            sizeBytes: meta.sizeBytes,
          }
        : ({
            type: "image" as const,
            name: meta.name,
            mimeType: meta.mimeType,
            sizeBytes: meta.sizeBytes,
          } as never),
    resolveUploadUrl: (relativeUrl) => new URL(relativeUrl, native.httpBaseUrl).toString(),
    transport: (url) => ({
      done: uploadFile(uri, url, meta.mimeType, controller.signal),
      abort: () => controller.abort(),
    }),
  });
  if (result.status !== "uploaded") return null;
  return {
    type: meta.kind,
    id: result.attachmentId,
    name: meta.name,
    mimeType: meta.mimeType,
    sizeBytes: meta.sizeBytes,
  } as ChatAttachment;
}

export async function uploadDraftAttachments(
  native: NativePersonal,
  chat: ChatEnvironment,
  attachments: ReadonlyArray<DraftAttachment>,
): Promise<ReadonlyArray<ChatAttachment> | null> {
  const uploaded: ChatAttachment[] = [];
  for (const attachment of attachments) {
    const next = await uploadOne(native, chat, attachment, attachment.uri);
    if (next === null) return null;
    uploaded.push(next);
  }
  return uploaded;
}

async function uploadEntryAttachments(
  native: NativePersonal,
  chat: ChatEnvironment,
  entry: OutboxEntry,
): Promise<ReadonlyArray<ChatAttachment> | null> {
  const uploaded: ChatAttachment[] = [];
  for (const meta of entry.attachments) {
    const blob = await getOutboxBlob<NativeBlob>(entry.id, meta.id);
    if (blob === null) return null;
    const next = await uploadOne(native, chat, meta, blob.uri);
    if (next === null) return null;
    uploaded.push(next);
  }
  return uploaded;
}

/**
 * Sends the queued messages for this laptop: per chat, in the order they were
 * typed, exactly once. Mounted in the shell so a message goes out whichever
 * screen is open, and after a relaunch with the queue still on the device.
 */
export function useNativeOutboxFlusher(native: NativePersonal, chat: ChatEnvironment): void {
  const connection = native.useConnectionState();
  const { entries } = useOutboxSnapshot();
  const startTurn = native.client.useAtomCommand(chat.thread.startTurn, {
    reportFailure: false,
  });
  const connected = connection.phase === "connected";
  const startTurnRef = useRef(startTurn);

  const sendEntry = async (entry: OutboxEntry): Promise<SendOutcome> => {
    if (entry.turn === null) {
      return { kind: "rejected", message: "Couldn't send: this message is damaged. Cancel it." };
    }
    let attachments: ReadonlyArray<ChatAttachment> = [];
    if (entry.attachments.length > 0) {
      const uploaded = await uploadEntryAttachments(native, chat, entry);
      if (uploaded === null) {
        // The upload queue already retried a transient failure. A remaining
        // failure is the server's answer, so it waits for Retry, not a trigger.
        return native.readConnection().connected
          ? { kind: "rejected", message: "Couldn't send: an attachment didn't upload. Try again." }
          : { kind: "not-sent" };
      }
      attachments = uploaded;
    }
    try {
      const context = withPersonalFollowUp(
        entry.replyTo !== null ? personalReplyContext(entry.replyTo) : null,
        entry.turn.followUp ?? undefined,
      );
      const result = await startTurnRef.current({
        environmentId: native.environmentId,
        input: {
          commandId: CommandId.make(entry.commandId),
          threadId: ThreadId.make(entry.threadId),
          message: {
            messageId: MessageId.make(entry.id),
            role: "user",
            text: entry.sendText,
            attachments,
            ...(context !== null ? { context } : {}),
          },
          modelSelection: entry.turn.modelSelection,
          ...(entry.turn.titleSeed !== null ? { titleSeed: entry.turn.titleSeed } : {}),
          runtimeMode: entry.turn.runtimeMode,
          interactionMode: entry.turn.interactionMode,
          ...(entry.turn.followUp === "steer" || entry.turn.followUp === "queue"
            ? { followUp: entry.turn.followUp }
            : {}),
          createdAt: entry.createdAt,
        },
      });
      if (result._tag === "Success") {
        void deleteOutboxBlobs(entry.id);
        return { kind: "sent" };
      }
      return classifySendFailure(squashAtomCommandFailure(result));
    } catch {
      return { kind: "unknown" };
    }
  };

  const sendEntryRef = useRef(sendEntry);
  useEffect(() => {
    startTurnRef.current = startTurn;
    sendEntryRef.current = sendEntry;
  });

  const flusherRef = useRef<ReturnType<typeof createOutboxFlusher> | null>(null);
  useEffect(() => {
    const flusher = createOutboxFlusher({
      environmentId: native.environmentId,
      isConnected: () => native.readConnection().connected,
      connectionGeneration: () => native.readConnection().generation,
      send: (entry) => sendEntryRef.current(entry),
    });
    flusherRef.current = flusher;
    return () => {
      flusher.dispose();
      flusherRef.current = null;
    };
  }, [native.environmentId]);

  // A new message starts a pass, and a connection change wakes it, including
  // the offline edge: the flusher needs the drop to tell a real reconnect from
  // a queue change. A failed entry waits for Retry or a new connection.
  const queueKey = entries
    .filter((entry) => entry.environmentId === native.environmentId)
    .map((entry) => `${entry.id}:${entry.status}`)
    .join("|");
  useEffect(() => {
    if (queueKey.length === 0) return;
    flusherRef.current?.trigger();
  }, [connected, queueKey]);

  const idsKey = entries.map((entry) => entry.id).join("|");
  const sweptRef = useRef(false);
  useEffect(() => {
    if (sweptRef.current || !connected) return;
    sweptRef.current = true;
    void sweepOutboxBlobs(new Set(idsKey.length === 0 ? [] : idsKey.split("|"))).then(
      (complete) => {
        if (!complete) sweptRef.current = false;
      },
    );
  }, [connected, idsKey]);
}
