import type { JSX } from "react";
import { useCallback, useState } from "react";

import { Check } from "lucide-react";

import { cn } from "~/lib/utils";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "~/pendingUserInput";

import { describeAnswer, type QuestionCardItem, type UserInputAnswers } from "./questionCards";

type Drafts = Record<string, PendingUserInputDraftAnswer>;

const CARD_CLASS =
  "rounded-[var(--personal-radius-card)] border border-[var(--personal-review-border)] bg-[var(--personal-review-bg)] p-3.5";
const SETTLED_CARD_CLASS =
  "rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-surface)] p-3.5";

/**
 * A question the bot asked, answered here in the chat instead of in the
 * developer view. One option per row, full width, tall enough to tap, and
 * wrapping rather than truncating: option labels are whole sentences often
 * enough that a phone-width truncation would hide the difference between them.
 */
export function QuestionCard({
  card,
  botName,
  responding,
  onAnswer,
  onDismiss,
}: {
  card: QuestionCardItem;
  botName: string;
  responding: boolean;
  onAnswer: (requestId: string, answers: UserInputAnswers) => void;
  onDismiss: (requestId: string) => void;
}): JSX.Element | null {
  if (card.kind === "pending") {
    return (
      <PendingQuestionCard
        card={card}
        botName={botName}
        responding={responding}
        onAnswer={onAnswer}
        onDismiss={onDismiss}
      />
    );
  }

  if (card.kind === "answered") {
    return (
      <section aria-label={`Your answer to ${botName}`} className={SETTLED_CARD_CLASS}>
        {card.questions.map((question) => {
          const chosen = describeAnswer(question, card.answers[question.id]);
          if (chosen.length === 0) return null;
          return (
            <div key={question.id} className="not-first:mt-2.5">
              <p className="text-[13px] break-words text-[var(--personal-text-secondary)]">
                {question.question}
              </p>
              <p className="mt-0.5 flex items-start gap-1.5 text-[15px] break-words text-[var(--personal-text)]">
                <Check aria-hidden="true" className="mt-[3px] size-4 shrink-0" strokeWidth={2.25} />
                <span>You answered: {chosen.join(", ")}</span>
              </p>
            </div>
          );
        })}
      </section>
    );
  }

  return (
    <section aria-label={`${botName}'s question closed`} className={SETTLED_CARD_CLASS}>
      <p className="text-[13px] break-words text-[var(--personal-text-secondary)]">
        {card.questions[0]?.question}
      </p>
      <p className="mt-0.5 text-[15px] text-[var(--personal-text-secondary)]">
        This question closed without an answer.
      </p>
    </section>
  );
}

