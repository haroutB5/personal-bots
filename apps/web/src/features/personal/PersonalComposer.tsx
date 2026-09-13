import type { ChangeEvent, JSX, KeyboardEvent } from "react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type EnvironmentId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ThreadId,
} from "@t3tools/contracts";
import { truncate } from "@t3tools/shared/String";
import { ArrowUp, FileText, Plus, Square, X } from "lucide-react";

import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "~/components/chat/composerPromptHistory";
import {
  classifyComposerAttachmentFile,
  fileAttachmentStagingLimit,
  normalizeComposerImageFileMimeType,
} from "~/components/chat/composerAttachmentFiles";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  useComposerDraftStore,
  useComposerThreadDraft,
} from "~/composerDraftStore";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  releaseDraftAttachment,
  startAttachmentUpload,
} from "~/lib/attachmentUploadQueue";
import { prepareImageForAttachment } from "~/lib/imageCompression";
import { newMessageId, randomUUID } from "~/lib/utils";
import { useServerConfigs } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import type { Thread } from "~/types";
import { useAtomCommand } from "~/state/use-atom-command";

import type { PendingOutgoingMessage } from "./MessageList";

const LINE_HEIGHT_PX = 22;
const MAX_LINES = 5;
const ROUND_BUTTON =
  "flex size-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--personal-bg)]";

function resizeTextarea(textarea: HTMLTextAreaElement | null, value: string): void {
  if (textarea === null) return;
  const max = LINE_HEIGHT_PX * MAX_LINES + 20;
  textarea.style.height = "auto";
  // An empty draft is always one line; skip the layout read.
  const height = value.length === 0 ? LINE_HEIGHT_PX + 22 : Math.min(textarea.scrollHeight, max);
  textarea.style.height = `${height}px`;
  textarea.style.overflowY = value.length > 0 && textarea.scrollHeight > max ? "auto" : "hidden";
}

function isCoarsePointer(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
}

/**
 * Composer (ui-spec Screen 2): "+" attachments, a 16px auto-growing input and
 * a black send button that becomes Stop while a turn runs. Draft text and
 * attachments live in the shared composer draft store under this thread, so
 * they survive navigation and reloads exactly like the upstream composer.
 * Sending reuses the upstream upload queue and `thread.turn.start` with a
 * client message id. There is no mic: dictation comes from the OS keyboard.
 */
