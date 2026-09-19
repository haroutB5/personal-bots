import type { JSX } from "react";
import { useState } from "react";
import { Link } from "@tanstack/react-router";

import { cn } from "~/lib/utils";

import { BotAvatar } from "./BotAvatar";
import type { GroupVoteCardModel } from "./groupModel";
import type { GroupSpeakerPresentation } from "./MessageList";

/**
 * The approval gate (addendum section V.3). A sibling of `GroupRoundCard`
 * rather than a variant of it: the same section, dot, title and detail, plus
 * the one thing a round card has no place for — a body with a row per member.
 *
 * This card is the whole safety story of group voting. These bots share a
 * browser, the user's saved logins and a shell, so a majority among them
 * decides nothing on its own; the round sits parked until one of these two
 * buttons is pressed, and Approve is the only path by which a winning option
 * ever reaches a bot as an instruction.
 *
 * Every member's reason is on the card. The owner is not being asked to ratify
 * a count — they are being asked whether the argument is good.
 */
export function GroupVoteCard({
  card,
  speakerOf,
  onDecide,
}: {
  readonly card: GroupVoteCardModel;
  /** Resolves a member to its face and its own chat, as speaker names do. */
  readonly speakerOf: (botId: string) => GroupSpeakerPresentation | null;
  /** Runs the owner's answer; returns the failure message, or null. */
  readonly onDecide: (decision: "approve" | "reject") => Promise<string | null>;
}): JSX.Element {
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: "approve" | "reject") => {
    setBusy(decision);
    const failure = await onDecide(decision);
    setBusy(null);
    setError(failure);
  };

  return (
    <section
      aria-label={`Vote: ${card.question}`}
      className="max-w-[90%] rounded-[var(--personal-radius-card)] border border-[var(--personal-review-border)] bg-[var(--personal-review-bg)] p-3.5"
    >
      <p className="flex min-w-0 items-center gap-2 text-[15px] font-semibold text-[var(--personal-text)]">
        <span
          aria-hidden="true"
          className="size-2 shrink-0 rounded-full bg-[var(--personal-review)]"
        />
        <span className="min-w-0 break-words">{card.question}</span>
      </p>
      <p className="mt-1.5 text-[13px] leading-[18px] break-words text-[var(--personal-text-secondary)]">
        {card.outcome}
      </p>

      <ul className="mt-3 flex flex-col gap-2">
        {card.ballots.map((ballot) => {
          const speaker = speakerOf(ballot.botId);
          const face =
            speaker === null ? null : (
              <BotAvatar
                size={24}
                shape={speaker.avatarShape}
                color={speaker.avatarColor}
                label={speaker.name}
              />
            );
          return (
            <li key={ballot.botId} className="flex min-w-0 items-start gap-2">
              <span className="mt-0.5 shrink-0">{face}</span>
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
                  {/* Same affordance as a speaker's name in the transcript:
                      the member's own chat is one tap away, which is where the
                      reasoning behind the ballot actually lives. */}
                  {speaker?.threadId == null ? (
                    <span className="text-[14px] font-semibold text-[var(--personal-text)]">
                      {ballot.name}
                    </span>
                  ) : (
                    <Link
                      to="/bots/$botId/$threadId"
                      params={{ botId: ballot.botId, threadId: speaker.threadId }}
                      className="text-[14px] font-semibold text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
                    >
                      {ballot.name}
                    </Link>
                  )}
                  <span
                    className={cn(
                      "text-[14px] break-words",
                      card.winningOption !== null && ballot.option === card.winningOption
                        ? "font-semibold text-[var(--personal-text)]"
                        : "text-[var(--personal-text-secondary)]",
                    )}
                  >
                    {ballot.option}
                  </span>
                </span>
                {ballot.reason.length > 0 ? (
                  <span className="block text-[13px] leading-[18px] break-words text-[var(--personal-text-secondary)]">
                    {ballot.reason}
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>

      {card.abstained.length > 0 ? (
        <p className="mt-2 text-[13px] leading-[18px] break-words text-[var(--personal-text-tertiary)]">
          {`${card.abstained.join(", ")} did not vote.`}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        {/* Approve is absent on a tie rather than disabled: there is no winning
            option, so there is nothing the button could mean. */}
        {card.canApprove ? (
          <button
            type="button"
            disabled={busy !== null}
            aria-busy={busy === "approve"}
            onClick={() => void decide("approve")}
            className="h-11 rounded-[var(--personal-radius-button)] bg-[var(--personal-primary)] px-4 text-[15px] font-semibold text-[var(--personal-primary-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40"
          >
            Approve
          </button>
        ) : null}
        <button
          type="button"
          disabled={busy !== null}
          aria-busy={busy === "reject"}
          onClick={() => void decide("reject")}
          className="h-11 rounded-[var(--personal-radius-button)] border border-[var(--personal-border)] px-4 text-[15px] font-semibold text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40"
        >
          Reject
        </button>
      </div>

      {error !== null ? (
        <p role="alert" className="mt-2 text-[13px] text-[var(--personal-danger)]">
          {error}
        </p>
      ) : null}
    </section>
  );
}