function PendingQuestionCard({
  card,
  botName,
  responding,
  onAnswer,
  onDismiss,
}: {
  card: Extract<QuestionCardItem, { kind: "pending" }>;
  botName: string;
  responding: boolean;
  onAnswer: (requestId: string, answers: UserInputAnswers) => void;
  onDismiss: (requestId: string) => void;
}): JSX.Element | null {
  const questions = card.request.questions;
  const [drafts, setDrafts] = useState<Drafts>({});
  const [questionIndex, setQuestionIndex] = useState(0);
  const progress = derivePendingUserInputProgress(questions, drafts, questionIndex);
  const question = progress.activeQuestion;

  // A submit needs every question answered, so the card walks through them one
  // at a time and only sends once the last one resolves.
  const commit = useCallback(
    (nextDrafts: Drafts, index: number) => {
      setDrafts(nextDrafts);
      const isLast = index >= questions.length - 1;
      if (!isLast) {
        setQuestionIndex(index + 1);
        return;
      }
      const answers = buildPendingUserInputAnswers(questions, nextDrafts);
      if (answers === null) return;
      onAnswer(card.requestId, answers);
    },
    [card.requestId, onAnswer, questions],
  );

  if (question === null) return null;

  const allowsCustomAnswer = question.allowCustomAnswer !== false;
  const customAnswerActive = progress.customAnswer.trim().length > 0;
  const chooseOption = (optionValue: string) => {
    const nextDrafts: Drafts = {
      ...drafts,
      [question.id]: togglePendingUserInputOptionSelection(
        question,
        drafts[question.id],
        optionValue,
      ),
    };
    // Multi-select keeps collecting until the user says they are done; a
    // single-select tap is the whole answer, so it moves straight on.
    if (question.multiSelect) {
      setDrafts(nextDrafts);
      return;
    }
    commit(nextDrafts, progress.questionIndex);
  };

  return (
    <section aria-label={`${botName} asked you a question`} className={CARD_CLASS}>
      <p className="flex items-center gap-2 text-[13px] font-semibold text-[var(--personal-text-secondary)]">
        <span aria-hidden="true" className="size-2 rounded-full bg-[var(--personal-review)]" />
        <span className="min-w-0 break-words">{question.header}</span>
        {questions.length > 1 ? (
          <span className="ms-auto shrink-0 tabular-nums">
            {`${progress.questionIndex + 1} of ${questions.length}`}
          </span>
        ) : null}
      </p>
      <p className="mt-1.5 text-[15px] leading-[1.4] break-words text-[var(--personal-text)]">
        {question.question}
      </p>
      {question.multiSelect ? (
        <p className="mt-1 text-[13px] text-[var(--personal-text-secondary)]">
          Pick as many as you want.
        </p>
      ) : null}

      <div role="group" aria-label={question.question} className="mt-3 flex flex-col gap-2">
        {question.options.map((option) => {
          const optionValue = option.value ?? option.label;
          const isSelected =
            !customAnswerActive && progress.selectedOptionValues.includes(optionValue);
          return (
            <button
              key={optionValue}
              type="button"
              disabled={responding}
              aria-pressed={question.multiSelect ? isSelected : undefined}
              onClick={() => chooseOption(optionValue)}
              className={cn(
                "flex min-h-11 w-full items-start gap-2 rounded-[var(--personal-radius-button)] border px-3.5 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--personal-bg)] disabled:opacity-40",
                isSelected
                  ? "border-[var(--personal-primary)] bg-[var(--personal-primary)] text-[var(--personal-primary-text)]"
                  : "border-[var(--personal-border)] bg-[var(--personal-surface)] text-[var(--personal-text)]",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] leading-[1.35] font-medium break-words">
                  {option.label}
                </span>
                {option.description && option.description !== option.label ? (
                  <span
                    className={cn(
                      "mt-0.5 block text-[13px] leading-[1.35] break-words",
                      isSelected
                        ? "text-[var(--personal-primary-text)] opacity-80"
                        : "text-[var(--personal-text-secondary)]",
                    )}
                  >
                    {option.description}
                  </span>
                ) : null}
              </span>
              {isSelected ? (
                <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0" strokeWidth={2.25} />
              ) : null}
            </button>
          );
        })}
      </div>

      {allowsCustomAnswer ? (
        <label className="mt-2.5 block">
          <span className="text-[13px] text-[var(--personal-text-secondary)]">
            Or type your own answer
          </span>
          <input
            type="text"
            value={progress.customAnswer}
            disabled={responding}
            enterKeyHint="send"
            onChange={(event) => {
              setDrafts((current) => ({
                ...current,
                [question.id]: setPendingUserInputCustomAnswer(
                  current[question.id],
                  event.target.value,
                ),
              }));
            }}
            className="mt-1 h-11 w-full rounded-[var(--personal-radius-button)] border border-[var(--personal-border)] bg-[var(--personal-surface)] px-3 text-[16px] text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40"
          />
        </label>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {progress.questionIndex > 0 ? (
          <button
            type="button"
            disabled={responding}
            onClick={() => setQuestionIndex(progress.questionIndex - 1)}
            className="h-11 rounded-[var(--personal-radius-button)] border border-[var(--personal-border)] bg-[var(--personal-surface)] px-3.5 text-[15px] font-medium text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40"
          >
            Back
          </button>
        ) : null}
        {card.request.dismissible ? (
          <button
            type="button"
            disabled={responding}
            onClick={() => onDismiss(card.requestId)}
            className="h-11 rounded-[var(--personal-radius-button)] px-3.5 text-[15px] font-medium text-[var(--personal-text-secondary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40"
          >
            Not now
          </button>
        ) : null}
        {question.multiSelect || customAnswerActive ? (
          <button
            type="button"
            disabled={responding || !progress.canAdvance}
            onClick={() => commit(drafts, progress.questionIndex)}
            className="ms-auto h-11 min-w-24 rounded-[var(--personal-radius-button)] bg-[var(--personal-primary)] px-4 text-[15px] font-medium text-[var(--personal-primary-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--personal-bg)] disabled:opacity-40"
          >
            {progress.isLastQuestion ? "Send answer" : "Next"}
          </button>
        ) : null}
      </div>
      {responding ? (
        <p className="mt-2 text-[13px] text-[var(--personal-text-secondary)]">
          Sending your answer
        </p>
      ) : null}
    </section>
  );
}
