import type { ChangeEvent, JSX, KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type EnvironmentId,
  type ModelSelection,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ThreadId,
} from "@t3tools/contracts";
import { truncate } from "@t3tools/shared/String";
import { ArrowUp, CircleAlert, CircleDashed, FileText, Plus, Square, X } from "lucide-react";

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
  retryAttachmentUpload,
  startAttachmentUpload,
  useAttachmentUploadStore,
} from "~/lib/attachmentUploadQueue";
import { prepareImageForAttachment } from "~/lib/imageCompression";
import { newMessageId, randomUUID } from "~/lib/utils";
import { useServerConfigs } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import type { Thread } from "~/types";
import { useAtomCommand } from "~/state/use-atom-command";

import type { PendingOutgoingMessage } from "./MessageList";
import { attachmentChipUploadPresentation } from "./attachmentChipUploadPresentation";

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

/** Waits between send attempts; the gaps grow so a brief outage is ridden out. */
const SEND_RETRY_DELAYS_MS = [700, 2_000, 5_000] as const;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * True when a failed send actually landed. The decider refuses a second message
 * with an id already on the thread, so a retry of a send whose *reply* was lost
 * comes back as this failure: the message is on the thread, and re-sending it
 * under a fresh id would post it twice.
 */
export function sendFailedBecauseItAlreadyLanded(failure: unknown): boolean {
  return /already exists on thread/i.test(describeUnknown(failure));
}

