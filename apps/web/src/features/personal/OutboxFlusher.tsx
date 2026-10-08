import { useEffect, useRef } from "react";

import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  type EnvironmentId,
  MessageId,
  PersonalGroupId,
  personalReplyContext,
  ThreadId,
} from "@t3tools/contracts";

import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  releaseDraftAttachment,
  startAttachmentUpload,
} from "~/lib/attachmentUploadQueue";
import type { ComposerFileAttachment, ComposerImageAttachment } from "~/composerDraftStore";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";

import { type OutboxEntry, useOutboxSnapshot } from "./outbox";
import { getOutboxBlob, sweepOutboxBlobs } from "./outboxBlobs";
import { classifySendFailure, createOutboxFlusher, type SendOutcome } from "./outboxFlush";
import { usePersonalConnectionPhase } from "./PersonalOfflineBanner";
import { personalGroupSendMessage } from "./usePersonalGroups";
import { usePersonalEnvironmentId } from "./usePersonalBots";

type DraftAttachment = ComposerImageAttachment | ComposerFileAttachment;

const ATTACHMENT_LOST = "Couldn't send: an attachment is no longer on this device. Cancel it.";

/** Rebuilds the composer attachments of a queued message from the bytes kept on the device. */
async function loadAttachments(entry: OutboxEntry): Promise<DraftAttachment[] | null> {
  const attachments: DraftAttachment[] = [];
  for (const meta of entry.attachments) {
    const blob = await getOutboxBlob(entry.id, meta.id);
    if (blob === null) return null;
    const file = new File([blob], meta.name, { type: meta.mimeType });
    attachments.push(
      meta.kind === "image"
        ? {
            type: "image",
            id: meta.id,
            name: meta.name,
            mimeType: meta.mimeType,
            sizeBytes: meta.sizeBytes,
            previewUrl: URL.createObjectURL(file),
            file,
          }
        : {
            type: "file",
            id: meta.id,
            name: meta.name,
            mimeType: meta.mimeType,
            sizeBytes: meta.sizeBytes,
            file,
          },
    );
  }
  return attachments;
}

function disposeAttachments(attachments: ReadonlyArray<DraftAttachment>, release: boolean): void {
  for (const attachment of attachments) {
    if (release) releaseDraftAttachment(attachment);
    if (attachment.type === "image") URL.revokeObjectURL(attachment.previewUrl);
  }
}

/**
 * Sends the queued messages once the laptop is connected: per chat, in the
 * order they were typed, and exactly once (see `outbox.ts`). Mounted in the
 * shell, so a message goes out whichever screen is open, and after the app was
 * closed and opened again with the queue still on the device.
 */
