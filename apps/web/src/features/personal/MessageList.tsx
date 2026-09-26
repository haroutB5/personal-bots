import type { JSX, ReactNode } from "react";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import type { PendingApproval } from "@t3tools/client-runtime/pending-requests";
import type {
  ApprovalRequestId,
  EnvironmentId,
  PersonalTask,
  ProviderApprovalDecision,
  ProviderApprovalOption,
  ScopedThreadRef,
} from "@t3tools/contracts";
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
import { groupSystemLabel, readGroupMarker } from "./groupModel";
import { QuestionCard } from "./QuestionCard";
import type { UserInputAnswers } from "./questionCards";
import { SecretRequestCard } from "./SecretRequestCard";
import { ConnectionApprovalCard } from "./ConnectionApprovalCard";
import { approvalHasExpired } from "./connectionApprovalCards";
import { ToolDetails } from "./ToolDetails";

/** A message the user sent that the server has not echoed back yet. */
export interface PendingOutgoingMessage {
  readonly id: string;
  /** The chat it was sent in; it only ever renders there. */
  readonly threadId: string;
  readonly text: string;
  readonly createdAt: string;
  readonly attachments: ReadonlyArray<{ readonly id: string; readonly name: string }>;
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

const UserMessage = memo(function UserMessage({
  environmentId,
  message,
}: {
  environmentId: EnvironmentId;
  message: ChatMessage;
}) {
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
        <p className="max-w-[78%] rounded-[var(--personal-radius-bubble)] bg-[var(--personal-fill-muted)] px-3.5 py-2.5 text-[15px] leading-[1.4] break-words whitespace-pre-wrap text-[var(--personal-text)] md:text-[16px] md:leading-[1.5]">
          {message.text}
        </p>
      ) : null}
    </div>
  );
});

