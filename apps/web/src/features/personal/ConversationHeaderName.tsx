import type { JSX } from "react";

import { MutedBell } from "./BotMute";

/** The title a bot's chat carries until its first message names it (server side). */
const UNTITLED_CHAT_TITLE = "New chat";

/** The chat's title for the header, or null while it has none worth showing. */
export function conversationChatTitle(title: string | null | undefined): string | null {
  const trimmed = title?.trim() ?? "";
  return trimmed === "" || trimmed === UNTITLED_CHAT_TITLE ? null : trimmed;
}

/**
 * Header name line: the bot name with its muted bell and context badge, then
 * the chat's title, muted, in whatever width is left. Name, bell and badge
 * stay together and give way to the title never (the name ellipsises only when
 * it cannot fit beside its badge at all); the title ellipsises, and where a
 * long name leaves it too little
 * room to say anything (under 40 px, a bare "T…") it wraps onto a second
 * row that the fixed-height line clips, so it is simply not shown. An
 * untitled chat shows no title rather than a "New chat" that says nothing.
 */
export function ConversationHeaderName({
  name,
  chatTitle,
  muted,
  contextBadge,
}: {
  name: string;
  chatTitle: string | null | undefined;
  muted: boolean;
  contextBadge: string | null;
}): JSX.Element {
  const title = conversationChatTitle(chatTitle);
  return (
    <span className="flex h-6 min-w-0 flex-wrap items-center gap-x-2 overflow-hidden">
      <span data-name-group="" className="flex max-w-full min-w-0 shrink-0 items-center gap-2">
        <h1 className="min-w-0 truncate text-[19px] leading-6 font-bold text-[var(--personal-text)]">
          {name}
          {title !== null ? <span className="sr-only">, chat {title}</span> : null}
        </h1>
        {muted ? <MutedBell size={16} className="-ml-0.5 shrink-0" /> : null}
        {contextBadge !== null ? (
          // The chat's context size, at every size. A quiet outlined chip, so it
          // reads as a measure of the chat and not as a second, smaller word of
          // the name.
          <span
            role="img"
            aria-label={`Chat context ${contextBadge} tokens`}
            className="shrink-0 rounded-full border border-[var(--personal-border-strong)] px-1.5 text-[11px] leading-[18px] font-medium tabular-nums text-[var(--personal-text-secondary)]"
          >
            {contextBadge}
          </span>
        ) : null}
      </span>
      {title !== null ? (
        <span
          aria-hidden="true"
          data-chat-title=""
          title={title}
          className="min-w-10 flex-1 basis-0 truncate text-[15px] leading-6 font-medium text-[var(--personal-text-secondary)]"
        >
          {title}
        </span>
      ) : null}
    </span>
  );
}
