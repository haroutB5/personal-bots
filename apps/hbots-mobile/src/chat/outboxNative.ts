import {
  CommandId,
  MessageId,
  ThreadId,
  withPersonalFollowUp,
  personalReplyContext,
  type ChatAttachment,
} from "@t3tools/contracts";

const ATTACHMENT_UPLOAD_ENDPOINT_HEADER = "x-hbots-upload-endpoint";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  runAttachmentUploadCycle,
  type AttachmentUploadCycleResult,
} from "@t3tools/client-runtime/state/attachments";
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
import {
  cancelRangeUpload,
  evictConnectionPool,
  rangedUploadAvailable,
  uploadFileNative,
  uploadRangeNative,
} from "../personal/networkReset";
import {
  nextChunk,
  rangeStep,
  usesRangedUpload,
  type RangeAnswer,
  type VideoMeta,
} from "./videoDrafts";
import type { ChatEnvironment } from "./chatEnvironment";
import { useEffect, useRef } from "react";

export function configureNativeOutbox(native: NativePersonal): void {
  configureOutbox({ store: native.client.ports.kv, ids: native.client.ports.ids });
  configureOutboxBlobs(native.client.ports.blobs);
}

/** The upload endpoint answered 4xx or 5xx: the server saw the bytes and said no. */
export class UploadRefusedError extends Error {
  constructor(readonly status: number) {
    super(`Upload rejected (${status})`);
    this.name = "UploadRefusedError";
  }
}

const UPLOAD_REFUSED_MESSAGE = "Couldn't send: an attachment didn't upload. Try again.";

/**
 * What an HTTP answer to an upload means. Only a 4xx/5xx that carries the
 * upload route's marker is the endpoint refusing the bytes; any other answer
 * came from something in between, so the bytes never reached the server.
 */
export function classifyUploadAnswer(
  status: number,
  endpoint: boolean,
): "uploaded" | "refused" | "unreached" {
  if (status >= 200 && status < 300) return "uploaded";
  if (status >= 400 && endpoint) return "refused";
  return "unreached";
}

type FailedUpload = Extract<AttachmentUploadCycleResult, { status: "failed" }>;

/**
 * Only an answer from the upload endpoint is a refusal. A network error, a
 * timeout, a failed mint or an unresolved URL never reached the server, so the
 * queue retries it on the next connection instead of waiting for Retry.
 */
export function failedAttachmentOutcome(result: FailedUpload, connected: boolean): SendOutcome {
  if (result.step === "transfer" && result.error instanceof UploadRefusedError) {
    return { kind: "rejected", message: UPLOAD_REFUSED_MESSAGE };
  }
  return connected ? { kind: "interrupted" } : { kind: "not-sent" };
}

const RANGE_ATTEMPTS = 4;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sends a file in pieces at explicit offsets. A dropped piece is retried, and
 * the server's byte count after a lost answer says where to carry on, so a
 * flaky network costs one piece, not the whole video.
 */
