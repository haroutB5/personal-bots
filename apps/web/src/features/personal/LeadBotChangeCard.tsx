import { useState, type JSX } from "react";

import { Check, ShieldAlert, X } from "lucide-react";

import { cn } from "~/lib/utils";

import {
  leadBotChangeHasExpired,
  leadBotChangeMinutesLeft,
  type LeadBotChangeCardItem,
} from "./leadBotChangeCards";

const CARD_CLASS =
  "rounded-[var(--personal-radius-card)] border border-[var(--personal-review-border)] bg-[var(--personal-review-bg)] p-3.5";
const SETTLED_CARD_CLASS =
  "rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-surface)] p-3.5";
const BUTTON_CLASS =
  "h-11 rounded-[var(--personal-radius-button)] px-3.5 text-[15px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40";

type Decision = "approved" | "declined";

/** "remove Tax" / "change Tax: name: 'A' → 'B', model: ..." for the one-line endings. */
function summaryOf(card: LeadBotChangeCardItem): string {
  const { change } = card;
  if (change.action === "remove") return `remove ${change.targetName}`;
  const lines = change.lines.filter((line) => line.trim().length > 0);
  return lines.length === 0
    ? `change ${change.targetName}`
    : `change ${change.targetName} (${lines.join("; ")})`;
}

/**
 * A team lead's request to remove or rewrite a bot it did not create, answered
 * here in the lead's chat. Only the owner can approve it: the words come from
 * the server (`lines`, `reason`), and the tap is bound to `changeHash`, so the
 * lead does not get to describe, or swap, what it is asking to do.
 */
export function LeadBotChangeCard({
  card,
  nowMs,
  responding,
  onDecide,
}: {
  card: LeadBotChangeCardItem;
  /** Passed in rather than read here so a card cannot count down live past its expiry. */
  nowMs: number;
  responding: boolean;
  /** Resolves to an error message when the answer did not land, or null. */
  onDecide: (
    changeId: string,
    changeHash: string,
    decision: Decision,
  ) => Promise<string | null> | void;
}): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const { change } = card;

  if (card.kind !== "pending") {
    return <SettledLeadBotChangeCard card={card} />;
  }
  if (leadBotChangeHasExpired(change, nowMs)) {
    return <SettledLeadBotChangeCard card={{ ...card, kind: "expired" }} />;
  }

  const verb = change.action === "remove" ? "remove" : "change";
  const title = `${change.leadName} asks to ${verb} ${change.targetName}`;
  const lines = change.lines.filter((line) => line.trim().length > 0);
  const reason = change.reason?.trim() ?? "";
  const minutes = leadBotChangeMinutesLeft(change, nowMs);

  const answer = async (decision: Decision) => {
    setError(null);
    const result = await onDecide(card.changeId, change.changeHash, decision);
    if (typeof result === "string") setError(result);
  };

  return (
    <section aria-label={title} className={CARD_CLASS}>
      <p className="flex items-start gap-2 text-[15px] font-semibold text-[var(--personal-text)]">
        <ShieldAlert
          aria-hidden="true"
          className="mt-[3px] size-4 shrink-0 text-[var(--personal-text-secondary)]"
          strokeWidth={2}
        />
        <span className="min-w-0 break-words">{title}</span>
      </p>
      {lines.length > 0 ? (
        <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-[15px] leading-[1.4] text-[var(--personal-text)]">
          {lines.map((line, index) => (
            <li key={index} className="break-words">
              {line}
            </li>
          ))}
        </ul>
      ) : null}
      {reason !== "" ? (
        <p className="mt-1.5 text-[13px] leading-[1.4] break-words text-[var(--personal-text-secondary)]">
          Reason: {reason}
        </p>
      ) : null}
      <p className="mt-1.5 text-[13px] leading-[1.4] text-[var(--personal-text-secondary)]">
        Only you can approve this. It expires in {minutes} min.
      </p>
      {error !== null ? (
        <p
          role="alert"
          className="mt-2 text-[13px] leading-[1.4] break-words text-[var(--personal-danger)]"
        >
          {error}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={responding}
          onClick={() => void answer("declined")}
          className={cn(BUTTON_CLASS, "text-[var(--personal-text-secondary)]")}
        >
          No
        </button>
        <button
          type="button"
          disabled={responding}
          onClick={() => void answer("approved")}
          className={cn(BUTTON_CLASS, "bg-[var(--personal-text)] text-[var(--personal-surface)]")}
        >
          Yes
        </button>
      </div>
    </section>
  );
}

/** The endings, which differ only in the sentence they leave behind. */
function SettledLeadBotChangeCard({ card }: { card: LeadBotChangeCardItem }): JSX.Element {
  const { change } = card;
  const summary = summaryOf(card);
  const aria = `${change.leadName}'s request to ${change.action === "remove" ? "remove" : "change"} ${change.targetName}`;

  switch (card.kind) {
    case "approved":
      return (
        <section aria-label={`You approved ${aria}`} className={SETTLED_CARD_CLASS}>
          <p className="flex items-start gap-1.5 text-[15px] break-words text-[var(--personal-text)]">
            <Check aria-hidden="true" className="mt-[3px] size-4 shrink-0" strokeWidth={2.25} />
            <span className="min-w-0">You approved: {summary}</span>
          </p>
        </section>
      );
    case "declined":
      return (
        <section aria-label={`You declined ${aria}`} className={SETTLED_CARD_CLASS}>
          <p className="flex items-start gap-1.5 text-[15px] break-words text-[var(--personal-text-secondary)]">
            <X aria-hidden="true" className="mt-[3px] size-4 shrink-0" strokeWidth={2.25} />
            <span className="min-w-0">You declined: {summary}</span>
          </p>
        </section>
      );
    case "failed":
      return (
        <section aria-label={`${aria} was not applied`} className={SETTLED_CARD_CLASS}>
          <p className="text-[15px] break-words text-[var(--personal-text-secondary)]">
            Approved, but not applied: {change.outcome ?? "the bot changed in the meantime"}
          </p>
        </section>
      );
    case "superseded":
      return (
        <section aria-label={`${aria} was replaced`} className={SETTLED_CARD_CLASS}>
          <p className="text-[15px] break-words text-[var(--personal-text-secondary)]">
            Replaced by a newer request
          </p>
        </section>
      );
    default:
      return (
        <section aria-label={`${aria} was not answered in time`} className={SETTLED_CARD_CLASS}>
          <p className="text-[15px] break-words text-[var(--personal-text-secondary)]">
            Not answered in time, nothing changed
          </p>
        </section>
      );
  }
}
