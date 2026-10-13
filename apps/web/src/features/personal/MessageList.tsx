import type { JSX, ReactNode } from "react";
import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { PendingApproval } from "@t3tools/client-runtime/pending-requests";
import type {
  ApprovalRequestId,
  EnvironmentId,
  PersonalTask,
  ProviderApprovalDecision,
  ProviderApprovalOption,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { readPersonalReplyQuote, type PersonalReplyQuote } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowDown, Check, ChevronRight, FileText } from "lucide-react";

import { useAssetUrls } from "~/assets/assetUrls";
import ChatMarkdown from "~/components/ChatMarkdown";
import { shouldPreserveAssistantLineBreaks } from "~/components/chat/MessagesTimeline.logic";
import { cn } from "~/lib/utils";
import { selectMessageImageResources } from "~/session-logic";
import { isFileAttachment, type ChatMessage } from "~/types";
import { AttachmentPreview, type AttachmentPreviewData } from "./AttachmentPreview";

import { BotAvatar, type BotAvatarShape } from "./BotAvatar";
import { type ConversationItem, formatDayDivider } from "./conversationModel";
import type { ServerTurn } from "./delegationModel";
import { chatNoticeLabel, chatNoticeUndo, isServerTurnNotice } from "./chatNotices";
import { ContextUsed } from "./ContextUsedPanel";
import { hasRecordedContext, turnStartByAssistantItem } from "./contextUsed";
import { NoteNoticeRow } from "./NoteNoticeRow";
import { groupSystemLabel, readGroupMarker } from "./groupModel";
import { QuestionCard } from "./QuestionCard";
import { SecretRequestCard, type ProvideSecret } from "./SecretRequestCard";
import { LoginRequestCard, type ProvideLogin } from "./LoginRequestCard";
import { ConnectionApprovalCard } from "./ConnectionApprovalCard";
import { approvalHasExpired } from "./connectionApprovalCards";
import { LeadBotChangeCard } from "./LeadBotChangeCard";
import { MemoryChangeCard } from "./MemoryChangeCard";
import { ToolDetails } from "./ToolDetails";
import type { LatestMessageReadStatus, MessageReadStatus } from "./messageReadStatus";
import { consumeChatSwitched } from "./chatChipHandoff";
import { ChoiceButtons, type ChoicesState } from "./ChoiceButtons";
import { mayHaveChoices, splitChoices } from "./choices";
import { describeAnswer, type QuestionCardItem, type UserInputAnswers } from "./questionCards";
import { jumpToMessage, replyQuoteForMessage } from "./messageReply";
import { REQUEST_WASH_ATTRIBUTE, REQUEST_WASH_MS } from "./requestLanding";
import { clearMessageJump, peekMessageJump } from "./pendingMessageJump";
import { ReplyQuoteChip } from "./ReplyQuote";
import { ReplyableMessage } from "./ReplyableMessage";
import { SwipeTimeRow } from "./MessageSwipeTime";
import { messageTimeParts, parseSentAt, TIME_PER_RUN } from "./messageTime";
import {
  buildTranscriptRows,
  type MessageItem,
  type TranscriptBlockRow,
  type TranscriptRunRow,
  type TranscriptRow,
  type WorkItem,
} from "./messageRows";
import type { OutboxEntry, OutboxRow } from "./outbox";
import {
  transcriptRange,
  TRANSCRIPT_WINDOW_SIZE,
  TRANSCRIPT_WINDOW_STEP,
} from "./transcriptWindow";

/** A message the user sent that the server has not echoed back yet. */
export interface PendingOutgoingMessage {
  readonly id: string;
  /** The chat it was sent in; it only ever renders there. */
  readonly threadId: string;
  readonly text: string;
  readonly createdAt: string;
  readonly attachments: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  /** The message it replies to, drawn above it like the sent one. */
  readonly replyTo?: PersonalReplyQuote | undefined;
}

const STICK_THRESHOLD_PX = 80;
/** How long the reader stays away from the bottom before "Jump to latest" shows. */
export const JUMP_TO_LATEST_DELAY_MS = 150;
/** Outlasts the iPhone keyboard's slide down (about 250-300ms). */
export const VIEWPORT_SETTLE_MS = 400;
/** Gives up on a smooth jump that never reached the bottom. */
const JUMP_SETTLE_MS = 1_000;
/** How long after a wheel, key or finger lift a scroll still counts as the reader's. */
const READER_INPUT_MS = 400;
/**
 * How long after a return from hidden new items still land the reader on the
 * latest. On iOS the page is suspended while away and the client learns the
 * missed items only when it reconnects, which can be after the visible event;
 * the reader's own touch, a selection or a jump in flight ends the wait early.
 */
export const AWAY_CATCH_UP_MS = 5_000;
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

function isEditable(target: EventTarget | null): boolean {
  const element = target as Partial<HTMLElement> | null;
  return (
    element?.isContentEditable === true || /^(INPUT|TEXTAREA|SELECT)$/.test(element?.tagName ?? "")
  );
}

const APPROVAL_KIND_LABEL: Record<PendingApproval["requestKind"], string> = {
  command: "wants to run a command",
  "file-read": "wants to read files",
  "file-change": "wants to change files",
  "mcp-elicitation": "needs your input for a tool",
  permission: "wants extra permissions",
};

const DEFAULT_APPROVAL_OPTIONS: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "decline", label: "Deny" },
  { decision: "accept", label: "Approve" },
];

function attachmentName(attachment: unknown): string {
  if (typeof attachment === "object" && attachment !== null && "name" in attachment) {
    const name = (attachment as { name: unknown }).name;
    if (typeof name === "string" && name.length > 0) return name;
  }
  return "Attachment";
}

const READ_STATUS_LABEL: Record<MessageReadStatus, string> = {
  queued: "Queued",
  read: "Read",
};

const USER_BUBBLE_CLASS =
  "rounded-[var(--personal-radius-xl)] bg-[var(--personal-fill-muted)] px-3.5 py-2.5 text-[16px] leading-[22px] break-words whitespace-pre-wrap text-[var(--personal-text)]";

/** The bubble tail: the run's last bubble squares one bottom corner to 6 px (SPEC 2.8). */
const TAIL_USER = "rounded-br-[6px]";
const TAIL_BOT = "rounded-bl-[6px]";

/** The owner's text bubble, with the quote of the message it replies to above the text. */
function UserBubble({
  text,
  quote,
  onJump,
  tail = false,
  widthClass = "max-w-[78%]",
}: {
  text: string;
  quote: PersonalReplyQuote | null;
  onJump?: ((messageId: string) => void) | undefined;
  /** The run's last bubble: its bottom-right corner squares to 6 px. */
  tail?: boolean;
  /** `max-w-full` when a wrapper already holds the 78%. */
  widthClass?: string;
}) {
  const bubbleClass = cn(USER_BUBBLE_CLASS, tail && TAIL_USER);
  if (quote === null) return <p className={cn(widthClass, bubbleClass)}>{text}</p>;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", widthClass, bubbleClass)}>
      <ReplyQuoteChip quote={quote} onJump={onJump} />
      <p>{text}</p>
    </div>
  );
}

/** One message's exact time, under a run's last line (SPEC 2.8; hidden on swipe too). */
function RunTime({ at, align, now }: { at: Date; align: "start" | "end"; now: Date }) {
  const { time } = messageTimeParts(at, now);
  return (
    <span
      data-run-time=""
      className={cn(
        "text-[13px] leading-4 font-medium text-[var(--personal-text-tertiary)] tabular-nums",
        align === "end" && "text-right",
      )}
    >
      {time}
    </span>
  );
}

/**
 * A question answered somewhere else (the Mac or another context) while this
 * page was open: a centred receipt where the question stood, never a second
 * card to answer (SPEC 2.8).
 */
function AnsweredElsewhereReceipt({
  card,
}: {
  card: Extract<QuestionCardItem, { readonly kind: "answered" }>;
}) {
  const answer = card.questions
    .flatMap((question) => describeAnswer(question, card.answers[question.id]))
    .join(", ");
  return (
    <p
      role="status"
      data-testid="answered-elsewhere"
      className="mx-auto flex h-8 max-w-full items-center gap-2 rounded-full border border-[var(--personal-border)] bg-[var(--personal-surface)] px-3 text-[13px] leading-4 text-[var(--personal-text-secondary)]"
    >
      <Check
        aria-hidden="true"
        className="size-4 shrink-0 text-[var(--personal-state-working)]"
        strokeWidth={2.25}
      />
      <span className="shrink-0">Answered on your Mac ·</span>
      <b className="min-w-0 truncate font-semibold text-[var(--personal-text)]">{answer}</b>
    </p>
  );
}

/**
 * The notice card under the transcript: a turn that failed ("Couldn't send:
 * ...") and a queued message the laptop refused share it, so both read and
 * retry the same way.
 */
