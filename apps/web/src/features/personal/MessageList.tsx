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
import { ArrowDown, ChevronRight, FileText } from "lucide-react";

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
import type { UserInputAnswers } from "./questionCards";
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
import { jumpToMessage, replyQuoteForMessage } from "./messageReply";
import { clearMessageJump, peekMessageJump } from "./pendingMessageJump";
import { ReplyQuoteChip } from "./ReplyQuote";
import { ReplyableMessage } from "./ReplyableMessage";
import { SwipeTimeRow } from "./MessageSwipeTime";
import { parseSentAt } from "./messageTime";
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
  "rounded-[var(--personal-radius-bubble)] bg-[var(--personal-fill-muted)] px-3.5 py-2.5 text-[15px] leading-[1.4] break-words whitespace-pre-wrap text-[var(--personal-text)] md:text-[16px] md:leading-[1.5]";

/** The owner's text bubble, with the quote of the message it replies to above the text. */
function UserBubble({
  text,
  quote,
  onJump,
  widthClass = "max-w-[78%]",
}: {
  text: string;
  quote: PersonalReplyQuote | null;
  onJump?: ((messageId: string) => void) | undefined;
  /** `max-w-full` when a wrapper already holds the 78%. */
  widthClass?: string;
}) {
  if (quote === null) return <p className={cn(widthClass, USER_BUBBLE_CLASS)}>{text}</p>;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", widthClass, USER_BUBBLE_CLASS)}>
      <ReplyQuoteChip quote={quote} onJump={onJump} />
      <p>{text}</p>
    </div>
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
}: {
  environmentId: EnvironmentId;
  message: ChatMessage;
  /** Only on the owner's latest message: whether the bot has taken it in yet. */
  readStatus?: MessageReadStatus | null;
  /** Reply on this message; absent where nothing can be sent (an archived chat). */
  onReply?: ((quote: PersonalReplyQuote) => void) | undefined;
  onJump?: ((messageId: string) => void) | undefined;
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
            <UserBubble text={message.text} quote={quote} onJump={onJump} />
          ) : (
            <SwipeTimeRow sentAt={sentAt} align="end" className="max-w-[78%]">
              <UserBubble
                text={message.text}
                quote={quote}
                onJump={onJump}
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
  const content = (
    <div className="personal-markdown max-w-[90%] min-w-0 text-[15px] leading-[1.45] text-[var(--personal-text)] md:text-[16px] md:leading-[1.6]">
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
      <SwipeTimeRow sentAt={sentAt} align="start">
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
 * the bottom and leaves them alone once they scroll up.
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
  const threadId = threadRef.threadId;
  const [page, setPage] = useState<{ threadId: string; firstId: string | null }>({
    threadId,
    firstId: null,
  });
  const firstId = page.threadId === threadId ? page.firstId : null;
  const range = transcriptRange(items, firstId);
  const visibleItems = items.slice(range.start, range.end);
  const windowRef = useRef({ threadId, range, items });
  useLayoutEffect(() => {
    windowRef.current = { threadId, range, items };
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
    saveAnchor();
    stickRef.current = false;
    const start = Math.max(
      0,
      Math.min(
        items.length - TRANSCRIPT_WINDOW_SIZE,
        range.start + direction * TRANSCRIPT_WINDOW_STEP,
      ),
    );
    setPage({ threadId, firstId: items[start]?.id ?? null });
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
    if (stickRef.current && firstId === null && scrollerRef.current)
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
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
    const onResize = () => {
      const grew = scroller.clientHeight > observedHeight;
      observedHeight = scroller.clientHeight;
      follow();
      if (!grew) return;
      if (stickRef.current) reassertEnd();
      // Once more after the keyboard has finished moving.
      if (settleTimer !== null) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        follow();
        if (stickRef.current) reassertEnd();
      }, VIEWPORT_SETTLE_MS);
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
      if (nearBottom && windowRef.current.range.end === windowRef.current.items.length) {
        endJump();
        stickRef.current = true;
        setPage((previous) =>
          previous.threadId === windowRef.current.threadId && previous.firstId === null
            ? previous
            : { threadId: windowRef.current.threadId, firstId: null },
        );
        cancelShow();
        setShowJump(false);
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
    stickRef.current = true;
    // A tap that opened this chat from inside the last one is not a scroll here.
    readerRef.current = { holding: false, at: Number.NEGATIVE_INFINITY };
    setShowJump(false);
    const scroller = scrollerRef.current;
    if (scroller !== null) scroller.scrollTop = scroller.scrollHeight;
  }, [threadId]);

  // A tap on a message search hit asked for this chat to open on that message.
  // The thread loads progressively, so this tries again whenever the items
  // change, until the message is there or the request lapses.
  useEffect(() => {
    const messageId = peekMessageJump(threadId);
    if (messageId === null) return;
    jumpToQuoted(messageId);
    // `items` is the trigger: a thread that loads in pages may bring the message later.
  }, [threadId, items]);

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
        // The chat's scroller, marked so the on-phone typing capture
        // (typeJumpDiag.ts) can read its scrollTop and clientHeight.
        data-chat-transcript=""
        className="personal-column personal-scroll-quiet relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-4"
      >
        <div
          ref={contentRef}
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          aria-label={`Chat with ${botName}`}
          className="flex min-h-full flex-col justify-end gap-3 py-3"
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

          {visibleItems.map((item) => (
            <div key={item.id} data-transcript-row={item.id} className="flex flex-col gap-3">
              {(() => {
                switch (item.kind) {
                  case "divider":
                    return (
                      <p
                        key={item.id}
                        className="my-3 text-center text-xs text-[var(--personal-text-tertiary)]"
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
                          {...(noteUndo.receipt === undefined ? {} : { receipt: noteUndo.receipt })}
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
                  case "question":
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
                  case "message":
                    return item.message.role === "user" ? (
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
                    ) : (
                      <Fragment key={item.id}>
                        <AssistantMessage
                          message={item.message}
                          threadRef={threadRef}
                          workspaceRoot={workspaceRoot}
                          botName={botName}
                          onReply={onReply}
                          choices={choicesById.get(item.id)}
                          onChoose={onChoose}
                        />
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
          ))}
          {range.end < items.length ? (
            <button
              type="button"
              onClick={() => movePage(1)}
              className="mx-auto h-11 rounded-full px-4 text-sm font-medium text-[var(--personal-text-secondary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
            >
              Load later messages
            </button>
          ) : null}

          {pending.map((message) => (
            <div key={message.id} className="flex flex-col items-end gap-1 opacity-70">
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
            <ApprovalCard
              key={approval.requestId}
              approval={approval}
              botName={botName}
              responding={respondingIds.has(approval.requestId)}
              onRespond={onRespondToApproval}
            />
          ))}

          {queued.map((row) => (
            <QueuedMessage
              key={row.entry.id}
              row={row}
              onCancel={onCancelQueued}
              onEdit={onEditQueued}
              onRetry={onRetryQueued}
            />
          ))}

          {errorText !== null ? (
            <ErrorNotice
              text={errorText}
              detail={errorDetail}
              tone={errorTone}
              retry={errorRetry}
            />
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
