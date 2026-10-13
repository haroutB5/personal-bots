import type { JSX } from "react";

import { cn } from "~/lib/utils";

import { MutedBell } from "./BotMute";
import type { ConversationCaption } from "./conversationModel";

/** The title a bot's chat carries until its first message names it (server side). */
const UNTITLED_CHAT_TITLE = "New chat";

/** The chat's title for the header, or null while it has none worth showing. */
export function conversationChatTitle(title: string | null | undefined): string | null {
  const trimmed = title?.trim() ?? "";
  return trimmed === "" || trimmed === UNTITLED_CHAT_TITLE ? null : trimmed;
}

const CAPTION_TONE_CLASS: Record<ConversationCaption["tone"], string> = {
  working: "text-[var(--personal-state-working)]",
  thinking: "text-[var(--personal-state-thinking)]",
  needs: "text-[var(--personal-state-needs)]",
  idle: "text-[var(--personal-state-idle)]",
  error: "text-[var(--personal-error)]",
  info: "text-[var(--personal-text-secondary)]",
};

/**
 * The chat's context size, at every size. A quiet outlined chip, so it reads
 * as a measure of the chat and not as a second, smaller word of the name.
 */
function contextBadgeElement(label: string): JSX.Element {
  return (
    <span
      role="img"
      aria-label={`Chat context ${label} tokens`}
      className="shrink-0 rounded-full border border-[var(--personal-border-strong)] px-1.5 text-[11px] leading-[18px] font-medium tabular-nums text-[var(--personal-text-secondary)]"
    >
      {label}
    </span>
  );
}

/**
 * Header identity (SPEC 2.7): the bot's name (headline, 17/22) over its state
 * caption (footnote, in the state's own colour: "Working", "Thinking", "Needs
 * you", or the model when idle), with the muted bell and the chat's context
 * size beside the name. The caption never truncates to nothing: it ellipsises
 * as the last resort, after the name has. The h1 carries the chat's title for
 * screen readers (the title itself shows as the highlighted chip).
 */
export function ConversationHeaderIdentity({
  name,
  chatTitle,
  muted,
  contextBadge,
  caption,
}: {
  name: string;
  chatTitle: string | null | undefined;
  muted: boolean;
  contextBadge: string | null;
  caption: ConversationCaption;
}): JSX.Element {
  const title = conversationChatTitle(chatTitle);
  return (
    <span className="flex min-w-0 flex-1 flex-col justify-center">
      <span data-name-group="" className="flex min-w-0 items-center gap-2">
        <h1 className="min-w-0 truncate text-[17px] leading-[22px] font-semibold text-[var(--personal-text)]">
          {name}
          {title !== null ? <span className="sr-only">, chat {title}</span> : null}
        </h1>
        {muted ? <MutedBell size={16} className="-ml-0.5 shrink-0" /> : null}
        {contextBadge !== null ? contextBadgeElement(contextBadge) : null}
      </span>
      <span
        data-testid="chat-caption"
        className={cn(
          "truncate text-[13px] leading-4 font-medium",
          CAPTION_TONE_CLASS[caption.tone],
        )}
      >
        {caption.text}
      </span>
    </span>
  );
}