function ErrorNotice({
  text,
  detail = null,
  tone,
  retry = null,
  cancel = null,
}: {
  text: string;
  detail?: string | null | undefined;
  tone: "danger" | "info";
  retry?: { readonly onRetry: () => void; readonly busy: boolean } | null | undefined;
  cancel?: { readonly onCancel: () => void } | null | undefined;
}) {
  return (
    <div
      role={tone === "info" ? "status" : "alert"}
      data-tone={tone}
      className={cn(
        "max-w-[90%] rounded-[var(--personal-radius-card)] border px-3.5 py-2.5 text-sm break-words",
        tone === "info"
          ? "border-[var(--personal-border)] bg-[var(--personal-fill-muted)] text-[var(--personal-text-secondary)]"
          : "border-[var(--personal-danger-border)] bg-[var(--personal-danger-bg)] text-[var(--personal-danger)]",
      )}
    >
      <p>{text}</p>
      {detail ? (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-[12px] font-medium select-none">Details</summary>
          <p className="mt-1 text-[12px] leading-snug break-words opacity-80">{detail}</p>
        </details>
      ) : null}
      {tone === "danger" && (retry !== null || cancel !== null) ? (
        <div className="mt-2 flex gap-2">
          {retry !== null ? (
            <button
              type="button"
              onClick={retry.onRetry}
              disabled={retry.busy}
              className="min-h-9 rounded-[var(--personal-radius-button)] border border-[var(--personal-danger-border)] px-3 text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-danger)] active:opacity-70 disabled:opacity-50"
            >
              {retry.busy ? "Retrying…" : "Retry"}
            </button>
          ) : null}
          {cancel !== null ? (
            <button
              type="button"
              onClick={cancel.onCancel}
              className="min-h-9 rounded-[var(--personal-radius-button)] border border-[var(--personal-danger-border)] px-3 text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-danger)] active:opacity-70"
            >
              Cancel
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const QUEUED_ACTION_CLASS =
  "min-h-9 px-2 text-xs font-medium text-[var(--personal-text-secondary)] underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] active:opacity-70";

/**
 * A message typed while the laptop was away, on the device and not sent yet.
 * It reads like a sent one, dimmed, with its state in the same small status
 * line "Queued"/"Read" use, and Edit and Cancel until it goes out. A message
 * the laptop refused shows the failed-turn card with Retry.
 */
function QueuedMessage({
  row,
  onCancel,
  onEdit,
  onRetry,
}: {
  row: OutboxRow;
  onCancel: ((id: string) => void) | undefined;
  onEdit: ((entry: OutboxEntry) => void) | undefined;
  onRetry: ((id: string) => void) | undefined;
}) {
  const { entry, state } = row;
  return (
    <div className="flex flex-col items-end gap-1" data-queued-message={entry.id}>
      <div className="flex flex-col items-end gap-1 opacity-70">
        {entry.attachments.map((attachment) => (
          <span
            key={attachment.id}
            className="flex max-w-[78%] items-center gap-1.5 rounded-xl border border-[var(--personal-border)] bg-[var(--personal-surface)] px-3 py-2 text-sm"
          >
            <FileText aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.75} />
            <span className="truncate">{attachment.name}</span>
          </span>
        ))}
        {entry.text.length > 0 ? <UserBubble text={entry.text} quote={entry.replyTo} /> : null}
      </div>
      {state === "failed" ? (
        <ErrorNotice
          text={entry.error ?? "Couldn't send: try again."}
          tone="danger"
          retry={onRetry === undefined ? null : { onRetry: () => onRetry(entry.id), busy: false }}
          cancel={onCancel === undefined ? null : { onCancel: () => onCancel(entry.id) }}
        />
      ) : (
        <span
          role="status"
          className="flex items-center gap-1 text-xs text-[var(--personal-text-tertiary)]"
        >
          <span>{state === "sending" ? "Sending" : "Waiting to send"}</span>
          {state === "waiting" && onEdit !== undefined && entry.attachments.length === 0 ? (
            <button type="button" className={QUEUED_ACTION_CLASS} onClick={() => onEdit(entry)}>
              Edit
            </button>
          ) : null}
          {state === "waiting" && onCancel !== undefined ? (
            <button
              type="button"
              className={QUEUED_ACTION_CLASS}
              onClick={() => onCancel(entry.id)}
            >
              Cancel
            </button>
          ) : null}
        </span>
      )}
    </div>
  );
}

/**
 * The waiting messages on their own, for a chat that has not loaded yet: the
 * app was opened again while the laptop is still away, so the transcript is not
 * here but what was typed is, and it still goes out on reconnect.
 */
export function QueuedMessageList({
  rows,
  onCancel,
  onEdit,
  onRetry,
}: {
  rows: ReadonlyArray<OutboxRow>;
  onCancel: ((id: string) => void) | undefined;
  onEdit: ((entry: OutboxEntry) => void) | undefined;
  onRetry: ((id: string) => void) | undefined;
}) {
  return (
    <div className="flex w-full max-w-[var(--personal-reading-column)] flex-col gap-3 text-left">
      {rows.map((row) => (
        <QueuedMessage
          key={row.entry.id}
          row={row}
          onCancel={onCancel}
          onEdit={onEdit}
          onRetry={onRetry}
        />
      ))}
    </div>
  );
}

const UserMessage = memo(function UserMessage({
  environmentId,
  message,
  readStatus = null,
  onReply,
  onJump,
  tail = false,
}: {
  environmentId: EnvironmentId;
  message: ChatMessage;
  /** Only on the owner's latest message: whether the bot has taken it in yet. */
  readStatus?: MessageReadStatus | null;
  /** Reply on this message; absent where nothing can be sent (an archived chat). */
  onReply?: ((quote: PersonalReplyQuote) => void) | undefined;
  onJump?: ((messageId: string) => void) | undefined;
  /** The run's last message: the bubble takes the 6 px tail. */
  tail?: boolean;
}) {
  const quote = useMemo(() => readPersonalReplyQuote(message.context), [message.context]);
  const sentAt = useMemo(() => parseSentAt(message.createdAt), [message.createdAt]);
  const resources = useMemo(
    () => selectMessageImageResources(message.attachments),
    [message.attachments],
  );
  const urls = useAssetUrls(environmentId, resources);
  const [preview, setPreview] = useState<AttachmentPreviewData | null>(null);
  const imageIds = new Set(resources.map((resource) => resource.attachmentId));
  const files = (message.attachments ?? []).filter(
    (attachment) => !("id" in attachment) || !imageIds.has(String(attachment.id)),
  );
  return (
    <div className="flex flex-col items-end gap-1.5">
      <span className="sr-only">You said:</span>
      {resources.length > 0 ? (
        <div className="flex max-w-[78%] flex-wrap justify-end gap-1.5">
          {resources.map((resource, index) => {
            const url = urls[index];
            return url ? (
              <button
                type="button"
                key={resource.attachmentId}
                aria-label={`Open ${message.attachments?.find((item) => item.id === resource.attachmentId)?.name ?? "image"}`}
                onClick={() =>
                  setPreview({
                    type: "image",
                    name:
                      message.attachments?.find((item) => item.id === resource.attachmentId)
                        ?.name ?? "Image",
                    mimeType: "image/*",
                    sizeBytes: 0,
                    attachmentId: resource.attachmentId,
                    // The expanded view resolves nothing for a still image, so
                    // without the thumbnail's own signed URL every sent image
                    // opened as "Image unavailable".
                    imageUrl: url,
                  })
                }
                className="rounded-xl outline-none focus-visible:ring-2"
              >
                <img
                  src={url}
                  alt=""
                  className="size-24 rounded-xl border border-[var(--personal-border)] object-cover"
                />
              </button>
            ) : (
              <button
                type="button"
                key={resource.attachmentId}
                aria-label="Open image"
                onClick={() =>
                  setPreview({
                    type: "image",
                    name:
                      message.attachments?.find((item) => item.id === resource.attachmentId)
                        ?.name ?? "Image",
                    mimeType: "image/*",
                    sizeBytes: 0,
                    attachmentId: resource.attachmentId,
                  })
                }
                className="size-24 rounded-xl border border-[var(--personal-border)] bg-[var(--personal-fill-muted)]"
              />
            );
          })}
        </div>
      ) : null}
      {files.map((file) => (
        <button
          type="button"
          key={"id" in file ? String(file.id) : attachmentName(file)}
          disabled={!isFileAttachment(file)}
          onClick={() => {
            if (isFileAttachment(file)) setPreview({ ...file, attachmentId: file.id });
          }}
          aria-label={`Open ${attachmentName(file)}`}
          className="flex max-w-[78%] items-center gap-1.5 rounded-xl border border-[var(--personal-border)] bg-[var(--personal-surface)] px-3 py-2 text-sm text-[var(--personal-text)]"
        >
          <FileText aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.75} />
          <span className="truncate">{attachmentName(file)}</span>
        </button>
      ))}
      {preview && (
        <AttachmentPreview
          attachment={preview}
          environmentId={environmentId}
          onClose={() => setPreview(null)}
        />
      )}
      {message.text.trim().length > 0 ? (
        onReply === undefined ? (
          // Nothing can be sent here (an archived chat), so no menu, but the time still shows.
          sentAt === null ? (
            <UserBubble text={message.text} quote={quote} onJump={onJump} tail={tail} />
          ) : (
            <SwipeTimeRow sentAt={sentAt} align="end" className="max-w-[78%]">
              <UserBubble
                text={message.text}
                quote={quote}
                onJump={onJump}
                tail={tail}
                widthClass="max-w-full min-w-0"
              />
            </SwipeTimeRow>
          )
        ) : (
          <ReplyableMessage
            messageId={String(message.id)}
            quote={replyQuoteForMessage({ message, botName: "" })}
            copyText={message.text}
            onReply={onReply}
            align="end"
            sentAt={sentAt}
            className="max-w-[78%]"
          >
            <UserBubble
              text={message.text}
              quote={quote}
              onJump={onJump}
              tail={tail}
              widthClass="max-w-full min-w-0"
            />
          </ReplyableMessage>
        )
      ) : null}
      {readStatus !== null ? (
        // role="status" is a polite live region: "Queued" turning into "Read"
        // is announced without interrupting.
        <span role="status" className="text-xs text-[var(--personal-text-tertiary)]">
          {READ_STATUS_LABEL[readStatus]}
        </span>
      ) : null}
    </div>
  );
});

const AssistantMessage = memo(function AssistantMessage({
  message,
  threadRef,
  workspaceRoot,
  botName,
  onReply,
  choices,
  onChoose,
  variant = "full",
  tail = false,
}: {
  message: ChatMessage;
  threadRef: ScopedThreadRef;
  workspaceRoot: string | undefined;
  botName: string;
  /** Reply on this message; absent where nothing can be sent (an archived chat). */
  onReply?: ((quote: PersonalReplyQuote) => void) | undefined;
  /** Where the message's tap-to-answer block stands; null while it is not the kind that has one. */
  choices?: ChoicesState | null | undefined;
  onChoose?: ((text: string) => Promise<boolean>) | undefined;
  /** `bubble` for a short plain reply in a run (SPEC 2.8); `full` is the full-width reply. */
  variant?: "bubble" | "full";
  /** The run's last bubble: its bottom-left corner squares to 6 px. */
  tail?: boolean;
}) {
  const split = useMemo(
    () => (mayHaveChoices(message.text) ? splitChoices(message.text, message.streaming) : null),
    [message.streaming, message.text],
  );
  const sentAt = useMemo(() => parseSentAt(message.createdAt), [message.createdAt]);
  if (message.text.length === 0) return null;
  // Without a state to draw them in, a block is left as the code block it is.
  const hasState = choices !== null && choices !== undefined;
  const drawChoices = split !== null && hasState && split.options !== null;
  const heldBack = split !== null && split.options === null && split.body !== message.text;
  const body = split !== null && (drawChoices || heldBack) ? split.body : message.text;
  const options = drawChoices ? split.options : null;
  const bubble = variant === "bubble";
  const content = (
    <div
      className={cn(
        "personal-markdown min-w-0 text-[16px] text-[var(--personal-text)]",
        bubble
          ? cn(
              "max-w-full leading-[22px] rounded-[var(--personal-radius-xl)] bg-[var(--personal-surface)] px-3.5 py-2.5 [box-shadow:inset_0_0_0_1px_var(--personal-border)]",
              tail && TAIL_BOT,
            )
          : "w-full leading-[24px]",
      )}
    >
      <span className="sr-only">{botName} said:</span>
      {body.length > 0 ? (
        <ChatMarkdown
          text={body}
          cwd={workspaceRoot}
          threadRef={threadRef}
          isStreaming={message.streaming}
          lineBreaks={shouldPreserveAssistantLineBreaks(body)}
        />
      ) : null}
      {options !== null && hasState ? (
        <ChoiceButtons options={options} state={choices} botName={botName} onChoose={onChoose} />
      ) : null}
    </div>
  );
  if (message.streaming) return content;
  if (onReply === undefined) {
    // Nothing can be sent here (an archived chat), so no menu, but the time still shows.
    return sentAt === null ? (
      content
    ) : (
      <SwipeTimeRow sentAt={sentAt} align="start" {...(bubble ? { className: "max-w-[82%]" } : {})}>
        {content}
      </SwipeTimeRow>
    );
  }
  return (
    <ReplyableMessage
      messageId={String(message.id)}
      quote={replyQuoteForMessage({
        message: { id: message.id, role: message.role, text: body },
        botName,
      })}
      copyText={body}
      onReply={onReply}
      align="start"
      sentAt={sentAt}
      {...(bubble ? { className: "max-w-[82%]" } : {})}
    >
      {content}
    </ReplyableMessage>
  );
});

/** How a group transcript draws one of its members. */
export interface GroupSpeakerPresentation {
  readonly name: string;
  readonly avatarShape: BotAvatarShape;
  readonly avatarColor: string;
  /**
   * The member's own chat, when it has one. Tapping the name opens it — that
   * is where a member's tool activity, approvals and files live; the group
   * transcript is only what was said.
   */
  readonly threadId: string | null;
}

/**
 * One member speaking in a group. The avatar and bold name are the header; a
 * run of consecutive messages from the same member collapses to the text alone
 * (decided in `buildConversationItems`), so a long reply reads as one voice
 * rather than as the same bot introducing itself over and over.
 */
const GroupMessage = memo(function GroupMessage({
  message,
  threadRef,
  workspaceRoot,
  speaker,
  botId,
  showSpeaker,
  onReply,
  choices,
  onChoose,
}: {
  message: ChatMessage;
  threadRef: ScopedThreadRef;
  workspaceRoot: string | undefined;
  speaker: GroupSpeakerPresentation | null;
  botId: string;
  showSpeaker: boolean;
  onReply?: ((quote: PersonalReplyQuote) => void) | undefined;
  choices?: ChoicesState | null | undefined;
  onChoose?: ((text: string) => Promise<boolean>) | undefined;
}) {
  const name = speaker?.name ?? "A bot";
  return (
    <div className="flex flex-col gap-1">
      {showSpeaker ? (
        <div className="flex min-w-0 items-center gap-2">
          {speaker === null ? (
            <span
              aria-hidden="true"
              className="size-7 shrink-0 rounded-full bg-[var(--personal-fill-muted)]"
            />
          ) : (
            <BotAvatar
              shape={speaker.avatarShape}
              color={speaker.avatarColor}
              size={28}
              label={speaker.name}
            />
          )}
          {speaker !== null && speaker.threadId !== null ? (
            <Link
              to="/bots/$botId/$threadId"
              params={{ botId, threadId: speaker.threadId }}
              aria-label={`Open ${name}'s own chat`}
              className="min-w-0 truncate text-[13px] leading-5 font-semibold text-[var(--personal-text)] outline-none active:opacity-70 focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
            >
              {name}
            </Link>
          ) : (
            <span className="min-w-0 truncate text-[13px] leading-5 font-semibold text-[var(--personal-text)]">
              {name}
            </span>
          )}
        </div>
      ) : null}
      <AssistantMessage
        message={message}
        threadRef={threadRef}
        workspaceRoot={workspaceRoot}
        botName={name}
        onReply={onReply}
        choices={choices}
        onChoose={onChoose}
      />
    </div>
  );
});

/**
 * A turn the task service wrote in the user's role (delegated brief, results
 * coming back, routine run, retry): a compact centred row, not the user's
 * bubble. Tapping it shows the exact text the bot received.
 */
const SystemTurnRow = memo(function SystemTurnRow({
  label,
  text,
}: {
  label: string;
  text: string;
}) {
  return (
    <details className="group flex w-full flex-col items-center">
      <summary className="mx-auto flex min-h-11 max-w-[90%] cursor-pointer list-none items-center gap-1.5 rounded-full px-3 text-[13px] text-[var(--personal-text-secondary)] outline-none select-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden="true"
          className="size-3.5 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none"
          strokeWidth={1.75}
        />
        <span className="min-w-0 truncate">{label}</span>
      </summary>
      <p className="mx-auto mt-1 max-w-[90%] rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-surface)] px-3.5 py-2.5 text-[13px] leading-[1.45] break-words whitespace-pre-wrap text-[var(--personal-text-secondary)]">
        {text}
      </p>
    </details>
  );
});

function ApprovalCard({
  approval,
  botName,
  responding,
  onRespond,
}: {
  approval: PendingApproval;
  botName: string;
  responding: boolean;
  onRespond: (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => void;
}) {
  const options =
    approval.options && approval.options.length > 0 ? approval.options : DEFAULT_APPROVAL_OPTIONS;
  return (
    <section
      aria-label={`${botName} ${APPROVAL_KIND_LABEL[approval.requestKind]}`}
      className="rounded-[var(--personal-radius-card)] border border-[var(--personal-review-border)] bg-[var(--personal-review-bg)] p-3.5"
    >
      <p className="flex items-center gap-2 text-[15px] font-semibold text-[var(--personal-text)]">
        <span aria-hidden="true" className="size-2 rounded-full bg-[var(--personal-review)]" />
        {botName} {APPROVAL_KIND_LABEL[approval.requestKind]}
      </p>
      {approval.detail ? (
        <p className="mt-2 line-clamp-6 font-mono text-[13px] break-words whitespace-pre-wrap text-[var(--personal-text-secondary)]">
          {approval.detail}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {options.map((option) => (
          <button
            key={option.decision}
            type="button"
            disabled={responding}
            aria-description={option.warning}
            onClick={() => onRespond(approval.requestId, option.decision)}
            className={cn(
              "h-11 min-w-0 flex-1 rounded-[var(--personal-radius-button)] px-3 text-[15px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--personal-bg)] disabled:opacity-40",
              option.decision === "accept"
                ? "bg-[var(--personal-primary)] text-[var(--personal-primary-text)]"
                : "border border-[var(--personal-border)] bg-[var(--personal-surface)] text-[var(--personal-text)]",
            )}
          >
            <span className="block truncate">{option.label}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

const NO_PINNED_APPROVALS: ReadonlyArray<PendingApproval> = [];
const NO_QUEUED: ReadonlyArray<OutboxRow> = [];
const NO_ANSWERED_HERE: ReadonlySet<string> = new Set();

/**
 * Where each reply's tap-to-answer block stands, by item id (only replies that
 * have a well-formed one appear). A set stays open while nothing was said
 * after it; once the owner sent anything, it is used, and the option that
 * message repeats is marked as the pick. A set also waits while the chat
 * cannot take a message (`busy`).
 */
export function choicesStates(
  items: ReadonlyArray<ConversationItem>,
  busy: boolean,
): ReadonlyMap<string, ChoicesState> {
  const states = new Map<string, ChoicesState>();
  let laterOwnerText: string | null | undefined;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.kind !== "message" && item.kind !== "group-message") continue;
    if (item.message.role === "user") {
      laterOwnerText = item.message.text.trim();
      continue;
    }
    if (item.message.role !== "assistant" || !mayHaveChoices(item.message.text)) continue;
    const options = splitChoices(item.message.text).options;
    if (options === null) continue;
    states.set(
      item.id,
      laterOwnerText === undefined
        ? { kind: "open", disabled: busy }
        : { kind: "used", picked: options.find((option) => option === laterOwnerText) ?? null },
    );
  }
  return states;
}

/** Read-only cards keep their text for reading and VoiceOver; a disabled fieldset turns every control off. */
function lockCard(key: string, readOnly: boolean, card: ReactNode): ReactNode {
  if (!readOnly) return card;
  return (
    <fieldset key={key} disabled className="contents" data-read-only-card="">
      {card}
    </fieldset>
  );
}

/**
 * Chat rows (ui-spec Screen 2): dividers, right-aligned user bubbles, plain
 * markdown assistant text, collapsed tool activity, and the cards the bot put
 * in the conversation (questions, secrets, delegated work) in the order they
 * happened. Only approvals, which vanish when decided, sit below the
 * transcript. Owns the scroller: it follows new content while the reader is at
 * the bottom and leaves them alone once they scroll up; a window frozen at an
 * older message brings the later ones in by itself as the reader reaches its
 * end, so the newest are never behind a tap.
 */
export function MessageList({
  environmentId,
  threadRef,
  items,
  pending,
  queued = NO_QUEUED,
  onCancelQueued,
  onEditQueued,
  onRetryQueued,
  latestMessageStatus = null,
  working,
  botName,
  botFace = null,
  workspaceRoot,
  approvals,
  respondingIds,
  onRespondToApproval,
  onAnswerQuestion,
  onDismissQuestion,
  onProvideSecret,
  onDeclineSecret,
  onProvideLogin,
  onCancelLogin,
  onDecideConnectionApproval,
  approvalRespondingIds,
  onDecideLeadBotChange,
  leadBotChangeRespondingIds,
  onDecideMemoryChange,
  memoryChangeRespondingIds,
  memoryBotName,
  approvalsNowMs,
  errorText,
  errorDetail = null,
  errorTone = "danger",
  errorRetry = null,
  loadEarlier,
  now,
  describeTurn,
  renderDelegation,
  groupSpeaker,
  readOnly = false,
  showContextUsed = false,
  onReply,
  onChoose,
  choicesBusy = false,
  dockQuestions = false,
  answeredHere = NO_ANSWERED_HERE,
  landingItemId = null,
}: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  items: ReadonlyArray<ConversationItem>;
  /** One-line text for a server-authored turn ("Developer finished: ..."). */
  describeTurn: (turn: ServerTurn) => string;
  /** The live card for a task delegated from this thread. */
  renderDelegation: (task: PersonalTask) => ReactNode;
  /**
   * How to draw a group member. Only a group transcript passes it; without it
   * no `group-message` item can exist, because only a group conversation asks
   * `buildConversationItems` to read the markers.
   */
  groupSpeaker?: (botId: string) => GroupSpeakerPresentation | null;
  pending: ReadonlyArray<PendingOutgoingMessage>;
  /**
   * Messages typed while the laptop was away, still on this device (the send
   * queue, `outbox.ts`). Drawn after the transcript with their own state and
   * Edit/Cancel/Retry; a screen without a queue leaves them out.
   */
  queued?: ReadonlyArray<OutboxRow>;
  onCancelQueued?: ((id: string) => void) | undefined;
  onEditQueued?: ((entry: OutboxEntry) => void) | undefined;
  onRetryQueued?: ((id: string) => void) | undefined;
  /** "Queued"/"Read" under the owner's latest message; a bot chat passes it, a group does not. */
  latestMessageStatus?: LatestMessageReadStatus | null;
  working: boolean;
  botName: string;
  /**
   * The bot's face for the run avatars and the full-width replies' sender row
   * (SPEC 2.8). Null draws a plain circle (a chat with no bot record yet).
   */
  botFace?: { readonly shape: BotAvatarShape; readonly color: string } | null;
  workspaceRoot: string | undefined;
  /**
   * Requests blocking the running turn. Unlike questions and secrets, an
   * approval leaves no record once decided, so it is pinned below the
   * transcript rather than placed in it.
   */
  approvals: ReadonlyArray<PendingApproval>;
  respondingIds: ReadonlySet<string>;
  onRespondToApproval: (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => void;
  onAnswerQuestion: (requestId: string, answers: UserInputAnswers) => void;
  onDismissQuestion: (requestId: string) => void;
  /** The value goes straight to the fulfil RPC; nothing here stores it. */
  onProvideSecret: ProvideSecret;
  onDeclineSecret: (requestId: string) => void;
  onProvideLogin?: ProvideLogin;
  onCancelLogin?: (requestId: string) => void;
  onDecideConnectionApproval: (approvalId: string, decision: "approved" | "denied") => void;
  approvalRespondingIds: ReadonlySet<string>;
  /** One-to-one chat only. Resolves to an error message for the card, or null. */
  onDecideLeadBotChange?: (
    changeId: string,
    changeHash: string,
    decision: "approved" | "declined",
  ) => Promise<string | null>;
  leadBotChangeRespondingIds?: ReadonlySet<string>;
  /** One-to-one chat only: a bot's memory save or forget. Resolves to an error message, or null. */
  onDecideMemoryChange?: (
    changeId: number,
    changeHash: string,
    approve: boolean,
  ) => Promise<string | null>;
  memoryChangeRespondingIds?: ReadonlySet<number>;
  /** Bot names for the memory cards' headers. */
  memoryBotName?: (botId: string) => string | undefined;
  /** Passed in rather than read here so a card cannot re-render itself live past its expiry. */
  approvalsNowMs: number;
  errorText: string | null;
  /** The provider's own line, shown behind a "Details" toggle under `errorText`. */
  errorDetail?: string | null;
  /**
   * `info` for a retry the server is running by itself: a neutral notice, not
   * a failure, so it is not an alert and offers nothing to press.
   */
  errorTone?: "danger" | "info";
  /** Retry for the failed message; hidden when null. Disabled while `busy`. */
  errorRetry?: { readonly onRetry: () => void; readonly busy: boolean } | null;
  loadEarlier: { readonly loading: boolean; readonly onLoad: () => void } | null;
  now: Date;
  /**
   * An archived chat: every card still reads as it did, but none can be
   * answered (a reply would start a turn), and pinned approvals are hidden.
   */
  readOnly?: boolean;
  /**
   * A one-to-one bot chat: under the last reply of each turn, a tucked-away
   * "Context used" line shows which rules and notes the turn was given.
   */
  showContextUsed?: boolean;
  /** Reply on a message (the screen puts the quote in its composer); absent: no Reply. */
  onReply?: ((quote: PersonalReplyQuote) => void) | undefined;
  /** Sends a tapped choice as the owner's message; resolves true once it was sent. */
  onChoose?: ((text: string) => Promise<boolean>) | undefined;
  /** The chat cannot take a message now (the bot is busy, offline, ...): open choices wait. */
  choicesBusy?: boolean;
  /**
   * The transcript row the chat opened at (D13): a request card from the
   * `?request=` deep link or the chat's own open request. The list pages the
   * row into its window if it has to, lands on it without an animated scroll
   * and washes it.
   */
  landingItemId?: string | null;
  /**
   * The 1:1 chat passes true: an open question is drawn in the dock above the
   * composer, not in the thread (SPEC 2.9). Groups keep the card inline.
   */
  dockQuestions?: boolean;
  /** Request ids this page has answered: those show the settled card, not the receipt. */
  answeredHere?: ReadonlySet<string>;
}): JSX.Element {
  const choicesById = useMemo(() => choicesStates(items, choicesBusy), [items, choicesBusy]);
  const turnStarts = useMemo(
    () => (showContextUsed ? turnStartByAssistantItem(items) : new Map<string, string>()),
    [items, showContextUsed],
  );
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set while a tap's smooth scroll is on its way down: its own scroll events
  // are still far from the bottom and must not bring the button back.
  const jumpingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const quoteSettleRef = useRef<number | null>(null);
  // Only the reader's own scrolling lets go of the bottom. A finger, the
  // mouse on the scrollbar, a wheel or a key marks the scroll as theirs.
  const readerRef = useRef({ holding: false, at: Number.NEGATIVE_INFINITY });
  // Taken when the page goes hidden: the thread and newest item the reader
  // left behind, so the return can tell items that arrived while away from
  // old news. `until` is 0 while the page is still away (only the visible
  // event may spend the marker) and becomes the end of the catch-up window
  // (AWAY_CATCH_UP_MS) when it comes back.
  const awayRef = useRef<{ threadId: string; lastId: string | null; until: number } | null>(null);
  const threadId = threadRef.threadId;
  const [page, setPage] = useState<{ threadId: string; firstId: string | null }>({
    threadId,
    firstId: null,
  });
  const firstId = page.threadId === threadId ? page.firstId : null;
  const range = transcriptRange(items, firstId);
  const visibleItems = items.slice(range.start, range.end);
  const windowRef = useRef({ threadId, range, items, firstId });
  useLayoutEffect(() => {
    windowRef.current = { threadId, range, items, firstId };
  });
  const anchorRef = useRef<{ id: string; top: number } | null>(null);
  const targetRef = useRef<string | null>(null);
  const targetGuardRef = useRef(false);
  const selectionRef = useRef(false);
  const saveAnchor = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const top = scroller.getBoundingClientRect?.().top ?? 0;
    const rows = contentRef.current?.querySelectorAll<HTMLElement>("[data-transcript-row]");
    const row =
      rows && Array.from(rows).find((element) => element.getBoundingClientRect().bottom > top);
    if (row)
      anchorRef.current = { id: row.dataset.transcriptRow!, top: row.getBoundingClientRect().top };
  };
  const movePage = (direction: -1 | 1) => {
    // A selected passage keeps its DOM while the reader copies it.
    if (window.getSelection?.()?.isCollapsed === false) return;
    const current = windowRef.current;
    saveAnchor();
    stickRef.current = false;
    const start = Math.max(
      0,
      Math.min(
        current.items.length - TRANSCRIPT_WINDOW_SIZE,
        current.range.start + direction * TRANSCRIPT_WINDOW_STEP,
      ),
    );
    const first = current.items[start]?.id ?? null;
    setPage((previous) =>
      previous.threadId === current.threadId && previous.firstId === first
        ? previous
        : { threadId: current.threadId, firstId: first },
    );
  };
  const jumpToQuoted = (messageId: string) => {
    const index = items.findIndex(
      (item) => "message" in item && String(item.message.id) === messageId,
    );
    targetGuardRef.current = true;
    stickRef.current = false;
    const settlingLatest = jumpingRef.current !== null;
    // A quote supersedes the native smooth latest scroll as well as its timer.
    // Otherwise that animation can move the target away after it has landed.
    endJump();
    cancelShow();
    anchorRef.current = null;
    const scroller = scrollerRef.current;
    scroller?.scrollTo({ top: scroller.scrollTop, behavior: "instant" });
    targetRef.current = messageId;
    if (index >= 0 && (index < range.start || index >= range.end)) {
      setPage({ threadId, firstId: items[Math.max(0, index - TRANSCRIPT_WINDOW_STEP)]!.id });
    } else if (jumpToMessage(contentRef.current ?? document, messageId)) {
      targetRef.current = null;
      clearMessageJump(threadId);
      setShowJump(true);
    } else {
      targetRef.current = null;
      targetGuardRef.current = false;
      stickRef.current = true;
    }
    // Chromium can deliver a queued smooth-scroll offset after the instant
    // cancellation. Reassert the new target next frame, unless another intent
    // has superseded it; endJump cancels this work too.
    if (settlingLatest) {
      quoteSettleRef.current =
        window.requestAnimationFrame?.(() => {
          quoteSettleRef.current = null;
          if (targetGuardRef.current && !selectionRef.current)
            jumpToMessage(contentRef.current ?? document, messageId);
        }) ?? null;
    }
  };
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    anchorRef.current = null;
    if (anchor && scrollerRef.current) {
      const row = Array.from(
        contentRef.current?.querySelectorAll<HTMLElement>("[data-transcript-row]") ?? [],
      ).find((element) => element.dataset.transcriptRow === anchor.id);
      if (row) scrollerRef.current.scrollTop += row.getBoundingClientRect().top - anchor.top;
    }
    if (targetRef.current && jumpToMessage(contentRef.current ?? document, targetRef.current)) {
      targetRef.current = null;
      clearMessageJump(threadId);
      setShowJump(true);
    }
    if (stickRef.current && firstId === null && scrollerRef.current) {
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
      return;
    }
    // Items arriving just after a return from hidden (the reconnect's missed
    // ones) land on the latest; while the page is still away the marker holds
    // (until is 0) and the visible event owns the first look.
    if (landOnNewSinceAway()) return;
    // A frozen window whose reader is sitting at the end of what it loaded
    // takes the next step before the frame paints, so later messages arrive
    // without a tap and the fallback button below never has to be pressed.
    if (firstId !== null) catchUpAtWindowEnd();
  }, [items, firstId, threadId]);

  const cancelShow = () => {
    if (showTimerRef.current !== null) clearTimeout(showTimerRef.current);
    showTimerRef.current = null;
  };
  const endJump = () => {
    if (jumpingRef.current !== null) clearTimeout(jumpingRef.current);
    jumpingRef.current = null;
    if (quoteSettleRef.current !== null) window.cancelAnimationFrame(quoteSettleRef.current);
    quoteSettleRef.current = null;
  };

  /** Back on the newest: the latest window, following whatever arrives next. */
  const pinToLatest = () => {
    const current = windowRef.current;
    endJump();
    stickRef.current = true;
    setPage((previous) =>
      previous.threadId === current.threadId && previous.firstId === null
        ? previous
        : { threadId: current.threadId, firstId: null },
    );
    cancelShow();
    setShowJump(false);
  };

  /**
   * The reader has reached the end of what a frozen window has loaded. Take
   * the next step now instead of waiting for a tap: the later messages are
   * brought in (movePage anchors on the first visible row, so the reader's
   * place does not move), and once the window covers the newest items and the
   * reader is still at its end, the transcript pins and follows again.
   */
  const catchUpAtWindowEnd = () => {
    const scroller = scrollerRef.current;
    if (scroller === null || scroller.clientHeight === 0) return;
    if (targetGuardRef.current || selectionRef.current) return;
    const fromEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (fromEnd >= STICK_THRESHOLD_PX) return;
    const current = windowRef.current;
    if (current.range.end < current.items.length) {
      movePage(1);
      return;
    }
    if (current.firstId !== null) pinToLatest();
  };

  /**
   * The reader was away and the newest item changed since they left: the
   * newest are what they came back for, so land on them, pinned. Nothing new:
   * their place is kept, so a long read is not interrupted by a phone lock. A
   * held selection or a jump to a quoted message in flight wins over it, like
   * every other move.
   */
  const landOnNewSinceAway = (): boolean => {
    const away = awayRef.current;
    if (away === null || stickRef.current) return false;
    const current = windowRef.current;
    if (current.threadId !== away.threadId) {
      awayRef.current = null;
      return false;
    }
    // 0 means the page is still away: the visible event owns the first look,
    // and the marker must not be spent before it.
    if (away.until === 0) return false;
    if (Date.now() >= away.until) {
      awayRef.current = null;
      return false;
    }
    const newestId = current.items[current.items.length - 1]?.id ?? null;
    if (newestId === away.lastId) return false;
    awayRef.current = null;
    if (targetGuardRef.current || selectionRef.current) return false;
    const frozen = current.firstId !== null;
    pinToLatest();
    // A frozen window re-renders into the latest one, whose layout effect pins
    // (a direct write here would race the window swap). An already-latest
    // window has no state change to hang that on: the one write is the pin,
    // and the scroll event it raises reads a window that still ends at the
    // newest items, so it settles as pinned with no jump button.
    if (!frozen && scrollerRef.current !== null) {
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
    }
    return true;
  };

  useEffect(() => {
    const scroller = scrollerRef.current;
    const content = contentRef.current;
    if (scroller === null || content === null) return;
    // The sizes the last scroll or resize saw, to tell a layout change (a strip
    // appearing, the keyboard, a reply growing) from the reader scrolling.
    let seen = { scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
    const remember = () => {
      seen = {
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
      };
    };
    const follow = () => {
      if (stickRef.current) scroller.scrollTop = scroller.scrollHeight;
      remember();
    };
    // When the list grows taller while it sits at its end (the iPhone keyboard
    // going down), WebKit can keep drawing the old scroll offset: the latest
    // message stays where it was and a keyboard-sized blank band fills the
    // bottom until the next touch (26 Sep screenshot). Writing a different
    // offset first turns the write into a real scroll, which WebKit applies.
    const reassertEnd = () => {
      const end = scroller.scrollHeight - scroller.clientHeight;
      if (end <= 0 || scroller.scrollTop < end - 1) return;
      scroller.scrollTop = end - 1;
      scroller.scrollTop = scroller.scrollHeight;
      remember();
    };
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    // Kept apart from `seen`: a scroll event can land before the resize and
    // record the new height first.
    let observedHeight = scroller.clientHeight;
    const armSettle = () => {
      // Once more after the keyboard has finished moving.
      if (settleTimer !== null) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        follow();
        if (stickRef.current) reassertEnd();
      }, VIEWPORT_SETTLE_MS);
    };
    // Every size change re-pins in one write. A typed line grows the composer
    // about 22px and shrinks this scroller by the same: the instant follow is
    // what Harout's phone A/B settled on (1.66.27). The 1.66.23 glide to that
    // new bottom moved the transcript 22px over ~170ms and was the jump he
    // reported, so it is gone.
    const onResize = () => {
      const clientHeight = scroller.clientHeight;
      const grew = clientHeight > observedHeight;
      observedHeight = clientHeight;
      follow();
      if (!grew) return;
      if (stickRef.current) reassertEnd();
      armSettle();
    };
    follow();
    const readerActive = () =>
      readerRef.current.holding || Date.now() - readerRef.current.at < READER_INPUT_MS;
    const onScroll = () => {
      const nearBottom =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < STICK_THRESHOLD_PX;
      const movedUp = scroller.scrollTop < seen.scrollTop;
      const resized =
        scroller.scrollHeight !== seen.scrollHeight || scroller.clientHeight !== seen.clientHeight;
      remember();
      if (targetGuardRef.current || selectionRef.current) return;
      if (nearBottom) {
        // At the end of what is loaded, with the newest items in it: pin and follow.
        if (windowRef.current.range.end === windowRef.current.items.length) {
          pinToLatest();
          return;
        }
        // A frozen window with newer items beyond it: reaching its end brings
        // the next step in, without a tap.
        if (jumpingRef.current === null) catchUpAtWindowEnd();
        return;
      }
      if (jumpingRef.current !== null) return;
      // The browser can report a resize's scroll before the resize itself: a
      // late strip shrinking the list once left a chat opening short of its
      // latest message. Only the reader moving up lets go of the bottom; a
      // layout change leaves the list where it was, so stay pinned.
      if (stickRef.current && (!movedUp || (resized && !readerActive()))) {
        follow();
        return;
      }
      stickRef.current = false;
      const current = windowRef.current;
      const first = current.items[current.range.start]?.id ?? null;
      setPage((previous) =>
        previous.threadId === current.threadId && previous.firstId === first
          ? previous
          : { threadId: current.threadId, firstId: first },
      );
      // Every scroll event restarts the wait, so momentum scrolling does not
      // make the button flicker; it appears once the list settles.
      cancelShow();
      showTimerRef.current = setTimeout(() => {
        showTimerRef.current = null;
        setShowJump(true);
      }, JUMP_TO_LATEST_DELAY_MS);
    };
    const onReaderInput = () => {
      readerRef.current.at = Date.now();
      // The reader is here and reading: a catch-up window left over from a
      // return from hidden ends now, and old news stays old news.
      awayRef.current = null;
      targetGuardRef.current = false;
      targetRef.current = null;
      clearMessageJump(windowRef.current.threadId);
      if (jumpingRef.current === null) return;
      // A finger, wheel or key during a jump stops it where it is. The
      // browser's own smooth scroll carries on to the bottom unless stopped.
      endJump();
      scroller.scrollTo({ top: scroller.scrollTop, behavior: "instant" });
      stickRef.current = false;
      onScroll();
    };
    const onHold = () => {
      readerRef.current.holding = true;
      onReaderInput();
    };
    const onRelease = () => {
      if (!readerRef.current.holding) return;
      readerRef.current.holding = false;
      readerRef.current.at = Date.now();
    };
    // Only the scrollbar itself: a click on a card in the list is not a scroll.
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === "mouse" && event.target === scroller) onHold();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key) && !isEditable(event.target)) onReaderInput();
    };
    // Back from the lock screen or another app. A chat that was showing the
    // latest settles at the end even if iOS kept drawing the old offset while
    // it was away; a frozen window whose reader is sitting at its end takes
    // the next step like any scroll. A reader up in history keeps their place
    // unless items arrived while they were away (Harout's rule, 2026-10-11:
    // "Jump to latest when I come back"): those land on the latest, pinned,
    // and the catch-up window stays armed briefly because the reconnect that
    // brings them can land just after this event.
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        const current = windowRef.current;
        awayRef.current = {
          threadId: current.threadId,
          lastId: current.items[current.items.length - 1]?.id ?? null,
          until: 0,
        };
        return;
      }
      const away = awayRef.current;
      if (stickRef.current) {
        awayRef.current = null;
        follow();
        reassertEnd();
        return;
      }
      awayRef.current =
        away === null || away.threadId !== windowRef.current.threadId
          ? null
          : { ...away, until: Date.now() + AWAY_CATCH_UP_MS };
      if (awayRef.current !== null && landOnNewSinceAway()) return;
      catchUpAtWindowEnd();
    };
    const onSelection = () => {
      const selection = window.getSelection?.();
      selectionRef.current =
        !!selection && !selection.isCollapsed && content.contains(selection.anchorNode);
      if (!selectionRef.current) return;
      stickRef.current = false;
      const current = windowRef.current;
      const first = current.items[current.range.start]?.id ?? null;
      setPage((previous) =>
        previous.threadId === current.threadId && previous.firstId === first
          ? previous
          : { threadId: current.threadId, firstId: first },
      );
    };
    document.addEventListener?.("selectionchange", onSelection);
    document.addEventListener?.("visibilitychange", onVisibilityChange);
    scroller.addEventListener("scroll", onScroll, { passive: true });
    scroller.addEventListener("touchstart", onHold, { passive: true });
    scroller.addEventListener("wheel", onReaderInput, { passive: true });
    scroller.addEventListener("pointerdown", onPointerDown, { passive: true });
    window.addEventListener("touchend", onRelease, { passive: true });
    window.addEventListener("touchcancel", onRelease, { passive: true });
    window.addEventListener("pointerup", onRelease, { passive: true });
    window.addEventListener("keydown", onKeyDown);
    // Streaming text, late images and the keyboard all change heights without
    // a React update here, so follow size changes rather than renders.
    const observer = new ResizeObserver(onResize);
    observer.observe(content);
    observer.observe(scroller);
    return () => {
      if (settleTimer !== null) clearTimeout(settleTimer);
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener("touchstart", onHold);
      scroller.removeEventListener("wheel", onReaderInput);
      scroller.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("touchend", onRelease);
      window.removeEventListener("touchcancel", onRelease);
      window.removeEventListener("pointerup", onRelease);
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener?.("selectionchange", onSelection);
      document.removeEventListener?.("visibilitychange", onVisibilityChange);
      observer.disconnect();
      cancelShow();
      endJump();
    };
  }, []);

  // The screen stays mounted when the route moves to another chat, so the
  // next chat opens at its latest message with the button hidden.
  useEffect(() => {
    cancelShow();
    endJump();
    targetGuardRef.current = false;
    targetRef.current = null;
    selectionRef.current = false;
    awayRef.current = null;
    stickRef.current = true;
    // A tap that opened this chat from inside the last one is not a scroll here.
    readerRef.current = { holding: false, at: Number.NEGATIVE_INFINITY };
    setShowJump(false);
    const scroller = scrollerRef.current;
    if (scroller !== null) scroller.scrollTop = scroller.scrollHeight;
  }, [threadId]);

  // Sending is the reader asking for the newest: a new outgoing message (typed
  // now, or one going out from the offline queue) opens the latest window,
  // pinned, whatever the transcript was showing, so the sent message and the
  // reply that follows are on screen. A selected passage keeps its DOM, like
  // every other move.
  const sentRef = useRef({ threadId, count: pending.length + queued.length });
  useEffect(() => {
    const count = pending.length + queued.length;
    const sent = sentRef.current.threadId === threadId && count > sentRef.current.count;
    sentRef.current = { threadId, count };
    if (!sent) return;
    if (window.getSelection?.()?.isCollapsed === false) return;
    endJump();
    cancelShow();
    targetGuardRef.current = false;
    targetRef.current = null;
    setShowJump(false);
    stickRef.current = true;
    setPage({ threadId, firstId: null });
    const scroller = scrollerRef.current;
    if (scroller !== null) scroller.scrollTop = scroller.scrollHeight;
  }, [pending.length, queued.length, threadId]);

  // A tap on a message search hit asked for this chat to open on that message.
  // The thread loads progressively, so this tries again whenever the items
  // change, until the message is there or the request lapses.
  useEffect(() => {
    const messageId = peekMessageJump(threadId);
    if (messageId === null) return;
    jumpToQuoted(messageId);
    // `items` is the trigger: a thread that loads in pages may bring the message later.
  }, [threadId, items]);

  // D13: the chat opened at a request. The card is paged into the window if it
  // has to be, then landed on at once - no long animated scroll - and washed.
  // A question docked above the composer has no node here: it is already on
  // screen, and the dock does its own wash.
  const landingKey = landingItemId === null ? null : `${threadId}:${landingItemId}`;
  const landedRef = useRef<string | null>(null);
  useEffect(() => {
    if (landingKey === null || landingItemId === null) {
      landedRef.current = null;
      return;
    }
    if (landedRef.current === landingKey) return;
    const index = items.findIndex((item) => item.id === landingItemId);
    if (index >= 0 && (index < range.start || index >= range.end)) {
      stickRef.current = false;
      setPage({ threadId, firstId: items[Math.max(0, index - TRANSCRIPT_WINDOW_STEP)]!.id });
      return;
    }
    landedRef.current = landingKey;
    const node = contentRef.current?.querySelector<HTMLElement>(
      `[data-transcript-row="${landingItemId}"]`,
    );
    if (node === null || node === undefined) return;
    // A card already on screen - the usual case, where the request is the
    // newest thing said - leaves the chat where it opened: latest messages
    // shown, as ever. Only a card the bottom would hide moves the reader, and
    // then the reader stays there (no following) until they ask for latest.
    const scroller = scrollerRef.current;
    if (scroller !== null && typeof node.getBoundingClientRect === "function") {
      const card = node.getBoundingClientRect();
      const view = scroller.getBoundingClientRect();
      if (card.top < view.top || card.bottom > view.bottom) {
        stickRef.current = false;
        node.scrollIntoView({ block: "center", behavior: "instant" });
      }
    }
    node.setAttribute(REQUEST_WASH_ATTRIBUTE, "");
    window.setTimeout(() => node.removeAttribute(REQUEST_WASH_ATTRIBUTE), REQUEST_WASH_MS);
  }, [landingKey, landingItemId, items, range.start, range.end, threadId]);

  const jumpToLatest = () => {
    const scroller = scrollerRef.current;
    if (scroller === null) return;
    cancelShow();
    setShowJump(false);
    // Following resumes now, so a reply landing mid-scroll is followed too.
    stickRef.current = true;
    targetGuardRef.current = false;
    targetRef.current = null;
    clearMessageJump(threadId);
    setPage({ threadId, firstId: null });
    endJump();
    jumpingRef.current = setTimeout(endJump, JUMP_SETTLE_MS);
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: reduceMotion ? "auto" : "smooth" });
  };

  // The work group that is still being written: the last one, while working,
  // with no user message or task turn after it.
  const liveWorkId = useMemo(() => {
    if (!working) return null;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index]!;
      if (item.kind === "system-turn") return null;
      if (item.kind === "notice" && isServerTurnNotice(item.notice)) return null;
      if (item.kind === "message" && item.message.role === "user") return null;
      if (item.kind === "work") return item.id;
    }
    return null;
  }, [items, working]);

  const empty = items.length === 0 && pending.length === 0 && queued.length === 0;

  // The thread's rows (SPEC 2.8): runs of back-to-back bubbles and the
  // full-width blocks, with the divider's minute rule already applied.
  const rows = useMemo(
    () => buildTranscriptRows(visibleItems, { hasChoices: (id) => choicesById.has(id) }),
    [visibleItems, choicesById],
  );

  /** The spacing between two rows: 8 above a divider, 24 before a full-width reply (16 after the same bot's run), 16 otherwise. */
  const rowTopClass = (row: TranscriptRow, previous: TranscriptRow | null): string => {
    if (previous === null) return "";
    if (row.kind === "block" && row.item.kind === "divider") return "mt-2";
    if (row.kind === "block" && row.item.kind === "message") {
      return previous.kind === "run" && previous.sender === "bot" ? "mt-4" : "mt-6";
    }
    return "mt-4";
  };

  /** The full-width reply's sender row: the bot's 28 px avatar and its name. */
  const botSenderRow = (): ReactNode => (
    <div className="mb-2 flex h-7 min-w-0 items-center gap-2">
      {botFace === null ? (
        <span
          aria-hidden="true"
          className="size-7 shrink-0 rounded-full bg-[var(--personal-fill-muted)]"
        />
      ) : (
        <BotAvatar shape={botFace.shape} color={botFace.color} size={28} label={botName} />
      )}
      <span className="min-w-0 truncate text-[15px] leading-5 font-semibold text-[var(--personal-text)]">
        {botName}
      </span>
    </div>
  );

  /** One run of bubbles: 4 px inside, one time under the last bubble, the bot's avatar at its bottom-left. */
  const renderRun = (row: TranscriptRunRow): ReactNode => {
    const last = row.items[row.items.length - 1];
    const lastAt = last === undefined ? null : parseSentAt(last.message.createdAt);
    const hasTime = !row.timeSuppressed && lastAt !== null;
    const runTime = TIME_PER_RUN && hasTime ? lastAt : null;
    return (
      <>
        {row.items.map((item, index) => {
          const lastOfRun = index === row.items.length - 1;
          const at = parseSentAt(item.message.createdAt);
          const messageTime = !TIME_PER_RUN && !row.timeSuppressed && at !== null ? at : null;
          return (
            <Fragment key={item.id}>
              {row.sender === "user" ? (
                <UserMessage
                  environmentId={environmentId}
                  message={item.message}
                  readStatus={
                    latestMessageStatus?.messageId === String(item.message.id)
                      ? latestMessageStatus.status
                      : null
                  }
                  onReply={onReply}
                  onJump={jumpToQuoted}
                  tail={lastOfRun}
                />
              ) : (
                <AssistantMessage
                  message={item.message}
                  threadRef={threadRef}
                  workspaceRoot={workspaceRoot}
                  botName={botName}
                  onReply={onReply}
                  choices={choicesById.get(item.id)}
                  onChoose={onChoose}
                  variant="bubble"
                  tail={lastOfRun}
                />
              )}
              {messageTime !== null ? (
                <RunTime
                  at={messageTime}
                  align={row.sender === "user" ? "end" : "start"}
                  now={now}
                />
              ) : null}
            </Fragment>
          );
        })}
        {runTime !== null ? (
          <RunTime at={runTime} align={row.sender === "user" ? "end" : "start"} now={now} />
        ) : null}
        {row.sender === "bot" && botFace !== null ? (
          <span
            aria-hidden="true"
            className={cn("absolute left-0", hasTime ? "bottom-5" : "bottom-0")}
          >
            <BotAvatar shape={botFace.shape} color={botFace.color} size={28} label={botName} />
          </span>
        ) : null}
      </>
    );
  };
  // A chat chip switch eases the new transcript in (chatChipHandoff.ts).
  const [enterClass] = useState(() => (consumeChatSwitched() ? "personal-chat-enter" : undefined));

  return (
    // The jump button floats over the transcript's bottom edge, just above the
    // composer and any strip resting on it, so it never shifts the layout and
    // rides up with the keyboard.
    <div className={cn("relative flex min-h-0 flex-1 flex-col", enterClass)}>
      {/* `relative`: the scroller must be the containing block of the
          sr-only speaker labels (absolute). Otherwise they escape it, sit at
          their place deep in a long transcript and make the page column
          above the chat scrollable, so the whole chat drags up off screen. */}
      <div
        ref={scrollerRef}
        className="personal-column personal-scroll-quiet personal-thread-fade relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-4"
      >
        <div
          ref={contentRef}
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          aria-label={`Chat with ${botName}`}
          className="flex min-h-full flex-col justify-end py-3"
        >
          {range.start > 0 || loadEarlier !== null ? (
            <button
              type="button"
              onClick={range.start > 0 ? () => movePage(-1) : loadEarlier?.onLoad}
              disabled={range.start === 0 && loadEarlier?.loading}
              aria-busy={range.start === 0 && loadEarlier?.loading}
              className="mx-auto h-11 rounded-full px-4 text-sm font-medium text-[var(--personal-text-secondary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40"
            >
              {range.start === 0 && loadEarlier?.loading
                ? "Loading earlier messages"
                : "Load earlier messages"}
            </button>
          ) : null}

          {empty ? (
            <p className="my-auto text-center text-[15px] text-[var(--personal-text-secondary)]">
              {readOnly ? "No messages in this chat." : `Send ${botName} a message to get started.`}
            </p>
          ) : null}

          {rows.map((row, index) => {
            const previous = index === 0 ? undefined : rows[index - 1];
            if (row.kind === "run") {
              return (
                <div
                  key={row.id}
                  data-transcript-row={row.id}
                  className={cn(
                    "min-w-0",
                    rowTopClass(row, previous ?? null),
                    row.sender === "user"
                      ? "flex flex-col items-end gap-1"
                      : "relative flex flex-col items-start gap-1 pl-9",
                  )}
                >
                  {renderRun(row)}
                </div>
              );
            }
            const item = row.item;
            return (
              <div
                key={row.id}
                data-transcript-row={row.id}
                className={cn("flex min-w-0 flex-col", rowTopClass(row, previous ?? null))}
              >
                {(() => {
                  switch (item.kind) {
                    case "divider":
                      return (
                        <p
                          key={item.id}
                          className="text-center text-[13px] leading-4 font-semibold text-[var(--personal-text-tertiary)]"
                        >
                          <time dateTime={item.at.toISOString()}>
                            {formatDayDivider(item.at, now)}
                          </time>
                        </p>
                      );
                    case "system-turn":
                      return (
                        <SystemTurnRow
                          key={item.id}
                          label={describeTurn(item.turn)}
                          text={item.message.text}
                        />
                      );
                    case "group-message":
                      if (readGroupMarker(item.message)?.phase === "discussion") {
                        return (
                          <details
                            key={item.id}
                            className="rounded-xl border border-[var(--personal-border)] px-3 py-2"
                          >
                            <summary className="cursor-pointer text-sm text-[var(--personal-text-secondary)]">
                              {item.speaker.name} ·{" "}
                              {item.message.streaming ? "Researching…" : "View contribution"}
                            </summary>
                            <GroupMessage
                              message={item.message}
                              threadRef={threadRef}
                              workspaceRoot={workspaceRoot}
                              speaker={groupSpeaker?.(item.speaker.botId) ?? null}
                              botId={item.speaker.botId}
                              showSpeaker={false}
                              onReply={onReply}
                              choices={choicesById.get(item.id)}
                              onChoose={onChoose}
                            />
                          </details>
                        );
                      }
                      {
                        // The verdict speaks for the whole group, so it is headed as
                        // the group's answer; its writer is only credited, not shown
                        // as the speaker.
                        const isVerdict = readGroupMarker(item.message)?.phase === "verdict";
                        return (
                          <div key={item.id}>
                            {isVerdict && (
                              <div className="mb-2">
                                <p className="text-base font-semibold text-[var(--personal-text)]">
                                  Group verdict
                                </p>
                                <p className="text-[13px] text-[var(--personal-text-secondary)]">
                                  From the whole group · written up by {item.speaker.name}
                                </p>
                              </div>
                            )}
                            <GroupMessage
                              key={item.id}
                              message={item.message}
                              threadRef={threadRef}
                              workspaceRoot={workspaceRoot}
                              speaker={groupSpeaker?.(item.speaker.botId) ?? null}
                              botId={item.speaker.botId}
                              showSpeaker={isVerdict ? false : item.showSpeaker}
                              onReply={onReply}
                              choices={choicesById.get(item.id)}
                              onChoose={onChoose}
                            />
                          </div>
                        );
                      }
                    case "notice": {
                      // The continue shows the prompt the bot got when tapped, like
                      // any server-written turn; the pause is a plain line; a note a
                      // bot saved or forgot on its own offers Undo.
                      const noteUndo = chatNoticeUndo(item.notice);
                      if (noteUndo !== null) {
                        return (
                          <NoteNoticeRow
                            key={item.id}
                            environmentId={environmentId}
                            label={chatNoticeLabel(item.notice, item.message.text, now.getTime())}
                            memoryId={noteUndo.memoryId}
                            undo={noteUndo.undo}
                            {...(noteUndo.receipt === undefined
                              ? {}
                              : { receipt: noteUndo.receipt })}
                            threadId={String(threadRef.threadId)}
                            noticeMessageId={String(item.message.id)}
                            noticeCreatedAt={String(item.message.createdAt)}
                            readOnly={readOnly}
                          />
                        );
                      }
                      return isServerTurnNotice(item.notice) ? (
                        <SystemTurnRow
                          key={item.id}
                          label={chatNoticeLabel(item.notice, item.message.text, now.getTime())}
                          text={item.message.text}
                        />
                      ) : (
                        <p
                          key={item.id}
                          data-testid="chat-notice"
                          className="mx-auto max-w-[90%] text-center text-[13px] leading-[18px] text-[var(--personal-text-secondary)]"
                        >
                          {chatNoticeLabel(item.notice, item.message.text, now.getTime())}
                        </p>
                      );
                    }
                    case "group-system":
                      return (
                        <p
                          key={item.id}
                          className="mx-auto max-w-[90%] text-center text-[13px] leading-[18px] text-[var(--personal-text-secondary)]"
                        >
                          {groupSystemLabel(item.event, item.message.text)}
                        </p>
                      );
                    case "delegation":
                      return <div key={item.id}>{renderDelegation(item.task)}</div>;
                    case "question": {
                      // The open question lives in the dock above the composer
                      // (SPEC 2.9); once it settles, its spot in the thread keeps
                      // the record: a receipt when another device answered it, the
                      // settled card when it was answered here.
                      if (dockQuestions && item.card.kind === "pending") return null;
                      if (item.card.kind === "answered" && !answeredHere.has(item.card.requestId)) {
                        return <AnsweredElsewhereReceipt key={item.id} card={item.card} />;
                      }
                      return lockCard(
                        item.id,
                        readOnly,
                        <QuestionCard
                          key={item.id}
                          card={item.card}
                          botName={botName}
                          responding={respondingIds.has(item.card.requestId)}
                          onAnswer={onAnswerQuestion}
                          onDismiss={onDismissQuestion}
                        />,
                      );
                    }
                    case "secret":
                      return lockCard(
                        item.id,
                        readOnly,
                        <SecretRequestCard
                          key={item.id}
                          card={item.card}
                          botName={botName}
                          responding={respondingIds.has(item.card.requestId)}
                          onProvide={onProvideSecret}
                          onDecline={onDeclineSecret}
                        />,
                      );
                    case "login":
                      return lockCard(
                        item.id,
                        readOnly,
                        <LoginRequestCard
                          key={item.id}
                          request={item.request}
                          botName={botName}
                          onProvide={(...args) => onProvideLogin?.(...args)}
                          onCancel={(requestId) => onCancelLogin?.(requestId)}
                        />,
                      );
                    case "connection-approval":
                      return lockCard(
                        item.id,
                        readOnly,
                        <ConnectionApprovalCard
                          key={item.id}
                          card={item.card}
                          botName={botName}
                          expired={
                            item.card.kind === "pending" &&
                            approvalHasExpired(item.card.approval, approvalsNowMs)
                          }
                          responding={approvalRespondingIds.has(item.card.approvalId)}
                          onApprove={(approvalId) =>
                            onDecideConnectionApproval(approvalId, "approved")
                          }
                          onDeny={(approvalId) => onDecideConnectionApproval(approvalId, "denied")}
                        />,
                      );
                    case "lead-bot-change":
                      return lockCard(
                        item.id,
                        readOnly,
                        <LeadBotChangeCard
                          key={item.id}
                          card={item.card}
                          nowMs={approvalsNowMs}
                          responding={leadBotChangeRespondingIds?.has(item.card.changeId) ?? false}
                          onDecide={(changeId, changeHash, decision) =>
                            onDecideLeadBotChange?.(changeId, changeHash, decision)
                          }
                        />,
                      );
                    case "memory-change":
                      return lockCard(
                        item.id,
                        readOnly,
                        <MemoryChangeCard
                          key={item.id}
                          item={item.card}
                          botName={memoryBotName ?? (() => undefined)}
                          responding={memoryChangeRespondingIds?.has(item.card.changeId) ?? false}
                          onDecide={(changeId, changeHash, approve) =>
                            onDecideMemoryChange?.(changeId, changeHash, approve)
                          }
                        />,
                      );
                    case "message": {
                      if (item.message.role === "user") {
                        return (
                          <UserMessage
                            key={item.id}
                            environmentId={environmentId}
                            message={item.message}
                            readStatus={
                              latestMessageStatus?.messageId === String(item.message.id)
                                ? latestMessageStatus.status
                                : null
                            }
                            onReply={onReply}
                            onJump={jumpToQuoted}
                          />
                        );
                      }
                      // A full-width reply (SPEC 2.8): a sender row, the reply at
                      // full width, the steps footer and the time under it.
                      const replyAt = parseSentAt(item.message.createdAt);
                      const replyTime = !row.timeSuppressed && replyAt !== null ? replyAt : null;
                      return (
                        <Fragment key={item.id}>
                          {botSenderRow()}
                          <AssistantMessage
                            message={item.message}
                            threadRef={threadRef}
                            workspaceRoot={workspaceRoot}
                            botName={botName}
                            onReply={onReply}
                            choices={choicesById.get(item.id)}
                            onChoose={onChoose}
                          />
                          {row.footerWork.length > 0 || replyTime !== null ? (
                            <div className="mt-3 flex w-full flex-col items-start gap-1">
                              {row.footerWork.length > 0 ? (
                                <ToolDetails
                                  entries={row.footerWork.flatMap((work) => work.entries)}
                                  live={row.footerWork.some((work) => work.id === liveWorkId)}
                                  workspaceRoot={workspaceRoot}
                                />
                              ) : null}
                              {replyTime !== null ? (
                                <RunTime at={replyTime} align="start" now={now} />
                              ) : null}
                            </div>
                          ) : null}
                          {item.message.streaming ||
                          !turnStarts.has(item.id) ||
                          !hasRecordedContext(new Date(item.message.createdAt), now) ? null : (
                            <ContextUsed
                              environmentId={environmentId}
                              threadId={String(threadRef.threadId)}
                              messageId={turnStarts.get(item.id)!}
                              readOnly={readOnly}
                            />
                          )}
                        </Fragment>
                      );
                    }
                    case "plan":
                      return (
                        <div
                          key={item.id}
                          className="personal-markdown max-w-[90%] rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-surface)] p-3.5 text-[15px] leading-[1.45] text-[var(--personal-text)] md:text-[16px] md:leading-[1.6]"
                        >
                          <p className="mb-1 text-[13px] font-semibold text-[var(--personal-text-secondary)]">
                            Plan
                          </p>
                          <ChatMarkdown
                            text={item.plan.planMarkdown}
                            cwd={workspaceRoot}
                            threadRef={threadRef}
                          />
                        </div>
                      );
                    case "work":
                      return (
                        <ToolDetails
                          key={item.id}
                          entries={item.entries}
                          live={item.id === liveWorkId}
                          workspaceRoot={workspaceRoot}
                        />
                      );
                  }
                })()}
              </div>
            );
          })}
          {range.end < items.length ? (
            // The accessibility fallback for a frozen window (the reader
            // reaches the end of what is loaded and the next step is taken by
            // itself, so this is never needed and never drawn): still a control
            // VoiceOver can find and press, out of the visual flow.
            <button
              type="button"
              onClick={() => movePage(1)}
              className="sr-only"
              aria-label="Load later messages"
            >
              Load later messages
            </button>
          ) : null}

          {pending.map((message) => (
            <div key={message.id} className="mt-4 flex flex-col items-end gap-1 opacity-70">
              {message.attachments.map((attachment) => (
                <span
                  key={attachment.id}
                  className="flex max-w-[78%] items-center gap-1.5 rounded-xl border border-[var(--personal-border)] bg-[var(--personal-surface)] px-3 py-2 text-sm"
                >
                  <FileText aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.75} />
                  <span className="truncate">{attachment.name}</span>
                </span>
              ))}
              {message.text.length > 0 ? (
                <UserBubble text={message.text} quote={message.replyTo ?? null} />
              ) : null}
              <span className="text-xs text-[var(--personal-text-tertiary)]">Sending</span>
            </div>
          ))}

          {(readOnly ? NO_PINNED_APPROVALS : approvals).map((approval) => (
            // A pinned approval is a landing target too (D13), under the id a
            // `?request=` carries.
            <div
              key={approval.requestId}
              data-transcript-row={`approval:${approval.requestId}`}
              className="mt-4"
            >
              <ApprovalCard
                approval={approval}
                botName={botName}
                responding={respondingIds.has(approval.requestId)}
                onRespond={onRespondToApproval}
              />
            </div>
          ))}

          {queued.map((row) => (
            <div key={row.entry.id} className="mt-4">
              <QueuedMessage
                row={row}
                onCancel={onCancelQueued}
                onEdit={onEditQueued}
                onRetry={onRetryQueued}
              />
            </div>
          ))}

          {errorText !== null ? (
            <div className="mt-4">
              <ErrorNotice
                text={errorText}
                detail={errorDetail}
                tone={errorTone}
                retry={errorRetry}
              />
            </div>
          ) : null}
        </div>
      </div>
      {showJump ? (
        <button
          type="button"
          aria-label="Jump to latest message"
          // Keeps the composer focused, so the iPhone keyboard stays up.
          onPointerDown={(event) => event.preventDefault()}
          onClick={jumpToLatest}
          className="group absolute bottom-1 left-1/2 flex size-11 -translate-x-1/2 items-center justify-center rounded-full outline-none"
        >
          <span className="flex size-9 items-center justify-center rounded-full border border-[var(--personal-border)] bg-[var(--personal-surface)] text-[var(--personal-text)] shadow-[var(--personal-shadow-lift)] group-focus-visible:ring-2 group-focus-visible:ring-[var(--personal-text)] group-active:opacity-70">
            <ArrowDown aria-hidden="true" className="size-[18px]" strokeWidth={2} />
          </span>
        </button>
      ) : null}
    </div>
  );
}