const AssistantMessage = memo(function AssistantMessage({
  message,
  threadRef,
  workspaceRoot,
  botName,
}: {
  message: ChatMessage;
  threadRef: ScopedThreadRef;
  workspaceRoot: string | undefined;
  botName: string;
}) {
  if (message.text.length === 0) return null;
  return (
    <div className="personal-markdown max-w-[90%] text-[15px] leading-[1.45] text-[var(--personal-text)] md:text-[16px] md:leading-[1.6]">
      <span className="sr-only">{botName} said:</span>
      <ChatMarkdown
        text={message.text}
        cwd={workspaceRoot}
        threadRef={threadRef}
        isStreaming={message.streaming}
        lineBreaks={shouldPreserveAssistantLineBreaks(message.text)}
      />
    </div>
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
}: {
  message: ChatMessage;
  threadRef: ScopedThreadRef;
  workspaceRoot: string | undefined;
  speaker: GroupSpeakerPresentation | null;
  botId: string;
  showSpeaker: boolean;
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
  onDecideConnectionApproval,
  approvalRespondingIds,
  approvalsNowMs,
  errorText,
  errorDetail = null,
  loadEarlier,
  now,
  describeTurn,
  renderDelegation,
  groupSpeaker,
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
  onProvideSecret: (requestId: string, value: string, shared: boolean) => void;
  onDeclineSecret: (requestId: string) => void;
  onDecideConnectionApproval: (approvalId: string, decision: "approved" | "denied") => void;
  approvalRespondingIds: ReadonlySet<string>;
  /** Passed in rather than read here so a card cannot re-render itself live past its expiry. */
  approvalsNowMs: number;
  errorText: string | null;
  /** The provider's own line, shown behind a "Details" toggle under `errorText`. */
  errorDetail?: string | null;
  loadEarlier: { readonly loading: boolean; readonly onLoad: () => void } | null;
  now: Date;
}): JSX.Element {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set while a tap's smooth scroll is on its way down: its own scroll events
  // are still far from the bottom and must not bring the button back.
  const jumpingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Only the reader's own scrolling lets go of the bottom. A finger, the
  // mouse on the scrollbar, a wheel or a key marks the scroll as theirs.
  const readerRef = useRef({ holding: false, at: Number.NEGATIVE_INFINITY });

  const cancelShow = () => {
    if (showTimerRef.current !== null) clearTimeout(showTimerRef.current);
    showTimerRef.current = null;
  };
  const endJump = () => {
    if (jumpingRef.current !== null) clearTimeout(jumpingRef.current);
    jumpingRef.current = null;
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
      reassertEnd();
      // Once more after the keyboard has finished moving.
      if (settleTimer !== null) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        follow();
        reassertEnd();
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
      if (nearBottom) {
        endJump();
        stickRef.current = true;
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
      observer.disconnect();
      cancelShow();
      endJump();
    };
  }, []);

  // The screen stays mounted when the route moves to another chat, so the
  // next chat opens at its latest message with the button hidden.
  const threadId = threadRef.threadId;
  useEffect(() => {
    cancelShow();
    endJump();
    stickRef.current = true;
    // A tap that opened this chat from inside the last one is not a scroll here.
    readerRef.current = { holding: false, at: Number.NEGATIVE_INFINITY };
    setShowJump(false);
    const scroller = scrollerRef.current;
    if (scroller !== null) scroller.scrollTop = scroller.scrollHeight;
  }, [threadId]);

  const jumpToLatest = () => {
    const scroller = scrollerRef.current;
    if (scroller === null) return;
    cancelShow();
    setShowJump(false);
    // Following resumes now, so a reply landing mid-scroll is followed too.
    stickRef.current = true;
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
      if (item.kind === "message" && item.message.role === "user") return null;
      if (item.kind === "work") return item.id;
    }
    return null;
  }, [items, working]);

  const empty = items.length === 0 && pending.length === 0;

  return (
    // The jump button floats over the transcript's bottom edge, just above the
    // composer and any strip resting on it, so it never shifts the layout and
    // rides up with the keyboard.
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollerRef}
        className="personal-column personal-scroll-quiet min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-4"
      >
        <div
          ref={contentRef}
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          aria-label={`Chat with ${botName}`}
          className="flex min-h-full flex-col justify-end gap-3 py-3"
        >
          {loadEarlier !== null ? (
            <button
              type="button"
              onClick={loadEarlier.onLoad}
              disabled={loadEarlier.loading}
              aria-busy={loadEarlier.loading}
              className="mx-auto h-11 rounded-full px-4 text-sm font-medium text-[var(--personal-text-secondary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40"
            >
              {loadEarlier.loading ? "Loading earlier messages" : "Load earlier messages"}
            </button>
          ) : null}

          {empty ? (
            <p className="my-auto text-center text-[15px] text-[var(--personal-text-secondary)]">
              Send {botName} a message to get started.
            </p>
          ) : null}

          {items.map((item) => {
            switch (item.kind) {
              case "divider":
                return (
                  <p
                    key={item.id}
                    className="my-3 text-center text-xs text-[var(--personal-text-tertiary)]"
                  >
                    <time dateTime={item.at.toISOString()}>{formatDayDivider(item.at, now)}</time>
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
                      />
                    </div>
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
                return (
                  <QuestionCard
                    key={item.id}
                    card={item.card}
                    botName={botName}
                    responding={respondingIds.has(item.card.requestId)}
                    onAnswer={onAnswerQuestion}
                    onDismiss={onDismissQuestion}
                  />
                );
              case "secret":
                return (
                  <SecretRequestCard
                    key={item.id}
                    card={item.card}
                    botName={botName}
                    responding={respondingIds.has(item.card.requestId)}
                    onProvide={onProvideSecret}
                    onDecline={onDeclineSecret}
                  />
                );
              case "connection-approval":
                return (
                  <ConnectionApprovalCard
                    key={item.id}
                    card={item.card}
                    botName={botName}
                    expired={
                      item.card.kind === "pending" &&
                      approvalHasExpired(item.card.approval, approvalsNowMs)
                    }
                    responding={approvalRespondingIds.has(item.card.approvalId)}
                    onApprove={(approvalId) => onDecideConnectionApproval(approvalId, "approved")}
                    onDeny={(approvalId) => onDecideConnectionApproval(approvalId, "denied")}
                  />
                );
              case "message":
                return item.message.role === "user" ? (
                  <UserMessage key={item.id} environmentId={environmentId} message={item.message} />
                ) : (
                  <AssistantMessage
                    key={item.id}
                    message={item.message}
                    threadRef={threadRef}
                    workspaceRoot={workspaceRoot}
                    botName={botName}
                  />
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
          })}

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
                <p className="max-w-[78%] rounded-[var(--personal-radius-bubble)] bg-[var(--personal-fill-muted)] px-3.5 py-2.5 text-[15px] leading-[1.4] break-words whitespace-pre-wrap text-[var(--personal-text)] md:text-[16px] md:leading-[1.5]">
                  {message.text}
                </p>
              ) : null}
              <span className="text-xs text-[var(--personal-text-tertiary)]">Sending</span>
            </div>
          ))}

          {approvals.map((approval) => (
            <ApprovalCard
              key={approval.requestId}
              approval={approval}
              botName={botName}
              responding={respondingIds.has(approval.requestId)}
              onRespond={onRespondToApproval}
            />
          ))}

          {errorText !== null ? (
            <div
              role="alert"
              className="max-w-[90%] rounded-[var(--personal-radius-card)] border border-[var(--personal-danger-border)] bg-[var(--personal-danger-bg)] px-3.5 py-2.5 text-sm break-words text-[var(--personal-danger)]"
            >
              <p>{errorText}</p>
              {errorDetail ? (
                <details className="mt-1.5">
                  <summary className="cursor-pointer text-[12px] font-medium select-none">
                    Details
                  </summary>
                  <p className="mt-1 text-[12px] leading-snug break-words opacity-80">
                    {errorDetail}
                  </p>
                </details>
              ) : null}
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