export function OutboxFlusher(): null {
  const environmentId = usePersonalEnvironmentId();
  const phase = usePersonalConnectionPhase();
  const { entries } = useOutboxSnapshot();
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const groupSend = useAtomCommand(personalGroupSendMessage, { reportFailure: false });

  const connected = phase === "connected" && environmentId !== null;
  const connectedRef = useRef(connected);
  const sendersRef = useRef({ startTurn, groupSend });

  const sendEntry = async (
    targetEnvironment: EnvironmentId,
    entry: OutboxEntry,
  ): Promise<SendOutcome> => {
    const senders = sendersRef.current;
    if (entry.kind === "group") {
      const result = await senders.groupSend({
        environmentId: targetEnvironment,
        input: {
          groupId: PersonalGroupId.make(entry.groupId ?? ""),
          messageId: MessageId.make(entry.id),
          text: entry.sendText,
          ...(entry.replyTo !== null ? { replyTo: entry.replyTo } : {}),
        },
      });
      return result._tag === "Success"
        ? { kind: "sent" }
        : classifySendFailure(squashAtomCommandFailure(result));
    }
    if (entry.turn === null) {
      return { kind: "rejected", message: "Couldn't send: this message is damaged. Cancel it." };
    }
    let draftAttachments: DraftAttachment[] = [];
    let uploaded: ReturnType<typeof getUploadedAttachments> = [];
    if (entry.attachments.length > 0) {
      const loaded = await loadAttachments(entry);
      if (loaded === null) return { kind: "rejected", message: ATTACHMENT_LOST };
      draftAttachments = loaded;
      for (const attachment of draftAttachments) {
        startAttachmentUpload({ environmentId: targetEnvironment, image: attachment });
      }
      await awaitAttachmentUploads(draftAttachments.map((attachment) => attachment.id));
      uploaded = getUploadedAttachments({
        environmentId: targetEnvironment,
        images: draftAttachments,
      });
      if (uploaded === null) {
        disposeAttachments(draftAttachments, false);
        return connectedRef.current
          ? { kind: "unknown", reason: "Couldn't send: an attachment didn't upload. Try again." }
          : { kind: "not-sent" };
      }
    }
    try {
      const result = await senders.startTurn({
        environmentId: targetEnvironment,
        input: {
          // The queue's own id for this message: every attempt sends the same
          // one, and the server answers a repeat from its receipt of the first.
          commandId: CommandId.make(entry.commandId),
          threadId: ThreadId.make(entry.threadId),
          message: {
            messageId: MessageId.make(entry.id),
            role: "user",
            text: entry.sendText,
            attachments: uploaded ?? [],
            ...(entry.replyTo !== null ? { context: personalReplyContext(entry.replyTo) } : {}),
          },
          modelSelection: entry.turn.modelSelection,
          ...(entry.turn.titleSeed !== null ? { titleSeed: entry.turn.titleSeed } : {}),
          runtimeMode: entry.turn.runtimeMode,
          interactionMode: entry.turn.interactionMode,
          createdAt: entry.createdAt,
        },
      });
      if (result._tag === "Success") {
        disposeAttachments(draftAttachments, true);
        return { kind: "sent" };
      }
      disposeAttachments(draftAttachments, false);
      return classifySendFailure(squashAtomCommandFailure(result));
    } catch {
      disposeAttachments(draftAttachments, false);
      return { kind: "unknown" };
    }
  };

  const sendEntryRef = useRef(sendEntry);
  // Declared before the effect that starts a pass, so a pass sees this render's values.
  useEffect(() => {
    connectedRef.current = connected;
    sendersRef.current = { startTurn, groupSend };
    sendEntryRef.current = sendEntry;
  });

  // One flusher per laptop, made in an effect (it reads the refs above only when it runs).
  const flusherRef = useRef<ReturnType<typeof createOutboxFlusher> | null>(null);
  useEffect(() => {
    if (environmentId === null) return;
    const flusher = createOutboxFlusher({
      environmentId,
      isConnected: () => connectedRef.current,
      send: (entry) => sendEntryRef.current(environmentId, entry),
    });
    flusherRef.current = flusher;
    return () => {
      flusher.dispose();
      flusherRef.current = null;
    };
  }, [environmentId]);

  // Anything runnable: waiting entries of this laptop. A new message, or the
  // connection coming back, starts a pass; a failed entry waits for its Retry.
  const runnableKey = entries
    .filter((entry) => entry.environmentId === environmentId && entry.status === "waiting")
    .map((entry) => entry.id)
    .join("|");
  useEffect(() => {
    if (!connected || runnableKey.length === 0) return;
    flusherRef.current?.trigger();
  }, [connected, environmentId, runnableKey]);

  // Bytes of messages that left the queue without their cleanup (a crash).
  const idsKey = entries.map((entry) => entry.id).join("|");
  const sweptRef = useRef(false);
  useEffect(() => {
    if (sweptRef.current || !connected) return;
    sweptRef.current = true;
    void sweepOutboxBlobs(new Set(idsKey.length === 0 ? [] : idsKey.split("|")));
  }, [connected, idsKey]);

  return null;
}