async function uploadRanged(
  uri: string,
  url: string,
  meta: { readonly mimeType: string; readonly sizeBytes: number },
  signal: AbortSignal,
  onProgress: ((sent: number) => void) | undefined,
): Promise<void> {
  const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const onAbort = () => cancelRangeUpload(uploadId);
  signal.addEventListener("abort", onAbort);
  let offset = 0;
  let failures = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new Error("Upload cancelled.");
      const chunk = nextChunk(offset, meta.sizeBytes);
      if (chunk === null) throw new Error("Upload ended without the server's receipt.");
      let answer: RangeAnswer;
      try {
        answer = await uploadRangeNative({
          url: `${url}${url.includes("?") ? "&" : "?"}offset=${chunk.offset}`,
          uri,
          mimeType: meta.mimeType,
          endpointHeader: ATTACHMENT_UPLOAD_ENDPOINT_HEADER,
          offset: chunk.offset,
          length: chunk.length,
          uploadId,
          ...(onProgress === undefined ? {} : { onProgress }),
        });
      } catch (error) {
        if (signal.aborted) throw new Error("Upload cancelled.", { cause: error });
        if (++failures >= RANGE_ATTEMPTS) throw error;
        await pause(1000 * failures);
        continue;
      }
      const step = rangeStep(answer, chunk);
      switch (step.kind) {
        case "done":
          onProgress?.(meta.sizeBytes);
          return;
        case "next":
          if (step.offset > offset) failures = 0;
          offset = step.offset;
          onProgress?.(offset);
          continue;
        case "cancelled":
          throw new Error("Upload cancelled.");
        case "refused":
          throw new UploadRefusedError(step.status);
        case "unreached":
          if (++failures >= RANGE_ATTEMPTS) {
            throw new Error(`Upload did not reach the endpoint (${step.status}).`);
          }
          await pause(1000 * failures);
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function uploadFile(
  uri: string,
  url: string,
  meta: { readonly mimeType: string; readonly sizeBytes: number },
  signal: AbortSignal,
  onProgress?: (sent: number) => void,
): Promise<void> {
  if (signal.aborted) throw new Error("Upload cancelled.");
  if (usesRangedUpload(meta) && rangedUploadAvailable()) {
    return uploadRanged(uri, url, meta, signal, onProgress);
  }
  const mimeType = meta.mimeType;
  const result = await uploadFileNative(url, uri, mimeType, ATTACHMENT_UPLOAD_ENDPOINT_HEADER);
  switch (classifyUploadAnswer(result.status, result.endpoint)) {
    case "uploaded":
      return;
    case "refused":
      throw new UploadRefusedError(result.status);
    case "unreached":
      // A gateway answered, not the upload route. The bytes never reached the
      // server, so the queue retries instead of asking for a Retry.
      throw new Error(`Upload did not reach the endpoint (${result.status}).`);
  }
}

/**
 * A new socket generation means the network under the old uploads is gone.
 * The shared OkHttp pool can still hold a connection bound to it, and the
 * first request after the change waits on that dead socket until its timeout.
 */
let uploadNetworkGeneration: number | null = null;

async function prepareNetworkForUpload(native: NativePersonal): Promise<void> {
  const generation = native.readConnection().generation;
  if (uploadNetworkGeneration === generation) return;
  uploadNetworkGeneration = generation;
  await evictConnectionPool();
}

export interface DraftAttachment {
  readonly id: string;
  readonly kind: "image" | "file";
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly uri: string;
  /** Set for a video: what its composer chip shows. */
  readonly video?: VideoMeta;
}

export interface UploadOptions {
  /** Aborting it cancels the upload in flight. */
  readonly signal?: AbortSignal;
  /** Bytes sent of one attachment, for ranged uploads. */
  readonly onProgress?: (
    attachment: { readonly name: string; readonly sizeBytes: number },
    sent: number,
  ) => void;
}

type AttachmentUpload =
  | { readonly kind: "uploaded"; readonly attachment: ChatAttachment }
  | { readonly kind: "failed"; readonly result: FailedUpload };

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
  options: UploadOptions = {},
): Promise<AttachmentUpload> {
  await prepareNetworkForUpload(native);
  const controller = new AbortController();
  const outer = options.signal;
  if (outer?.aborted) controller.abort();
  outer?.addEventListener("abort", () => controller.abort(), { once: true });
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
      done: uploadFile(
        uri,
        url,
        meta,
        controller.signal,
        options.onProgress === undefined ? undefined : (sent) => options.onProgress?.(meta, sent),
      ),
      abort: () => controller.abort(),
    }),
  });
  if (result.status === "uploaded") {
    return {
      kind: "uploaded",
      attachment: {
        type: meta.kind,
        id: result.attachmentId,
        name: meta.name,
        mimeType: meta.mimeType,
        sizeBytes: meta.sizeBytes,
      } as ChatAttachment,
    };
  }
  if (result.status === "cancelled") {
    return {
      kind: "failed",
      result: {
        status: "failed",
        step: "transfer",
        attachmentId: result.attachmentId,
        error: new Error("Upload cancelled."),
      },
    };
  }
  return { kind: "failed", result };
}

export async function uploadDraftAttachments(
  native: NativePersonal,
  chat: ChatEnvironment,
  attachments: ReadonlyArray<DraftAttachment>,
  options: UploadOptions = {},
): Promise<ReadonlyArray<ChatAttachment> | null> {
  const uploaded: ChatAttachment[] = [];
  for (const attachment of attachments) {
    if (options.signal?.aborted) return null;
    const next = await uploadOne(native, chat, attachment, attachment.uri, options);
    if (next.kind === "failed") return null;
    uploaded.push(next.attachment);
  }
  return uploaded;
}

type AttachmentsUpload =
  | { readonly kind: "uploaded"; readonly attachments: ReadonlyArray<ChatAttachment> }
  | { readonly kind: "failed"; readonly result: FailedUpload };

async function uploadEntryAttachments(
  native: NativePersonal,
  chat: ChatEnvironment,
  entry: OutboxEntry,
): Promise<AttachmentsUpload> {
  const uploaded: ChatAttachment[] = [];
  for (const meta of entry.attachments) {
    const blob = await getOutboxBlob<NativeBlob>(entry.id, meta.id);
    if (blob === null) {
      return {
        kind: "failed",
        result: {
          status: "failed",
          step: "transfer",
          attachmentId: null,
          error: new Error("The attachment's bytes are missing."),
        },
      };
    }
    const next = await uploadOne(native, chat, meta, blob.uri);
    if (next.kind === "failed") return next;
    uploaded.push(next.attachment);
  }
  return { kind: "uploaded", attachments: uploaded };
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
      const upload = await uploadEntryAttachments(native, chat, entry);
      if (upload.kind === "failed") {
        return failedAttachmentOutcome(upload.result, native.readConnection().connected);
      }
      attachments = upload.attachments;
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
          ...(entry.turn.followUp === "queue" ? { dispatchMode: "queue" as const } : {}),
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

  /**
   * A message whose command landed but whose reply was lost is not resent: the
   * laptop's receipt says it is on the transcript, so the queue drops it and
   * the next message in that chat can go. A rejected receipt keeps its reason.
   */
  const flusherRef = useRef<ReturnType<typeof createOutboxFlusher> | null>(null);
  useEffect(() => {
    const flusher = createOutboxFlusher({
      environmentId: native.environmentId,
      // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the flusher reads the live session
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
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the connection generation wakes the same flusher
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
