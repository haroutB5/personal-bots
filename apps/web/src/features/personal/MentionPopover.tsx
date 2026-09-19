import type { JSX } from "react";

import { cn } from "~/lib/utils";

import { BotAvatar, type BotAvatarShape } from "./BotAvatar";
import type { MentionCandidate } from "./mentionDraft";

export interface MentionRow extends MentionCandidate {
  readonly avatarShape?: BotAvatarShape;
  readonly avatarColor?: string;
}

/**
 * The `@mention` list, sitting directly above the composer.
 *
 * Not a floating popover anchored to the caret: on a phone the keyboard owns
 * the bottom half of the screen and the composer is the only fixed thing left,
 * so the list rides on top of it where the thumb already is. Rows are 44px, so
 * every one is a real touch target.
 */
export function MentionPopover({
  candidates,
  activeIndex,
  onPick,
}: {
  readonly candidates: ReadonlyArray<MentionRow>;
  readonly activeIndex: number;
  readonly onPick: (candidate: MentionRow) => void;
}): JSX.Element {
  return (
    <ul
      aria-label="Mention a bot"
      className="mb-2 max-h-[264px] overflow-y-auto overscroll-contain rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-surface)] py-1"
    >
      {candidates.map((candidate, index) => (
        <li key={candidate.botId}>
          <button
            type="button"
            // Keeps the keyboard up: the same reason the send button prevents
            // its default pointer action.
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => onPick(candidate)}
            aria-current={index === activeIndex ? "true" : undefined}
            className={cn(
              "flex min-h-11 w-full min-w-0 items-center gap-2.5 px-3 text-left outline-none",
              index === activeIndex
                ? "bg-[var(--personal-fill-muted)]"
                : "focus-visible:bg-[var(--personal-fill-muted)]",
            )}
          >
            {candidate.avatarShape === undefined || candidate.avatarColor === undefined ? (
              <span
                aria-hidden="true"
                className="size-7 shrink-0 rounded-full bg-[var(--personal-fill-muted)]"
              />
            ) : (
              <BotAvatar
                shape={candidate.avatarShape}
                color={candidate.avatarColor}
                size={28}
                label={candidate.name}
              />
            )}
            <span className="min-w-0 truncate text-[15px] text-[var(--personal-text)]">
              {candidate.name}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
