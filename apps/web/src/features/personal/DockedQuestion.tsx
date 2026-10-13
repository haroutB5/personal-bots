import type { JSX } from "react";
import { useEffect, useRef } from "react";

import { Check } from "lucide-react";
import type { PendingUserInputProgress } from "~/pendingUserInput";

import { cn } from "~/lib/utils";

import type { QuestionCardItem } from "./questionCards";
import { REQUEST_WASH_ATTRIBUTE } from "./requestLanding";

/**
 * The bot's open question, docked above the composer (SPEC 2.9): an amber dot
 * and "Juno asks", "1 of 2" with a step dot per question, the question in
 * headline, then the options as 48 px rows (label left, any detail right). With
 * the keyboard up the options become one sideways row of 44 px chips so the
 * thread above them stays visible. A single-select tap is the answer and the
 * dock moves on (or submits); a multi-select set collects and keeps its own
 * "Send answer". A fast second tap on the same option never sends twice.
 */
export function DockedQuestion({
  card,
  botName,
  responding,
  keyboardOpen,
  progress,
  onChoose,
  onSubmit,
  onDismiss,
  highlight = false,
}: {
  card: Extract<QuestionCardItem, { readonly kind: "pending" }>;
  botName: string;
  responding: boolean;
  /** The composer has the keyboard: the options go sideways as chips (D9). */
  keyboardOpen: boolean;
  progress: PendingUserInputProgress;
  onChoose: (optionValue: string) => void;
  onSubmit: () => void;
  onDismiss: () => void;
  /** The chat opened at this request (`?request=`): the dock takes the wash (D13). */
  highlight?: boolean;
}): JSX.Element | null {
  const question = progress.activeQuestion;
  const sentRef = useRef(false);
  // The question changes (next of a set, or a new ask): the guard starts over.
  useEffect(() => {
    sentRef.current = false;
  }, [card.requestId, progress.questionIndex]);
  // A refused answer comes back with nothing responding: allow a retry.
  useEffect(() => {
    if (!responding) sentRef.current = false;
  }, [responding]);

  if (question === null) return null;
  const total = card.request.questions.length;
  const current = progress.questionIndex + 1;
  const choose = (optionValue: string) => {
    if (sentRef.current || responding) return;
    sentRef.current = true;
    onChoose(optionValue);
  };
  const options = question.options.map((option) => {
    const optionValue = option.value ?? option.label;
    return {
      value: optionValue,
      label: option.label,
      detail: option.description ?? null,
      selected: !progress.usingCustomAnswer && progress.selectedOptionValues.includes(optionValue),
    };
  });

  return (
    <section
      role="group"
      aria-label={`${botName}'s question, ${current} of ${total}`}
      data-testid="docked-question"
      className="personal-dock"
      {...(highlight ? { [REQUEST_WASH_ATTRIBUTE]: "" } : {})}
    >
      <div className="flex h-5 items-center gap-2 px-1 text-[13px] leading-4 font-semibold text-[var(--personal-state-needs)]">
        <span
          aria-hidden="true"
          className="size-2 shrink-0 rounded-full bg-[var(--personal-state-needs)]"
        />
        <span className="min-w-0 truncate">{botName} asks</span>
        <span className="ms-auto flex shrink-0 items-center gap-1.5 text-[var(--personal-text-secondary)] tabular-nums">
          <span>
            {current} of {total}
          </span>
          <span aria-hidden="true" className="flex items-center gap-1">
            {card.request.questions.map((entry, index) => (
              <i
                key={entry.id}
                className={cn(
                  "size-1.5 rounded-full",
                  index === progress.questionIndex
                    ? "bg-[var(--personal-text)]"
                    : "bg-[var(--personal-border-strong)]",
                )}
              />
            ))}
          </span>
        </span>
      </div>
      <p className="mt-2 mb-3 px-1 text-[17px] leading-[22px] font-semibold text-[var(--personal-text)]">
        {question.question}
      </p>
      {question.multiSelect ? (
        <p className="mb-2 px-1 text-[13px] leading-4 text-[var(--personal-text-secondary)]">
          Pick as many as you want.
        </p>
      ) : null}

      {/* Both layouts stay mounted; the keyboard only picks which one shows.
          Mounting one in place of the other swapped the buttons under a finger
          that was already on its way down, and the answer was lost. */}
      <div
        role="group"
        aria-label={question.question}
        data-testid="docked-question-chips"
        className={cn("personal-dock-chips", !keyboardOpen && "hidden")}
      >
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            disabled={responding}
            aria-pressed={question.multiSelect ? option.selected : undefined}
            onClick={() => choose(option.value)}
            className={cn(
              "personal-dock-chip",
              option.selected && "personal-dock-chip-on",
              "disabled:opacity-40",
            )}
          >
            {option.selected ? (
              <Check aria-hidden="true" className="size-4 shrink-0" strokeWidth={2.25} />
            ) : null}
            {option.label}
          </button>
        ))}
      </div>
      <div
        role="group"
        aria-label={question.question}
        data-testid="docked-question-rows"
        className={cn("flex flex-col gap-2", keyboardOpen && "hidden")}
      >
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            disabled={responding}
            aria-pressed={question.multiSelect ? option.selected : undefined}
            onClick={() => choose(option.value)}
            className={cn(
              "flex h-12 w-full items-center gap-2 rounded-[var(--personal-radius-control)] px-4 text-left text-[16px] leading-[22px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40",
              option.selected
                ? "bg-[var(--personal-primary)] text-[var(--personal-primary-text)]"
                : "bg-[var(--personal-fill-muted)] text-[var(--personal-text)]",
            )}
          >
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            {option.detail !== null && option.detail !== option.label ? (
              <span
                className={cn(
                  "shrink-0 text-[15px] leading-5 tabular-nums",
                  option.selected
                    ? "text-[var(--personal-primary-text)] opacity-80"
                    : "text-[var(--personal-text-secondary)]",
                )}
              >
                {option.detail}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {question.multiSelect || card.request.dismissible ? (
        <div className="mt-3 flex items-center gap-2 px-1">
          {card.request.dismissible ? (
            <button
              type="button"
              disabled={responding}
              onClick={onDismiss}
              className="h-11 rounded-[var(--personal-radius-control)] px-3 text-[15px] font-medium text-[var(--personal-text-secondary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40"
            >
              Not now
            </button>
          ) : null}
          {question.multiSelect ? (
            <button
              type="button"
              disabled={responding || !progress.canAdvance}
              onClick={onSubmit}
              className="ms-auto h-11 rounded-[var(--personal-radius-control)] bg-[var(--personal-primary)] px-4 text-[15px] font-medium text-[var(--personal-primary-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40"
            >
              Send answer
            </button>
          ) : null}
        </div>
      ) : null}
      {responding ? (
        <p className="mt-2 px-1 text-[13px] text-[var(--personal-text-secondary)]">
          Sending your answer
        </p>
      ) : null}
    </section>
  );
}