/** Flattens an unknown failure to searchable text without assuming its shape. */
function describeUnknown(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value !== "object") return String(value);
  if (depth > 4) return "";
  const parts: string[] = [];
  for (const nested of Object.values(value as Record<string, unknown>)) {
    parts.push(describeUnknown(nested, depth + 1));
  }
  return parts.join(" ");
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
  botModelSelection = null,
  disabledReason,
  working,
  botLastSpokeAtMs,
  canInterrupt,
  onInterrupt,
  onPendingChange,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  thread: Thread;
  /** Null while the bot is still loading (a cold deep link). */
  botName: string | null;
  /**
   * The bot's current model settings (model, effort). Sent with each turn so
   * edits to the bot reach its existing chats; ignored if the bot moved to a
   * different provider, which only applies to new chats.
   */
  botModelSelection?: ModelSelection | null;
  /** Why sending is impossible right now (e.g. provider unavailable), or null. */
  disabledReason: string | null;
  working: boolean;
  /** When the bot last produced output, in epoch ms; null if it has not yet. */
  botLastSpokeAtMs: number | null;
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
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const serverConfig = useServerConfigs().get(environmentId) ?? null;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [preparing, setPreparing] = useState(false);
  const preparingRef = useRef(false);
  const [stopping, setStopping] = useState(false);
  /** A send failed and is being tried again on its own. */
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * When a message was accepted while the bot was still working, in epoch ms;
   * null when nothing is waiting. Compared against the bot's own last output,
   * because a steer is usually answered well before the turn ends.
   */
  const [queuedAtMs, setQueuedAtMs] = useState<number | null>(null);

  const prompt = draft.prompt;
  const attachments: ReadonlyArray<ComposerImageAttachment | ComposerFileAttachment> = useMemo(
    () => [...draft.images, ...draft.files],
    [draft.files, draft.images],
  );
  const uploadsByAttachmentId = useAttachmentUploadStore((state) => state.uploadsByImageId);
  const attachmentChips = attachments.map((attachment) => ({
    attachment,
    upload: attachmentChipUploadPresentation(uploadsByAttachmentId[attachment.id], environmentId),
  }));
  const failedAttachmentNames = attachmentChips.flatMap(({ attachment, upload }) =>
    upload.status === "failed" ? [attachment.name] : [],
  );
  const supportsUploads = serverConfig?.environment.capabilities.attachmentUploads === true;
  const fileLimit = fileAttachmentStagingLimit({
    attachmentUploadsCapabilityKnown: serverConfig !== null,
    supportsAttachmentUploads: supportsUploads,
    maxFileAttachmentBytes:
      serverConfig?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null,
  });
  const hasContent = prompt.trim().length > 0 || attachments.length > 0;
  // Sending mid-turn is allowed: the server accepts the start unconditionally
  // and every provider adapter folds the message into the running turn, so it
  // reaches the bot when the current work yields. It is persisted the moment the
  // command lands, which is what makes it survive closing the PWA - a draft held
  // in this tab would not.
  const canSend = hasContent && !sending && !preparing && disabledReason === null;
  // Stop stays one tap away in the chat menu; the composer's single button
  // belongs to whichever action the draft implies.
  const showStop = canInterrupt && !hasContent;
  // Derived, not cleared in an effect: the turn ending retires the notice with
  // no extra render, and so does the bot replying. Waiting only on the turn
  // used to leave "Queued" on screen under an answer the bot had already given.
  const queued =
    queuedAtMs !== null && working && (botLastSpokeAtMs === null || botLastSpokeAtMs < queuedAtMs);

  // Grows with the draft (including drafts restored from storage) up to ~5 lines.
  useLayoutEffect(() => {
    resizeTextarea(textareaRef.current, prompt);
  }, [prompt]);

  const onPickFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (picked.length === 0) return;
    if (sendingRef.current || preparingRef.current) return;
    preparingRef.current = true;
    setPreparing(true);
    let slots = PROVIDER_SEND_TURN_MAX_ATTACHMENTS - attachments.length;
    const images: ComposerImageAttachment[] = [];
    const files: ComposerFileAttachment[] = [];
    try {
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
    } catch {
      const current = useComposerDraftStore.getState().getComposerDraft(threadRef);
      for (const image of images) {
        if (!current?.images.some((entry) => entry.id === image.id)) {
          URL.revokeObjectURL(image.previewUrl);
        }
      }
      setError("Couldn't prepare those attachments. Try selecting them again.");
    } finally {
      preparingRef.current = false;
      setPreparing(false);
    }
  };

  const removeAttachment = (attachment: ComposerImageAttachment | ComposerFileAttachment) => {
    releaseDraftAttachment(attachment);
    if (attachment.type === "image") {
      removeImage(threadRef, attachment.id);
    } else {
      removeFile(threadRef, attachment.id);
    }
  };

  const retryAttachment = (attachment: ComposerImageAttachment | ComposerFileAttachment) => {
    setError(null);
    retryAttachmentUpload({ environmentId, image: attachment, draftTarget: threadRef });
  };

  const send = async () => {
    if (!canSend || sendingRef.current || preparingRef.current) return;
    sendingRef.current = true;
    const text = prompt.trim();
    const snapshot = [...attachments];
    const messageId = newMessageId();
    const midTurn = working;
    setSending(true);
    setError(null);
    setQueuedAtMs(null);
    try {
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

      // The server names a new chat from `titleSeed` when the turn starts, as
      // a replaceable title the AI title then refines once. A metadata rename
      // here would count as the user's own title and block the AI title.
      // Retries keep the same message id on purpose. The server refuses an id
      // it already holds, so a retry can never post the message twice, and that
      // refusal is itself proof the first attempt landed.
      // A dropped connection throws rather than returning a failure, and that
      // is the case worth retrying most, so it is folded in here.
      const attempt = async (): Promise<{ readonly _tag: string }> => {
        try {
          return await startTurn({
            environmentId,
            input: {
              threadId,
              message: {
                messageId,
                role: "user",
                text: text || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
                attachments: uploaded,
              },
              modelSelection:
                botModelSelection !== null &&
                botModelSelection.instanceId === thread.modelSelection.instanceId
                  ? botModelSelection
                  : thread.modelSelection,
              titleSeed,
              runtimeMode: thread.runtimeMode,
              interactionMode: thread.interactionMode,
              createdAt,
            },
          });
        } catch (thrown) {
          return { _tag: "Failure", thrown } as { readonly _tag: string };
        }
      };

      let result = await attempt();
      for (const wait of SEND_RETRY_DELAYS_MS) {
        if (result._tag !== "Failure" || sendFailedBecauseItAlreadyLanded(result)) break;
        setRetrying(true);
        await delay(wait);
        result = await attempt();
      }
      setRetrying(false);
      setSending(false);
      const landed = result._tag !== "Failure" || sendFailedBecauseItAlreadyLanded(result);
      if (!landed) {
        onPendingChange((pending) => pending.filter((message) => message.id !== messageId));
        setError(`${botName ?? "The bot"} didn't get that message. Try sending it again.`);
      } else {
        setQueuedAtMs(midTurn ? Date.now() : null);
        // Keep the draft (including attachments) until the server accepts it.
        // Only consume the submitted content, preserving edits made during upload.
        const current = useComposerDraftStore.getState().getComposerDraft(threadRef);
        if (current?.prompt === prompt) setPrompt(threadRef, "");
        for (const attachment of snapshot) removeAttachment(attachment);
      }
    } catch {
      setRetrying(false);
      onPendingChange((pending) => pending.filter((message) => message.id !== messageId));
      setError("Couldn't send that message. Your draft is still saved; try again.");
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const stop = async () => {
    setStopping(true);
    const failure = await onInterrupt();
    setStopping(false);
    if (failure !== null) setError(failure);
  };

  // Tapping a composer button must not blur the message field. iOS blurs on
  // the button's default pointer action, which drops the keyboard and reflows
  // the composer mid-tap, so the click that follows misses and the press is
  // swallowed (Send appeared to need two taps). Preventing the default keeps
  // focus, so the keyboard stays up and the layout never moves; the click
  // itself is unaffected.
  const keepKeyboardUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (document.activeElement === textareaRef.current) event.preventDefault();
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
      {retrying ? (
        <p role="status" className="px-1 pb-2 text-sm text-[var(--personal-text-secondary)]">
          That didn't send. Trying again...
        </p>
      ) : null}
      {queued && !retrying && statusText === null ? (
        // The message is already on the laptop and in the transcript; this says
        // why the bot has not answered it yet.
        <p role="status" className="px-1 pb-2 text-sm text-[var(--personal-text-secondary)]">
          Queued. {botName ?? "The bot"} gets it as soon as this turn finishes.
        </p>
      ) : null}
      {failedAttachmentNames.length > 0 ? (
        <p role="alert" className="sr-only">
          {failedAttachmentNames.length === 1
            ? `Upload failed for ${failedAttachmentNames[0]}. Retry is available on the attachment.`
            : `Uploads failed for ${failedAttachmentNames.join(", ")}. Retry is available on each attachment.`}
        </p>
      ) : null}
      {attachments.length > 0 ? (
        <ul aria-label="Attachments" className="flex gap-2 overflow-x-auto pb-2">
          {attachmentChips.map(({ attachment, upload }) => (
            <li
              key={attachment.id}
              aria-busy={upload.status === "uploading" || undefined}
              className={`flex h-11 max-w-[240px] shrink-0 items-center gap-2 rounded-xl border pl-1.5 ${
                upload.status === "failed"
                  ? "border-[var(--personal-danger-border)] bg-[var(--personal-danger-bg)]"
                  : "border-[var(--personal-border)] bg-[var(--personal-surface)]"
              }`}
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
              {upload.status === "uploading" ? (
                <span
                  aria-label={`Uploading ${attachment.name}: ${upload.progressLabel}`}
                  className="flex shrink-0 items-center gap-1 text-xs tabular-nums text-[var(--personal-text-secondary)]"
                >
                  <CircleDashed aria-hidden="true" className="size-3.5" strokeWidth={2} />
                  <span aria-hidden="true">{upload.progressLabel}</span>
                </span>
              ) : null}
              {upload.status === "failed" ? (
                <button
                  type="button"
                  onClick={() => retryAttachment(attachment)}
                  disabled={sending}
                  aria-label={`Upload failed for ${attachment.name}: ${upload.reason}. Retry upload`}
                  className="flex h-11 shrink-0 items-center gap-1 px-1 text-xs font-semibold text-[var(--personal-danger)] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-danger)] disabled:opacity-40"
                >
                  <CircleAlert aria-hidden="true" className="size-4" strokeWidth={2} />
                  {/* The reason is visible, not just announced: it is the only
                      way to diagnose a phone-side failure from a screenshot. */}
                  <span aria-hidden="true" className="max-w-32 truncate font-normal">
                    {upload.reason} ·
                  </span>
                  <span aria-hidden="true">Retry</span>
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => removeAttachment(attachment)}
                disabled={sending}
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
              disabled={disabledReason !== null || sending || preparing}
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
          <span className="sr-only">{botName === null ? "Message" : `Message ${botName}`}</span>
          <textarea
            ref={textareaRef}
            rows={1}
            value={prompt}
            onChange={(event) => setPrompt(threadRef, event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={botName === null ? "Message..." : `Message ${botName}...`}
            enterKeyHint={isCoarsePointer() ? "enter" : "send"}
            className="block w-full resize-none bg-transparent py-[11px] text-base leading-[22px] text-[var(--personal-text)] outline-none placeholder:text-[var(--personal-text-secondary)]"
          />
        </label>
        {showStop ? (
          <button
            type="button"
            onPointerDown={keepKeyboardUp}
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
            onPointerDown={keepKeyboardUp}
            onClick={() => void send()}
            disabled={!canSend}
            aria-busy={sending}
            aria-label={working ? "Send, queued until this turn finishes" : "Send"}
            className={`${ROUND_BUTTON} bg-[var(--personal-primary)] text-[var(--personal-primary-text)] disabled:opacity-30`}
          >
            <ArrowUp aria-hidden="true" className="size-[22px]" strokeWidth={2} />
          </button>
        )}
      </div>
    </div>
  );
}