export function PersonalComposer({
  environmentId,
  threadId,
  thread,
  botName,
  disabledReason,
  working,
  canInterrupt,
  onInterrupt,
  onPendingChange,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  thread: Thread;
  botName: string;
  /** Why sending is impossible right now (e.g. provider unavailable), or null. */
  disabledReason: string | null;
  working: boolean;
  canInterrupt: boolean;
  onInterrupt: () => Promise<string | null>;
  onPendingChange: (
    update: (pending: ReadonlyArray<PendingOutgoingMessage>) => PendingOutgoingMessage[],
  ) => void;
}): JSX.Element {
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const draft = useComposerThreadDraft(threadRef);
  const setPrompt = useComposerDraftStore((store) => store.setPrompt);
  const addImages = useComposerDraftStore((store) => store.addImages);
  const addFiles = useComposerDraftStore((store) => store.addFiles);
  const removeImage = useComposerDraftStore((store) => store.removeImage);
  const removeFile = useComposerDraftStore((store) => store.removeFile);
  const clearComposerContent = useComposerDraftStore((store) => store.clearComposerContent);
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const serverConfig = useServerConfigs().get(environmentId) ?? null;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const prompt = draft.prompt;
  const attachments: ReadonlyArray<ComposerImageAttachment | ComposerFileAttachment> = [
    ...draft.images,
    ...draft.files,
  ];
  const supportsUploads = serverConfig?.environment.capabilities.attachmentUploads === true;
  const fileLimit = fileAttachmentStagingLimit({
    attachmentUploadsCapabilityKnown: serverConfig !== null,
    supportsAttachmentUploads: supportsUploads,
    maxFileAttachmentBytes:
      serverConfig?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null,
  });
  const hasContent = prompt.trim().length > 0 || attachments.length > 0;
  const canSend = hasContent && !sending && !working && disabledReason === null;

  // Grows with the draft (including drafts restored from storage) up to ~5 lines.
  useLayoutEffect(() => {
    resizeTextarea(textareaRef.current, prompt);
  }, [prompt]);

  const onPickFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (picked.length === 0) return;
    let slots = PROVIDER_SEND_TURN_MAX_ATTACHMENTS - attachments.length;
    const images: ComposerImageAttachment[] = [];
    const files: ComposerFileAttachment[] = [];
    let problem: string | null = null;
    for (const file of picked) {
      if (slots <= 0) {
        problem = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`;
        break;
      }
      const kind = classifyComposerAttachmentFile(file);
      if (kind === "unsupported-image") {
        problem = `'${file.name}' is not a supported image type.`;
        continue;
      }
      if (kind === "image") {
        const prepared = await prepareImageForAttachment(
          normalizeComposerImageFileMimeType(file),
          PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
        );
        if (!prepared.ok) {
          problem = `'${file.name}' could not be attached.`;
          continue;
        }
        images.push({
          type: "image",
          id: randomUUID(),
          name: prepared.file.name || "image",
          mimeType: prepared.file.type,
          sizeBytes: prepared.file.size,
          previewUrl: URL.createObjectURL(prepared.file),
          file: prepared.file,
        });
      } else {
        if (fileLimit === null) {
          problem = "Your computer isn't accepting file attachments right now.";
          continue;
        }
        if (file.size <= 0 || file.size > fileLimit) {
          problem = `'${file.name}' is empty or too large to attach.`;
          continue;
        }
        files.push({
          type: "file",
          id: randomUUID(),
          name: file.name || "file",
          mimeType: file.type || "application/octet-stream",
          sizeBytes: file.size,
          file,
        });
      }
      slots -= 1;
    }
    const acceptedImages = new Set(images.length > 0 ? addImages(threadRef, images) : []);
    const acceptedFiles = new Set(files.length > 0 ? addFiles(threadRef, files) : []);
    for (const image of images) {
      if (!acceptedImages.has(image.id)) URL.revokeObjectURL(image.previewUrl);
    }
    // Start uploading right away so sending doesn't wait on the whole transfer.
    for (const attachment of [...images, ...files]) {
      if (acceptedImages.has(attachment.id) || acceptedFiles.has(attachment.id)) {
        startAttachmentUpload({ environmentId, image: attachment, draftTarget: threadRef });
      }
    }
    setError(problem);
  };

  const removeAttachment = (attachment: ComposerImageAttachment | ComposerFileAttachment) => {
    releaseDraftAttachment(attachment);
    if (attachment.type === "image") {
      removeImage(threadRef, attachment.id);
    } else {
      removeFile(threadRef, attachment.id);
    }
  };

  const send = async () => {
    if (!canSend) return;
    const text = prompt.trim();
    const snapshot = [...attachments];
    setSending(true);
    setError(null);

    for (const attachment of snapshot) {
      startAttachmentUpload({ environmentId, image: attachment, draftTarget: threadRef });
    }
    await awaitAttachmentUploads(snapshot.map((attachment) => attachment.id));
    const uploaded =
      snapshot.length === 0 ? [] : getUploadedAttachments({ environmentId, images: snapshot });
    if (uploaded === null) {
      setSending(false);
      setError("An attachment didn't upload. Remove it or try again.");
      return;
    }

    const messageId = newMessageId();
    const createdAt = new Date().toISOString();
    const titleSeed = truncate(
      text ||
        (snapshot[0]
          ? `${snapshot[0].type === "image" ? "Image" : "File"}: ${snapshot[0].name}`
          : "New chat"),
    );
    onPendingChange((pending) => [
      ...pending,
      {
        id: messageId,
        text,
        createdAt,
        attachments: snapshot.map((attachment) => ({ id: attachment.id, name: attachment.name })),
      },
    ]);
    clearComposerContent(threadRef);

    // First message names the chat, like the upstream composer does.
    if (thread.messages.length === 0) {
      await updateMetadata({ environmentId, input: { threadId, title: titleSeed } });
    }
    const result = await startTurn({
      environmentId,
      input: {
        threadId,
        message: {
          messageId,
          role: "user",
          text: text || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
          attachments: uploaded,
        },
        modelSelection: thread.modelSelection,
        titleSeed,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt,
      },
    });
    setSending(false);
    if (result._tag === "Failure") {
      onPendingChange((pending) => pending.filter((message) => message.id !== messageId));
      // Hand the words back so nothing typed is lost, unless a new draft began.
      const currentPrompt =
        useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt ?? "";
      if (text.length > 0 && currentPrompt.length === 0) {
        setPrompt(threadRef, text);
      }
      setError(`${botName} didn't get that message. Try sending it again.`);
    }
  };

  const stop = async () => {
    setStopping(true);
    const failure = await onInterrupt();
    setStopping(false);
    if (failure !== null) setError(failure);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    // Touch keyboards keep Enter as a newline; the send button sends.
    if (isCoarsePointer()) return;
    event.preventDefault();
    void send();
  };

  const statusText = disabledReason ?? error;

  return (
    <div className="border-t border-[var(--personal-border)] bg-[var(--personal-bg)] px-3 pt-2">
      {statusText !== null ? (
        <p role="alert" className="px-1 pb-2 text-sm text-[var(--personal-text-secondary)]">
          {statusText}
        </p>
      ) : null}
      {attachments.length > 0 ? (
        <ul aria-label="Attachments" className="flex gap-2 overflow-x-auto pb-2">
          {attachments.map((attachment) => (
            <li
              key={attachment.id}
              className="flex h-11 max-w-[220px] shrink-0 items-center gap-2 rounded-xl border border-[var(--personal-border)] bg-[var(--personal-surface)] pl-1.5"
            >
              {attachment.type === "image" ? (
                <img
                  src={attachment.previewUrl}
                  alt=""
                  className="size-8 rounded-lg object-cover"
                />
              ) : (
                <FileText aria-hidden="true" className="ml-1 size-5 shrink-0" strokeWidth={1.75} />
              )}
              <span className="min-w-0 truncate text-sm text-[var(--personal-text)]">
                {attachment.name}
              </span>
              <button
                type="button"
                onClick={() => removeAttachment(attachment)}
                aria-label={`Remove ${attachment.name}`}
                className="flex size-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-text)]"
              >
                <X aria-hidden="true" className="size-4" strokeWidth={2} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-end gap-2">
        {supportsUploads ? (
          <>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabledReason !== null}
              aria-label="Add photos or files"
              className={`${ROUND_BUTTON} border border-[var(--personal-border)] bg-[var(--personal-fill-muted)] text-[var(--personal-text)] disabled:opacity-40`}
            >
              <Plus aria-hidden="true" className="size-[22px]" strokeWidth={1.75} />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={fileLimit === null ? "image/*" : undefined}
              onChange={(event) => void onPickFiles(event)}
              className="hidden"
              tabIndex={-1}
              aria-hidden="true"
            />
          </>
        ) : null}
        <label className="flex min-h-11 min-w-0 flex-1 items-center rounded-[22px] bg-[var(--personal-fill-muted)] px-4">
          <span className="sr-only">Message {botName}</span>
          <textarea
            ref={textareaRef}
            rows={1}
            value={prompt}
            onChange={(event) => setPrompt(threadRef, event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={`Message ${botName}...`}
            enterKeyHint={isCoarsePointer() ? "enter" : "send"}
            className="block w-full resize-none bg-transparent py-[11px] text-base leading-[22px] text-[var(--personal-text)] outline-none placeholder:text-[var(--personal-text-secondary)]"
          />
        </label>
        {canInterrupt ? (
          <button
            type="button"
            onClick={() => void stop()}
            disabled={stopping}
            aria-busy={stopping}
            aria-label="Stop"
            className={`${ROUND_BUTTON} bg-[var(--personal-primary)] text-[var(--personal-primary-text)] disabled:opacity-40`}
          >
            <Square aria-hidden="true" className="size-4 fill-current" strokeWidth={0} />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void send()}
            disabled={!canSend}
            aria-busy={sending || working}
            aria-label="Send"
            className={`${ROUND_BUTTON} bg-[var(--personal-primary)] text-[var(--personal-primary-text)] disabled:opacity-30`}
          >
            <ArrowUp aria-hidden="true" className="size-[22px]" strokeWidth={2} />
          </button>
        )}
      </div>
    </div>
  );
}
