import type { JSX } from "react";
import { useState } from "react";

import { cn } from "~/lib/utils";

import type { GroupRoundCardModel } from "./groupModel";

/**
 * A round that stopped short, in the transcript where it stopped
 * [Grok: one timeline]. Shaped like the delegation card on purpose: the owner
 * already knows what a card in a chat means, and a group pausing is the same
 * kind of event as a delegated task needing something.
 *
 * It reports only what the round says: the budget ran out, a member is
 * throttled, the round was stopped or interrupted. There is no "resume
 * anyway" — Continue spends a fresh budget server-side, and a stopped round
 * stays stopped.
 */
export function GroupRoundCard({
  card,
  onAct,
}: {
  readonly card: GroupRoundCardModel;
  /** Runs the card's single action (Continue / Retry); returns an error or null. */
  readonly onAct: () => Promise<string | null>;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async () => {
    setBusy(true);
    const failure = await onAct();
    setBusy(false);
    setError(failure);
  };

  return (
    <section
      aria-label={card.title}
      className={cn(
        "max-w-[90%] rounded-[var(--personal-radius-card)] border p-3.5",
        card.tone === "review"
          ? "border-[var(--personal-review-border)] bg-[var(--personal-review-bg)]"
          : "border-[var(--personal-border)] bg-[var(--personal-surface)]",
      )}
    >
      <p className="flex min-w-0 items-center gap-2 text-[15px] font-semibold text-[var(--personal-text)]">
        <span
          aria-hidden="true"
          className={cn(
            "size-2 shrink-0 rounded-full",
            card.tone === "review"
              ? "bg-[var(--personal-review)]"
              : "bg-[var(--personal-text-tertiary)]",
          )}
        />
        <span className="min-w-0">{card.title}</span>
      </p>
      {card.detail !== null ? (
        <p className="mt-1.5 text-[13px] leading-[18px] break-words text-[var(--personal-text-secondary)]">
          {card.detail}
        </p>
      ) : null}
      {card.action !== null ? (
        <button
          type="button"
          disabled={busy}
          aria-busy={busy}
          onClick={() => void act()}
          className="mt-3 h-11 rounded-[var(--personal-radius-button)] bg-[var(--personal-primary)] px-4 text-[15px] font-semibold text-[var(--personal-primary-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40"
        >
          {card.action}
        </button>
      ) : null}
      {error !== null ? (
        <p role="alert" className="mt-2 text-[13px] text-[var(--personal-danger)]">
          {error}
        </p>
      ) : null}
    </section>
  );
}
