import type { JSX } from "react";

import type { PersonalBrowserStatus } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { Laptop } from "lucide-react";

import { cn } from "~/lib/utils";

import { computerChatLink, type ComputerDotTone } from "./computer/computerModel";

const TONE_CLASS: Record<ComputerDotTone, string> = {
  pending: "font-medium text-[var(--personal-review-text)]",
  problem: "font-medium text-[var(--personal-danger)]",
  live: "text-[var(--personal-text-secondary)]",
  idle: "text-[var(--personal-text-tertiary)]",
};

/**
 * The conversation's whole relationship with the shared browser: one quiet
 * line, in the slot the in-chat browser panel used to fill, linking to the
 * Computer tab. It sits between the message list and the composer so it is
 * always on screen without ever pushing into the conversation itself, and it
 * is the same link whether the bot is merely browsing or is blocked waiting
 * for help — so "Needs your help" is one tap from taking control.
 */
export function ConversationComputerLink({
  status,
  botId,
  threadId,
  agentTurnRunning = false,
}: {
  readonly status: PersonalBrowserStatus | null;
  readonly botId: string;
  readonly threadId: string;
  readonly agentTurnRunning?: boolean;
}): JSX.Element {
  const link = computerChatLink(status, { botId, threadId }, agentTurnRunning);
  return (
    <div className="flex shrink-0 justify-center px-4">
      <Link
        to="/computer"
        // Carries where he came from, so Back returns to this chat even when
        // the browser never ran and the status carries no `lastAgent`.
        search={{ fromBot: botId, fromThread: threadId }}
        // The laptop glyph is the Computer tab's own, so the line reads as a
        // route to that tab and not as a stray grey label over the composer.
        className={cn(
          "inline-flex min-h-11 items-center gap-1.5 rounded-[var(--personal-radius-button)] px-3 text-[13px] outline-none",
          "active:opacity-70 focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]",
          "personal-row-hover",
          TONE_CLASS[link.tone],
        )}
      >
        <Laptop aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.75} />
        {link.text}
      </Link>
    </div>
  );
}
