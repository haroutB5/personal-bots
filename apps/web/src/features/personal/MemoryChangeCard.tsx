import { useState, type JSX } from "react";

import type { PersonalMemoryCardTarget } from "@t3tools/contracts";
import { Check, Brain, X } from "lucide-react";

import { cn } from "~/lib/utils";

import {
  memoryCardAudienceNote,
  memoryCardButtons,
  memoryCardHeadline,
  memoryCardSettledLine,
  type MemoryCardItem,
} from "./memoryCards";
import { memoryReachTag } from "./memoryPresentation";

const CARD_CLASS =
  "rounded-[var(--personal-radius-card)] border border-[var(--personal-review-border)] bg-[var(--personal-review-bg)] p-3.5";
const SETTLED_CARD_CLASS =
  "rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-surface)] px-3.5 py-2.5";
const BUTTON_CLASS =
  "h-11 rounded-[var(--personal-radius-button)] px-3.5 text-[15px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40";
const TEXT_BOX_CLASS =
  "mt-1 rounded-[var(--personal-radius-button)] border border-[var(--personal-border)] bg-[var(--personal-surface)] px-2.5 py-2 text-[15px] leading-[1.4] whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[var(--personal-text)]";
const LABEL_CLASS =
  "text-[12px] font-semibold tracking-wide text-[var(--personal-text-secondary)] uppercase";

/** One labelled block of exact memory text, shown whole: never clipped, never markdown. */
function MemoryTextBlock({ label, text }: { label: string; text: string }): JSX.Element {
  return (
    <div className="min-w-0">
      <p className={LABEL_CLASS}>{label}</p>
      <p className={TEXT_BOX_CLASS}>{text}</p>
    </div>
  );
}

function TargetBlocks({
  label,
  targets,
}: {
  label: string;
  targets: ReadonlyArray<PersonalMemoryCardTarget>;
}): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {targets.map((target) => (
        <div key={target.memoryId} className="min-w-0">
          <MemoryTextBlock label={label} text={target.content} />
          {/* The kind and reach the answer is bound to, as the bot proposed. */}
          <p className="mt-0.5 text-[12px] text-[var(--personal-text-tertiary)]">
            {memoryReachTag(target)}
          </p>
        </div>
      ))}
    </div>
  );
}

/**
 * A bot's save or forget of memory other bots see, answered in the chat it
 * happened in. The text is the exact entry the server will write or archive;
 * the tap is bound to `changeHash`. Once decided it folds to one line.
 */
export function MemoryChangeCard({
  item,
  botName,
  responding,
  onDecide,
}: {
  item: MemoryCardItem;
  botName: (botId: string) => string | undefined;
  responding: boolean;
  /** Resolves to an error message when the answer did not land, or null. */
  onDecide: (
    changeId: number,
    changeHash: string,
    approve: boolean,
  ) => Promise<string | null> | void;
}): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [pressed, setPressed] = useState<boolean | null>(null);
  const { card } = item;
  const headline = memoryCardHeadline(card, botName);
  const settled = memoryCardSettledLine(card);

  if (settled !== null) {
    const done = settled === "Saved" || settled === "Forgotten";
    const subject = card.action === "save" ? card.content : card.targets[0]?.content;
    return (
      <section aria-label={`${headline}: ${settled}`} className={SETTLED_CARD_CLASS}>
        <p
          className={cn(
            "flex items-start gap-1.5 text-[15px] break-words",
            done ? "text-[var(--personal-text)]" : "text-[var(--personal-text-secondary)]",
          )}
        >
          {done ? (
            <Check aria-hidden="true" className="mt-[3px] size-4 shrink-0" strokeWidth={2.25} />
          ) : (
            <X aria-hidden="true" className="mt-[3px] size-4 shrink-0" strokeWidth={2.25} />
          )}
          <span className="min-w-0 truncate">
            {settled}
            {subject ? `: ${subject}` : ""}
          </span>
        </p>
      </section>
    );
  }

  const buttons = memoryCardButtons(card.action);
  const answer = async (approve: boolean) => {
    setError(null);
    setPressed(approve);
    const result = await onDecide(card.changeId, card.changeHash, approve);
    setPressed(null);
    if (typeof result === "string") setError(result);
  };

  return (
    <section aria-label={headline} aria-busy={responding} className={CARD_CLASS}>
      <p className="flex items-start gap-2 text-[15px] font-semibold text-[var(--personal-text)]">
        <Brain
          aria-hidden="true"
          className="mt-[3px] size-4 shrink-0 text-[var(--personal-text-secondary)]"
          strokeWidth={2}
        />
        <span className="min-w-0 break-words">{headline}</span>
      </p>
      {card.action === "save" ? (
        card.targets.length > 0 ? (
          // Side by side when the chat is wide, stacked on the phone.
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <TargetBlocks label="Now" targets={card.targets} />
            <MemoryTextBlock label="After" text={card.content ?? ""} />
          </div>
        ) : (
          <div className="mt-2">
            <MemoryTextBlock label="New entry" text={card.content ?? ""} />
          </div>
        )
      ) : (
        <div className="mt-2">
          <TargetBlocks label="Forgets" targets={card.targets} />
        </div>
      )}
      {card.action === "save" && card.targets.length > 0 ? (
        <p className="mt-1.5 text-[13px] leading-[1.4] text-[var(--personal-text-secondary)]">
          Saving replaces {card.targets.length === 1 ? "that entry" : "those entries"}; you can
          restore {card.targets.length === 1 ? "it" : "them"} from Memory.
        </p>
      ) : null}
      <p className="mt-1.5 text-[13px] leading-[1.4] text-[var(--personal-text-secondary)]">
        {memoryCardAudienceNote(card, botName)}
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
          onClick={() => void answer(false)}
          className={cn(BUTTON_CLASS, "text-[var(--personal-text-secondary)]")}
        >
          {responding && pressed === false ? "…" : buttons.reject}
        </button>
        <button
          type="button"
          disabled={responding}
          onClick={() => void answer(true)}
          className={cn(BUTTON_CLASS, "bg-[var(--personal-text)] text-[var(--personal-surface)]")}
        >
          {responding && pressed === true
            ? card.action === "forget"
              ? "Forgetting…"
              : "Saving…"
            : buttons.approve}
        </button>
      </div>
    </section>
  );
}
