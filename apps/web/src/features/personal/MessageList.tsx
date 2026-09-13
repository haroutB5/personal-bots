import type { JSX } from "react";
import { memo, useEffect, useMemo, useRef } from "react";

import type { PendingApproval, PendingUserInput } from "@t3tools/client-runtime/pending-requests";
import type {
  ApprovalRequestId,
  EnvironmentId,
  ProviderApprovalDecision,
  ProviderApprovalOption,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { FileText } from "lucide-react";

import { useAssetUrls } from "~/assets/assetUrls";
import ChatMarkdown from "~/components/ChatMarkdown";
import { shouldPreserveAssistantLineBreaks } from "~/components/chat/MessagesTimeline.logic";
import { cn } from "~/lib/utils";
import { selectMessageImageResources } from "~/session-logic";
import type { ChatMessage } from "~/types";

import { type ConversationItem, formatDayDivider } from "./conversationModel";
import { ToolDetails } from "./ToolDetails";

/** A message the user sent that the server has not echoed back yet. */
export interface PendingOutgoingMessage {
  readonly id: string;
  readonly text: string;
  readonly createdAt: string;
  readonly attachments: ReadonlyArray<{ readonly id: string; readonly name: string }>;
}

const STICK_THRESHOLD_PX = 80;

const APPROVAL_KIND_LABEL: Record<PendingApproval["requestKind"], string> = {
  command: "wants to run a command",
  "file-read": "wants to read files",
  "file-change": "wants to change files",
  "mcp-elicitation": "needs your input for a tool",
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
  const imageIds = new Set(resources.map((resource) => resource.attachmentId));
  const files = (message.attachments ?? []).filter(
    (attachment) => !("id" in attachment) || !imageIds.has(String(attachment.id)),
  );
  return (
    <div className="flex flex-col items-end gap-1.5">
      {resources.length > 0 ? (
        <div className="flex max-w-[78%] flex-wrap justify-end gap-1.5">
          {resources.map((resource, index) => {
            const url = urls[index];
            return url ? (
              <img
                key={resource.attachmentId}
                src={url}
                alt=""
                className="size-24 rounded-xl border border-[var(--personal-border)] object-cover"
              />
            ) : (
              <span
                key={resource.attachmentId}
                className="size-24 rounded-xl border border-[var(--personal-border)] bg-[var(--personal-fill-muted)]"
              />
            );
          })}
        </div>
      ) : null}
      {files.map((file) => (
        <span
          key={"id" in file ? String(file.id) : attachmentName(file)}
          className="flex max-w-[78%] items-center gap-1.5 rounded-xl border border-[var(--personal-border)] bg-[var(--personal-surface)] px-3 py-2 text-sm text-[var(--personal-text)]"
        >
          <FileText aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.75} />
          <span className="truncate">{attachmentName(file)}</span>
        </span>
      ))}
      {message.text.trim().length > 0 ? (
        <p className="max-w-[78%] rounded-[var(--personal-radius-bubble)] bg-[var(--personal-fill-muted)] px-3.5 py-2.5 text-[15px] leading-[1.4] break-words whitespace-pre-wrap text-[var(--personal-text)]">
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
}: {
  message: ChatMessage;
  threadRef: ScopedThreadRef;
  workspaceRoot: string | undefined;
}) {
  if (message.text.length === 0) return null;
  return (
    <div className="personal-markdown max-w-[90%] text-[15px] leading-[1.45] text-[var(--personal-text)]">
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
              "h-11 min-w-0 flex-1 rounded-[var(--personal-radius-button)] px-3 text-[15px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] focus-visible:ring-offset-2 disabled:opacity-40",
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
 * markdown assistant text, collapsed tool activity, then anything waiting on
 * the user. Owns the scroller: it follows new content while the reader is at
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
  userInputs,
  respondingIds,
  onRespondToApproval,
  errorText,
  loadEarlier,
  now,
}: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  items: ReadonlyArray<ConversationItem>;
  pending: ReadonlyArray<PendingOutgoingMessage>;
  working: boolean;
  botName: string;
  workspaceRoot: string | undefined;
  approvals: ReadonlyArray<PendingApproval>;
  userInputs: ReadonlyArray<PendingUserInput>;
  respondingIds: ReadonlySet<string>;
  onRespondToApproval: (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => void;
  errorText: string | null;
  loadEarlier: { readonly loading: boolean; readonly onLoad: () => void } | null;
  now: Date;
}): JSX.Element {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    const scroller = scrollerRef.current;
    const content = contentRef.current;
    if (scroller === null || content === null) return;
    const follow = () => {
      if (stickRef.current) scroller.scrollTop = scroller.scrollHeight;
    };
    follow();
    const onScroll = () => {
      stickRef.current =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < STICK_THRESHOLD_PX;
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    // Streaming text, late images and the keyboard all change heights without
    // a React update here, so follow size changes rather than renders.
    const observer = new ResizeObserver(follow);
    observer.observe(content);
    observer.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, []);

  // The work group that is still being written: the last one, while working,
  // with no user message after it.
  const liveWorkId = useMemo(() => {
    if (!working) return null;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index]!;
      if (item.kind === "message" && item.message.role === "user") return null;
      if (item.kind === "work") return item.id;
    }
    return null;
  }, [items, working]);

  const empty = items.length === 0 && pending.length === 0;

  return (
    <div
      ref={scrollerRef}
      className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-4"
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
            case "message":
              return item.message.role === "user" ? (
                <UserMessage key={item.id} environmentId={environmentId} message={item.message} />
              ) : (
                <AssistantMessage
                  key={item.id}
                  message={item.message}
                  threadRef={threadRef}
                  workspaceRoot={workspaceRoot}
                />
              );
            case "plan":
              return (
                <div
                  key={item.id}
                  className="max-w-[90%] rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-surface)] p-3.5 text-[15px] leading-[1.45] text-[var(--personal-text)]"
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
              <p className="max-w-[78%] rounded-[var(--personal-radius-bubble)] bg-[var(--personal-fill-muted)] px-3.5 py-2.5 text-[15px] leading-[1.4] break-words whitespace-pre-wrap text-[var(--personal-text)]">
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

        {userInputs.length > 0 ? (
          <section className="rounded-[var(--personal-radius-card)] border border-[var(--personal-review-border)] bg-[var(--personal-review-bg)] p-3.5 text-[15px] text-[var(--personal-text)]">
            <p className="font-semibold">{botName} asked you a question.</p>
            <p className="mt-1 text-sm text-[var(--personal-text-secondary)]">
              Answering questions isn't in this view yet.
            </p>
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId, threadId: threadRef.threadId }}
              className="mt-3 flex h-11 items-center justify-center rounded-[var(--personal-radius-button)] border border-[var(--personal-border)] bg-[var(--personal-surface)] text-[15px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
            >
              Answer in Developer view
            </Link>
          </section>
        ) : null}

        {errorText !== null ? (
          <p
            role="alert"
            className="max-w-[90%] rounded-[var(--personal-radius-card)] border border-[#f1c9c5] bg-[#fdf3f2] px-3.5 py-2.5 text-sm break-words text-[#8c1d18]"
          >
            {errorText}
          </p>
        ) : null}
      </div>
    </div>
  );
}
