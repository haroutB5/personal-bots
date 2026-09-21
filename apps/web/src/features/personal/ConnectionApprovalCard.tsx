import type { JSX } from "react";

import { Check, ShieldAlert, X } from "lucide-react";

import type { PersonalConnectionRiskReason } from "@t3tools/contracts";

import { cn } from "~/lib/utils";

import type { ConnectionApprovalCardItem } from "./connectionApprovalCards";

const CARD_CLASS =
  "rounded-[var(--personal-radius-card)] border border-[var(--personal-review-border)] bg-[var(--personal-review-bg)] p-3.5";
const SETTLED_CARD_CLASS =
  "rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-surface)] p-3.5";
const BUTTON_CLASS =
  "h-11 rounded-[var(--personal-radius-button)] px-3.5 text-[15px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40";

/**
 * Plain words for why a call stopped here, since "risk reason" is our
 * vocabulary and not the owner's. Typed against the contract's literals, so
 * adding a reason server-side fails this file rather than quietly showing a
 * fallback on a card that is asking to spend money.
 */
const RISK_LABEL: Record<PersonalConnectionRiskReason, string> = {
  read_only: "This only reads",
  account_write: "This changes your account",
  publication: "This publishes something other people can see",
  deployment: "This deploys",
  unbounded_statement: "This runs a statement we cannot check in advance",
};

/**
 * A gated vendor call, answered here in the chat.
 *
 * Without this card the whole gateway is a dead end: the server parks the task
 * on the owner and nothing in the app can see the ask, so a deploy or a delete
 * waits until it expires and the bot reports a failure nobody can explain.
 *
 * Every word of `summary` and `targetResources` comes from the server, written
 * from the arguments it validated. The bot does not get to describe what it is
 * about to do to the person deciding whether it may.
 */
export function ConnectionApprovalCard({
  card,
  botName,
  expired,
  responding,
  onApprove,
  onDeny,
}: {
  card: ConnectionApprovalCardItem;
  botName: string;
  expired: boolean;
  responding: boolean;
  onApprove: (approvalId: string) => void;
  onDeny: (approvalId: string) => void;
}): JSX.Element {
  if (card.kind !== "pending") {
    return <SettledConnectionApprovalCard card={card} botName={botName} />;
  }

  const approval = card.approval;
  const risk = RISK_LABEL[approval.riskReason];
  const targets = approval.targetResources.filter((target) => target.trim().length > 0);

  return (
    <section aria-label={`${botName} needs approval`} className={CARD_CLASS}>
      <p className="flex items-center gap-2 text-[13px] font-semibold text-[var(--personal-text-secondary)]">
        <ShieldAlert aria-hidden="true" className="size-4 shrink-0" strokeWidth={2} />
        <span className="min-w-0 break-words">{botName} needs approval</span>
      </p>
      <p className="mt-1.5 text-[15px] leading-[1.4] break-words text-[var(--personal-text)]">
        {approval.summary}
      </p>
      <p className="mt-1 text-[13px] leading-[1.4] break-words text-[var(--personal-text-secondary)]">
        {risk}. {approval.vendorId}
        {targets.length > 0 ? ` · ${targets.join(", ")}` : ""}
      </p>

      {expired ? (
        // Expiry is swept lazily server-side, so a dead card can still arrive
        // here listed as pending. Saying so beats a button that fails on tap.
        <p className="mt-3 text-[13px] text-[var(--personal-text-secondary)]">
          This request ran out of time. Ask {botName} to try again.
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={responding}
            onClick={() => onDeny(card.approvalId)}
            className={cn(BUTTON_CLASS, "text-[var(--personal-text-secondary)]")}
          >
            Don&apos;t allow
          </button>
          <button
            type="button"
            disabled={responding}
            onClick={() => onApprove(card.approvalId)}
            className={cn(BUTTON_CLASS, "bg-[var(--personal-text)] text-[var(--personal-surface)]")}
          >
            Allow once
          </button>
        </div>
      )}
    </section>
  );
}

/** The three endings, which differ only in the sentence they leave behind. */
function SettledConnectionApprovalCard({
  card,
  botName,
}: {
  card: Extract<ConnectionApprovalCardItem, { kind: "approved" | "denied" | "closed" }>;
  botName: string;
}): JSX.Element {
  if (card.kind === "approved") {
    return (
      <section
        aria-label={`You approved ${botName}'s ${card.vendorId} action`}
        className={SETTLED_CARD_CLASS}
      >
        <p className="flex items-start gap-1.5 text-[15px] break-words text-[var(--personal-text)]">
          <Check aria-hidden="true" className="mt-[3px] size-4 shrink-0" strokeWidth={2.25} />
          <span>You approved: {card.summary}</span>
        </p>
      </section>
    );
  }

  if (card.kind === "denied") {
    return (
      <section
        aria-label={`You denied ${botName}'s ${card.vendorId} action`}
        className={SETTLED_CARD_CLASS}
      >
        <p className="flex items-start gap-1.5 text-[15px] break-words text-[var(--personal-text-secondary)]">
          <X aria-hidden="true" className="mt-[3px] size-4 shrink-0" strokeWidth={2.25} />
          <span>You did not approve: {card.summary}</span>
        </p>
      </section>
    );
  }

  return (
    <section
      aria-label={`${botName}'s ${card.vendorId} action is no longer waiting`}
      className={SETTLED_CARD_CLASS}
    >
      <p className="text-[15px] break-words text-[var(--personal-text-secondary)]">
        This action is no longer waiting: {card.summary}
      </p>
    </section>
  );
}
