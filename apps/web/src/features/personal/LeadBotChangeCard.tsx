import { useState, type JSX } from "react";

import type { PersonalLeadBotChangeField } from "@t3tools/contracts";
import { Check, ChevronDown, ShieldAlert, X } from "lucide-react";

import { cn } from "~/lib/utils";

import {
  leadBotChangeHasExpired,
  leadBotChangeMinutesLeft,
  type LeadBotChangeCardItem,
} from "./leadBotChangeCards";
import { leadBotTextDiff } from "./leadBotTextDiff";

const CARD_CLASS =
  "rounded-[var(--personal-radius-card)] border border-[var(--personal-review-border)] bg-[var(--personal-review-bg)] p-3.5";
const SETTLED_CARD_CLASS =
  "rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-surface)] p-3.5";
const BUTTON_CLASS =
  "h-11 rounded-[var(--personal-radius-button)] px-3.5 text-[15px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40";

type Decision = "approved" | "declined";

/** Long text the owner can open to read whole; name and title already show in full in the lines. */
const READABLE_FIELDS = ["description", "instructions"] as const;

const DIFF_LINE_CLASS: Record<"same" | "removed" | "added", string> = {
  same: "text-[var(--personal-text-secondary)]",
  removed: "bg-[var(--personal-danger-bg)] text-[var(--personal-danger)]",
  added: "bg-[var(--personal-fill-muted)] font-medium text-[var(--personal-text)]",
};
const DIFF_MARK: Record<"same" | "removed" | "added", string> = {
  same: " ",
  removed: "-",
  added: "+",
};

/**
 * The whole new text of one field, collapsed until the owner opens it: the lines
 * it removes and adds, as plain text (never markdown, never HTML), in a box that
 * scrolls inside the card. The marks are characters as well as colours.
 */
function LeadBotTextChange({ item }: { item: PersonalLeadBotChangeField }): JSX.Element {
  const [open, setOpen] = useState(false);
  const diff = open ? leadBotTextDiff(item.before, item.after) : [];
  return (
    <div className="mt-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-11 items-center gap-1.5 rounded-[var(--personal-radius-button)] text-[15px] font-medium text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
      >
        <ChevronDown
          aria-hidden="true"
          className={cn("size-4 shrink-0 transition-transform", open ? "rotate-180" : "")}
          strokeWidth={2}
        />
        {open ? `Hide new ${item.field}` : `Show new ${item.field}`}
      </button>
      {open ? (
        <div
          role="group"
          aria-label={`New ${item.field}, removed and added lines`}
          className="mt-1 max-h-72 overflow-auto overscroll-contain rounded-[var(--personal-radius-button)] border border-[var(--personal-border)] bg-[var(--personal-surface)] py-1 text-[13px] leading-[1.45]"
        >
          {diff.length === 0 ? (
            <p className="px-2 py-1 text-[var(--personal-text-secondary)]">
              The new text is empty.
            </p>
          ) : (
            diff.map((line, index) => (
              <div key={index} className={cn("flex gap-1.5 px-2", DIFF_LINE_CLASS[line.kind])}>
                <span aria-hidden="true" className="shrink-0 select-none font-mono">
                  {DIFF_MARK[line.kind]}
                </span>
                <span
                  data-diff-kind={line.kind}
                  className="min-h-[1.45em] min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
                >
                  {line.text}
                </span>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

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
  const readable = change.fields.filter((item) =>
    (READABLE_FIELDS as ReadonlyArray<string>).includes(item.field),
  );
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
      {readable.map((item) => (
        <LeadBotTextChange key={item.field} item={item} />
      ))}
      {reason !== "" ? (
        <p className="mt-1.5 text-[13px] leading-[1.4] break-words text-[var(--personal-text-secondary)]">
          {`${change.leadName}'s reason: ${reason}`}
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
