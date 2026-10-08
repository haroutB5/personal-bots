import type {
  ChangeEvent,
  JSX,
  KeyboardEvent,
  MutableRefObject,
  PointerEvent as ReactPointerEvent,
} from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  type EnvironmentId,
  type ModelSelection,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  personalReplyContext,
  type PersonalReplyQuote,
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
import {
  enqueueOutboxEntry,
  hasOutboxForThread,
  outboxCommandId,
  recordOutboxUnanswered,
} from "./outbox";
import { deleteOutboxBlobs, OUTBOX_MAX_ATTACHMENT_BYTES, putOutboxBlobs } from "./outboxBlobs";
import { classifySendFailure, type SendOutcome } from "./outboxFlush";
import { attachmentChipUploadPresentation } from "./attachmentChipUploadPresentation";
import { chatTurnModelSelection } from "./chatModelSelection";
import { AttachmentPreview, type AttachmentPreviewData } from "./AttachmentPreview";
import { activeMentionDraft, applyMention, matchMentionCandidates } from "./mentionDraft";
import { MentionPopover, type MentionRow } from "./MentionPopover";
import { COMPOSER_INPUT_ATTRIBUTE, consumeComposerRefocus } from "./composerRefocus";
import { ReplyBar } from "./ReplyQuote";

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
 * True when a failed send actually landed. Some paths (a worktree bootstrap's
 * `thread.message.user.append`) refuse a second message with an id already on
 * the thread, so a repeat of a send whose *reply* was lost comes back as this
 * failure: the message is on the thread. (A plain turn start answers a repeat
 * from the server's command receipt instead, see `send`.)
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

/** What a settled send came to: sent, never left the device, unanswered, or refused. */
function outcomeOf(result: { readonly _tag: string }): SendOutcome {
  if (result._tag !== "Failure") return { kind: "sent" };
  const cause = (
    result as { readonly cause?: Parameters<typeof squashAtomCommandFailure>[0]["cause"] }
  ).cause;
  if (cause === undefined) return { kind: "unknown" };
  try {
    return classifySendFailure(squashAtomCommandFailure({ cause }));
  } catch {
    return { kind: "unknown" };
  }
}

function isCoarsePointer(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
}

const NO_IDS: ReadonlySet<string> = new Set();
/** How long after Send a keyboard event re-applying the sent text is dropped. */
const SENT_ECHO_WINDOW_MS = 1_500;

/**
 * Whether `value` is the message just sent coming back from the keyboard: the
 * same text, or the same text with its last word committed differently
 * (predictive text, autocorrect). Anything else is new typing.
 */
export function isSentTextEcho(value: string, sent: string): boolean {
  const typed = value.trim();
  const message = sent.trim();
  if (typed.length === 0 || message.length === 0) return false;
  if (typed === message) return true;
  const lastBreak = message.search(/\s\S*$/);
  if (lastBreak <= 0) return false;
  const stem = message.slice(0, lastBreak + 1);
  return typed.startsWith(stem) && !/\s/.test(typed.slice(stem.length));
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
  offlineNotice = null,
  groupId,
  working,
  botLastSpokeAtMs = null,
  queuedNotice = true,
  canInterrupt,
  onInterrupt,
  onPendingChange,
  send: sendOverride,
  mentionCandidates,
  replyTo = null,
  onClearReply,
  quickSendRef,
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
  /**
   * Set while the laptop is not connected: what a send does now ("saved on this
   * device, goes out when it reconnects"). A message sent then is queued
   * (`outbox.ts`), not refused. Null when connected.
   */
  offlineNotice?: string | null;
  /** The group this composer sends to; its queued messages go to `personalGroups.sendMessage`. */
  groupId?: string;
  working: boolean;
  /** When the bot last produced output, in epoch ms; null if it has not yet. */
  botLastSpokeAtMs?: number | null;
  /**
   * Whether the composer says "Queued" itself after a mid-turn send. A bot chat
   * turns it off: the server's delivery record drives "Queued"/"Read" under the
   * message instead, so there is one source and the two never disagree. A
   * group, whose members take the message in through their own chats, keeps it.
   */
  queuedNotice?: boolean;
  canInterrupt: boolean;
  onInterrupt: () => Promise<string | null>;
  onPendingChange: (
    update: (pending: ReadonlyArray<PendingOutgoingMessage>) => PendingOutgoingMessage[],
  ) => void;
  /**
   * Where a message goes instead of `thread.turn.start`. A group passes
   * `personalGroups.sendMessage`; everything else leaves it out and keeps the
   * turn start it has always used. The result is read the same way (`_tag`), so
   * the retry loop, the duplicate-id refusal and the pending row are shared.
   *
   * A composer with `send` takes no attachments: a group relays the transcript
   * into every member's own session, so one image would be uploaded once and
   * paid for six times (§5, v1 is text only).
   */
  send?: (input: {
    readonly messageId: string;
    readonly text: string;
    readonly createdAt: string;
    readonly replyTo?: PersonalReplyQuote;
  }) => Promise<{ readonly _tag: string }>;
  /** Members offered by `@mention` autocomplete. Absent outside a group. */
  mentionCandidates?: ReadonlyArray<MentionRow>;
  /** The message the next send replies to: shown as a bar above the field and sent with it. */
  replyTo?: PersonalReplyQuote | null;
  /** Drops the quote: the bar's X, and once a reply has been sent. */
  onClearReply?: () => void;
  /**
   * Filled with a function that sends a line of text as the owner's message
   * (a tapped choice) through the same path, retries and pending row as the
   * field's own send, without touching the draft. Resolves true once sent.
   */
  quickSendRef?: MutableRefObject<((text: string) => Promise<boolean>) | null>;
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
  const offlineRef = useRef(offlineNotice !== null);
  useEffect(() => {
    offlineRef.current = offlineNotice !== null;
  }, [offlineNotice]);
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
  // Attachments of a send still in flight leave the composer at once (with
  // its text) and come back only if the send fails; the draft store keeps them
  // until the server accepts, so a failure loses nothing.
  const [inFlightIds, setInFlightIds] = useState<ReadonlySet<string>>(NO_IDS);
  const attachments: ReadonlyArray<ComposerImageAttachment | ComposerFileAttachment> = useMemo(
    () => [...draft.images, ...draft.files].filter((attachment) => !inFlightIds.has(attachment.id)),
    [draft.files, draft.images, inFlightIds],
  );
  /** The text just sent, while a late keyboard event could put it back. */
  const sentEchoRef = useRef<{ readonly text: string; readonly until: number } | null>(null);
  /**
   * True (and the field emptied) when `value` is the keyboard re-applying the
   * message that was just sent: iOS can commit a predictive-text word or end a
   * composition after Send cleared the field.
   */
  const dropSentEcho = (value: string): boolean => {
    const echo = sentEchoRef.current;
    if (echo === null) return false;
    // The field reading empty (React having put it back) is not new typing.
    if (value.trim().length === 0) return false;
    if (Date.now() > echo.until || !isSentTextEcho(value, echo.text)) {
      sentEchoRef.current = null;
      return false;
    }
    return true;
  };
  const [preview, setPreview] = useState<AttachmentPreviewData | null>(null);
  const uploadsByAttachmentId = useAttachmentUploadStore((state) => state.uploadsByImageId);
  const attachmentChips = attachments.map((attachment) => ({
    attachment,
    upload: attachmentChipUploadPresentation(uploadsByAttachmentId[attachment.id], environmentId),
  }));
  const failedAttachmentNames = attachmentChips.flatMap(({ attachment, upload }) =>
    upload.status === "failed" ? [attachment.name] : [],
  );
  const supportsUploads =
    sendOverride === undefined && serverConfig?.environment.capabilities.attachmentUploads === true;
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
    queuedNotice &&
    queuedAtMs !== null &&
    working &&
    (botLastSpokeAtMs === null || botLastSpokeAtMs < queuedAtMs);

  // Grows with the draft (including drafts restored from storage) up to ~5 lines,
  // and puts the caret back where an insertion left it. Both belong to the same
  // "the draft text changed" moment, and both must happen before paint: an
  // inserted mention that lost the caret would drop it to the end of the line.
  useLayoutEffect(() => {
    resizeTextarea(textareaRef.current, prompt);
    const at = pendingCaret.current;
    if (at === null) return;
    pendingCaret.current = null;
    const textarea = textareaRef.current;
    if (textarea === null) return;
    textarea.focus();
    textarea.setSelectionRange(at, at);
  }, [prompt]);

  // The owner switched chats with a chat chip while typing: this composer is
  // the new chat's, and takes the focus over so the keyboard stays up.
  useLayoutEffect(() => {
    if (consumeComposerRefocus()) textareaRef.current?.focus({ preventScroll: true });
  }, []);

  // ---------------------------------------------------------------------
  // @mention autocomplete. All the text arithmetic lives in `mentionDraft`;
  // what is left here is the caret, the highlighted row and Escape.
  // ---------------------------------------------------------------------
  const [caret, setCaret] = useState(prompt.length);
  /** The token the owner dismissed with Escape, so it stays shut while typed. */
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  /** Caret to restore after an insertion rewrote the draft. */
  const pendingCaret = useRef<number | null>(null);
  const rawMentionDraft =
    mentionCandidates === undefined ? null : activeMentionDraft(prompt, caret);
  // A token stays shut once it has been completed or dismissed, and reopens
  // only when the caret leaves it: without this, inserting "@Grace " left the
  // popover offering Grace again under the name it had just written.
  if (rawMentionDraft === null && dismissedAt !== null) setDismissedAt(null);
  const mentionDraft = rawMentionDraft?.start === dismissedAt ? null : rawMentionDraft;
  const mentionMatches =
    mentionDraft === null || mentionCandidates === undefined
      ? []
      : matchMentionCandidates(mentionCandidates, mentionDraft.query);
  const mentionOpen = mentionMatches.length > 0;
  // Adjusted during render, not in an effect: the highlight must never point at
  // a row that a keystroke has already filtered away.
  const activeMentionIndex = Math.min(mentionIndex, Math.max(0, mentionMatches.length - 1));
  if (mentionIndex !== activeMentionIndex) setMentionIndex(activeMentionIndex);

  const insertMention = (name: string) => {
    if (mentionDraft === null) return;
    const next = applyMention(prompt, mentionDraft, name);
    setPrompt(threadRef, next.text);
    setCaret(next.caret);
    setDismissedAt(mentionDraft.start);
    /* oxlint-disable-next-line react/immutability -- A one-shot message to the
       layout effect above, written only from an event handler (tapping a row,
       Enter) and cleared there before the next paint. It is not render state. */
    pendingCaret.current = next.caret;
  };

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

  /**
   * Saves a message on this device, to go out when the laptop is connected
   * (see `outbox.ts`). Resolves to null once it is queued, or to the sentence
   * that says why it could not be (the caller keeps the draft then).
   */
  const queueMessage = async (input: {
    readonly messageId: string;
    readonly text: string;
    readonly quote: PersonalReplyQuote | null;
    readonly snapshot: ReadonlyArray<ComposerImageAttachment | ComposerFileAttachment>;
    readonly createdAt: string;
    readonly titleSeed: string;
    /** The unanswered first attempt, when a send that dropped mid-way is queued. */
    readonly unanswered?: boolean;
  }): Promise<string | null> => {
    const { messageId, text, quote, snapshot, createdAt, titleSeed } = input;
    const bytes = snapshot.reduce((total, attachment) => total + attachment.sizeBytes, 0);
    if (bytes > OUTBOX_MAX_ATTACHMENT_BYTES) {
      return "Those photos and files are too big to wait for the laptop. Remove some, or send them once it is back.";
    }
    const files: Array<{ readonly id: string; readonly blob: Blob }> = [];
    for (const attachment of snapshot) {
      // A draft restored after a reload may hold only the server-side upload, not the bytes.
      if (!(attachment.file instanceof Blob) || attachment.file.size === 0) {
        return "An attachment can't wait on this device. Remove it and add it again.";
      }
      files.push({ id: attachment.id, blob: attachment.file });
    }
    try {
      if (files.length > 0) await putOutboxBlobs(messageId, files);
    } catch {
      return "Couldn't save the photos or files on this device. Your draft is still here.";
    }
    const entry = enqueueOutboxEntry({
      id: messageId,
      kind: groupId === undefined ? "turn" : "group",
      environmentId,
      threadId,
      groupId: groupId ?? null,
      text,
      sendText: text || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
      createdAt,
      replyTo: quote,
      turn:
        groupId === undefined
          ? {
              modelSelection: chatTurnModelSelection(botModelSelection, thread.modelSelection),
              titleSeed,
              runtimeMode: thread.runtimeMode,
              interactionMode: thread.interactionMode,
            }
          : null,
      attachments: snapshot.map((attachment) => ({
        id: attachment.id,
        kind: attachment.type,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
      })),
    });
    if (entry === null) {
      void deleteOutboxBlobs(messageId);
      return "Couldn't save that message on this device. Your draft is still here.";
    }
    if (input.unanswered === true) recordOutboxUnanswered(messageId, true);
    return null;
  };

  const send = async (quick?: string): Promise<boolean> => {
    // A tapped choice: its own text, no draft, no attachments, no reply quote.
    const isQuick = quick !== undefined;
    if (
      isQuick
        ? quick.trim().length === 0 || sending || preparing || disabledReason !== null
        : !canSend
    ) {
      return false;
    }
    if (sendingRef.current || preparingRef.current) return false;
    sendingRef.current = true;
    const sentPrompt = isQuick ? "" : prompt;
    const text = isQuick ? quick.trim() : prompt.trim();
    const quote = isQuick ? null : replyTo;
    const snapshot = isQuick ? [] : [...attachments];
    const snapshotIds = new Set(snapshot.map((attachment) => attachment.id));
    const messageId = newMessageId();
    const midTurn = working;
    const titleSeed = truncate(
      text ||
        (snapshot[0]
          ? `${snapshot[0].type === "image" ? "Image" : "File"}: ${snapshot[0].name}`
          : "New chat"),
    );
    setSending(true);
    setError(null);
    setQueuedAtMs(null);
    // The composer empties the moment Send is tapped, draft store included;
    // a failed send puts everything back below.
    let draftCleared = false;
    const clearDraft = () => {
      if (isQuick) return;
      draftCleared = true;
      setPrompt(threadRef, "");
      sentEchoRef.current =
        text.length > 0 ? { text: sentPrompt, until: Date.now() + SENT_ECHO_WINDOW_MS } : null;
    };
    if (snapshotIds.size > 0) {
      setInFlightIds((current) => new Set([...current, ...snapshotIds]));
    }
    const releaseInFlight = () => {
      if (snapshotIds.size === 0) return;
      setInFlightIds((current) => {
        const next = new Set(current);
        for (const id of snapshotIds) next.delete(id);
        return next.size === 0 ? NO_IDS : next;
      });
    };
    const restoreDraft = () => {
      sentEchoRef.current = null;
      releaseInFlight();
      // A draft that was never emptied (the queue could not keep the message) is still there.
      if (!draftCleared || sentPrompt.trim().length === 0) return;
      const typedSince = useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt ?? "";
      setPrompt(
        threadRef,
        typedSince.trim().length === 0 ? sentPrompt : `${sentPrompt}\n${typedSince}`,
      );
    };
    /** The message is on the queue: the composer is done with it. */
    const handOffToQueue = () => {
      clearDraft();
      for (const attachment of snapshot) removeAttachment(attachment);
      releaseInFlight();
      if (quote !== null) onClearReply?.();
    };
    try {
      // The laptop is not connected, or an earlier message of this chat is still
      // waiting for it: this one goes on the queue behind it, so it can never
      // arrive first.
      if (offlineRef.current || hasOutboxForThread(threadId)) {
        const createdAt = new Date().toISOString();
        const problem = await queueMessage({
          messageId,
          text,
          quote,
          snapshot,
          createdAt,
          titleSeed,
        });
        if (problem !== null) {
          restoreDraft();
          setError(problem);
          return false;
        }
        handOffToQueue();
        return true;
      }

      clearDraft();
      for (const attachment of snapshot) {
        startAttachmentUpload({ environmentId, image: attachment, draftTarget: threadRef });
      }
      await awaitAttachmentUploads(snapshot.map((attachment) => attachment.id));
      const uploaded =
        snapshot.length === 0 ? [] : getUploadedAttachments({ environmentId, images: snapshot });
      if (uploaded === null) {
        setSending(false);
        restoreDraft();
        setError("An attachment didn't upload. Remove it or try again.");
        return false;
      }

      const createdAt = new Date().toISOString();
      onPendingChange((pending) => [
        ...pending,
        {
          id: messageId,
          threadId,
          text,
          createdAt,
          attachments: snapshot.map((attachment) => ({ id: attachment.id, name: attachment.name })),
          ...(quote !== null ? { replyTo: quote } : {}),
        },
      ]);

      // The server names a new chat from `titleSeed` when the turn starts, as
      // a replaceable title the AI title then refines once. A metadata rename
      // here would count as the user's own title and block the AI title.
      // Every attempt sends the same message id AND the same command id. The
      // server keeps a receipt of each command id it has handled and answers a
      // repeat from it, so a retry of a send whose *reply* was lost can never
      // post the message twice. (The message id alone is not enough: the
      // server accepts a second `thread.turn.start` under an id it already
      // holds, which is what a Retry of a failed turn relies on.)
      // A dropped connection throws rather than returning a failure, and that
      // is the case worth retrying most, so it is folded in here.
      const commandId = CommandId.make(outboxCommandId(messageId));
      const attempt = async (): Promise<{
        readonly result: { readonly _tag: string };
        readonly outcome: SendOutcome;
      }> => {
        try {
          if (sendOverride !== undefined) {
            // A group opens a round instead of starting a turn; the message id
            // is still the client's, so a resend opens no second round.
            const result = await sendOverride({
              messageId,
              text: text || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
              createdAt,
              ...(quote !== null ? { replyTo: quote } : {}),
            });
            return { result, outcome: outcomeOf(result) };
          }
          const result = await startTurn({
            environmentId,
            input: {
              commandId,
              threadId,
              message: {
                messageId,
                role: "user",
                text: text || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
                attachments: uploaded,
                ...(quote !== null ? { context: personalReplyContext(quote) } : {}),
              },
              modelSelection: chatTurnModelSelection(botModelSelection, thread.modelSelection),
              titleSeed,
              runtimeMode: thread.runtimeMode,
              interactionMode: thread.interactionMode,
              createdAt,
            },
          });
          return { result, outcome: outcomeOf(result) };
        } catch (thrown) {
          return {
            result: { _tag: "Failure", thrown } as { readonly _tag: string },
            outcome: { kind: "unknown" },
          };
        }
      };

      let { result, outcome } = await attempt();
      for (const wait of SEND_RETRY_DELAYS_MS) {
        if (result._tag !== "Failure" || sendFailedBecauseItAlreadyLanded(result)) break;
        // Refused by the laptop: another try says the same. Gone from the laptop
        // (not connected): the queue is the better place to wait.
        if (outcome.kind === "rejected" || offlineRef.current) break;
        setRetrying(true);
        await delay(wait);
        ({ result, outcome } = await attempt());
      }
      setRetrying(false);
      setSending(false);
      const landed = result._tag !== "Failure" || sendFailedBecauseItAlreadyLanded(result);
      if (!landed) {
        // Not refused: it never went out, or it went out and no answer came
        // back. Either way the same ids can go out again, so keep the message
        // on the queue instead of giving it back as a draft.
        if (outcome.kind === "not-sent" || outcome.kind === "unknown") {
          const problem = await queueMessage({
            messageId,
            text,
            quote,
            snapshot,
            createdAt,
            titleSeed,
            unanswered: outcome.kind === "unknown",
          });
          if (problem === null) {
            onPendingChange((pending) => pending.filter((message) => message.id !== messageId));
            handOffToQueue();
            return true;
          }
        }
        onPendingChange((pending) => pending.filter((message) => message.id !== messageId));
        restoreDraft();
        setError(`${botName ?? "The bot"} didn't get that message. Try sending it again.`);
        return false;
      }
      setQueuedAtMs(midTurn ? Date.now() : null);
      for (const attachment of snapshot) removeAttachment(attachment);
      releaseInFlight();
      if (quote !== null) onClearReply?.();
      return true;
    } catch {
      setRetrying(false);
      onPendingChange((pending) => pending.filter((message) => message.id !== messageId));
      restoreDraft();
      setError("Couldn't send that message. Your draft is still saved; try again.");
      return false;
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  // The screen's tapped choices send through this composer's own path.
  useEffect(() => {
    if (quickSendRef === undefined) return;
    quickSendRef.current = (text) => send(text);
    return () => {
      quickSendRef.current = null;
    };
  });

  // Picking Reply puts the cursor in the field, after the menu has handed focus back.
  const replyMessageId = replyTo?.messageId ?? null;
  useEffect(() => {
    if (replyMessageId === null) return;
    const timer = setTimeout(() => textareaRef.current?.focus({ preventScroll: true }), 120);
    return () => clearTimeout(timer);
  }, [replyMessageId]);

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
    if (mentionOpen) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : mentionMatches.length - 1;
        setMentionIndex((current) => (current + step) % mentionMatches.length);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedAt(mentionDraft?.start ?? null);
        return;
      }
      // Enter picks the highlighted member rather than sending a half-typed
      // name — on a touch keyboard Enter is a newline, so tapping the row is
      // the phone's path and this is the desktop one.
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        const picked = mentionMatches[activeMentionIndex];
        if (picked !== undefined && !event.nativeEvent.isComposing) {
          event.preventDefault();
          insertMention(picked.name);
          return;
        }
      }
    }
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    // Touch keyboards keep Enter as a newline; the send button sends.
    if (isCoarsePointer()) return;
    event.preventDefault();
    void send();
  };

  const statusText = disabledReason ?? error;

  return (
    <div className="personal-column border-t border-[var(--personal-border)] bg-[var(--personal-bg)] px-3 pt-2">
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
      {offlineNotice !== null && statusText === null && !retrying ? (
        <p role="status" className="px-1 pb-2 text-sm text-[var(--personal-text-secondary)]">
          {offlineNotice}
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
              <button
                type="button"
                aria-label={`Open ${attachment.name}`}
                className="flex min-w-0 items-center gap-2 self-stretch outline-none focus-visible:ring-2"
                onClick={() =>
                  setPreview({
                    ...attachment,
                    ...(attachment.type === "image"
                      ? { imageUrl: attachment.previewUrl }
                      : { attachmentId: attachment.uploadedAttachmentId }),
                  })
                }
              >
                {attachment.type === "image" ? (
                  <img
                    src={attachment.previewUrl}
                    alt=""
                    className="size-8 rounded-lg object-cover"
                  />
                ) : (
                  <FileText
                    aria-hidden="true"
                    className="ml-1 size-5 shrink-0"
                    strokeWidth={1.75}
                  />
                )}
                <span className="min-w-0 truncate text-sm text-[var(--personal-text)]">
                  {attachment.name}
                </span>
              </button>
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
      {preview && environmentId && (
        <AttachmentPreview
          attachment={preview}
          environmentId={environmentId}
          onClose={() => setPreview(null)}
        />
      )}
      {mentionOpen ? (
        <MentionPopover
          candidates={mentionMatches}
          activeIndex={activeMentionIndex}
          onPick={(candidate) => insertMention(candidate.name)}
        />
      ) : null}
      {replyTo !== null && !sending ? (
        <ReplyBar quote={replyTo} onCancel={() => onClearReply?.()} />
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
            {...{ [COMPOSER_INPUT_ATTRIBUTE]: "" }}
            rows={1}
            value={prompt}
            onChange={(event) => {
              // React puts the field back to the (empty) draft on its own.
              if (dropSentEcho(event.target.value)) return;
              setPrompt(threadRef, event.target.value);
              setCaret(event.target.selectionStart ?? event.target.value.length);
            }}
            onCompositionEnd={(event) => {
              // A composition that ends with no input event after it can leave
              // the sent text in the field while the draft is already empty.
              const field = event.currentTarget;
              if (dropSentEcho(field.value) && prompt.length === 0) field.value = "";
            }}
            onKeyDown={onKeyDown}
            // The caret can move without the text changing (tap, arrow keys),
            // and a mention token is defined by where the caret is.
            onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? prompt.length)}
            placeholder={botName === null ? "Message…" : `Message ${botName}…`}
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
            aria-label={
              offlineNotice !== null
                ? "Send, waits here until your laptop reconnects"
                : working
                  ? "Send, queued until the bot takes it in"
                  : "Send"
            }
            className={`${ROUND_BUTTON} bg-[var(--personal-primary)] text-[var(--personal-primary-text)] disabled:opacity-30`}
          >
            <ArrowUp aria-hidden="true" className="size-[22px]" strokeWidth={2} />
          </button>
        )}
      </div>
    </div>
  );
}
