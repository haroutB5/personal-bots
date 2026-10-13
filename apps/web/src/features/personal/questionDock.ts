import { useCallback, useState } from "react";

import type { UserInputQuestion } from "@t3tools/contracts";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  resolvePendingUserInputAnswer,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
  type PendingUserInputProgress,
} from "~/pendingUserInput";

import type { QuestionCardItem, UserInputAnswers } from "./questionCards";

export type QuestionDrafts = Record<string, PendingUserInputDraftAnswer>;

/**
 * The drafts of unfinished questions, by request: a typed answer survives
 * switching chats and comes back per question (SPEC 2.9, D5). Cleared once the
 * request shows answered or closed in the transcript.
 */
const draftsByRequest = new Map<string, QuestionDrafts>();

export function readQuestionDrafts(requestId: string): QuestionDrafts {
  return draftsByRequest.get(requestId) ?? {};
}

export function writeQuestionDrafts(requestId: string, drafts: QuestionDrafts): void {
  draftsByRequest.set(requestId, drafts);
}

export function clearQuestionDrafts(requestId: string): void {
  draftsByRequest.delete(requestId);
}

/** The first question without an answer yet: where the dock opens. */
export function firstOpenQuestionIndex(
  questions: ReadonlyArray<UserInputQuestion>,
  drafts: QuestionDrafts,
): number {
  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index];
    if (
      question !== undefined &&
      resolvePendingUserInputAnswer(question, drafts[question.id]) === null
    ) {
      return index;
    }
  }
  return Math.max(0, questions.length - 1);
}

export interface QuestionDock {
  readonly progress: PendingUserInputProgress;
  /** Drafts so far, for the composer's typed answer. */
  readonly drafts: QuestionDrafts;
  /** A single-select tap: the option is the answer; multi-select collects instead. */
  readonly chooseOption: (optionValue: string) => void;
  /** The composer's Send while the question is docked: the typed text answers the active question. */
  readonly answerWithText: (text: string) => void;
  /** The multi-select set's own "Send answer". */
  readonly submit: () => void;
}

type PendingQuestionCard = Extract<QuestionCardItem, { readonly kind: "pending" }>;

interface DockState {
  readonly requestId: string | null;
  readonly index: number;
  readonly drafts: QuestionDrafts;
}

function initialState(
  requestId: string | null,
  questions: ReadonlyArray<UserInputQuestion>,
): DockState {
  if (requestId === null) return { requestId: null, index: 0, drafts: {} };
  const drafts = readQuestionDrafts(requestId);
  return { requestId, index: firstOpenQuestionIndex(questions, drafts), drafts };
}

/**
 * The docked question's own state (SPEC 2.9): which question of the set is
 * active, what has been answered so far and what the composer's typed answer
 * means. The screen holds it so the dock and the composer share one truth.
 */
export function useQuestionDock(
  card: PendingQuestionCard | null,
  onAnswer: (requestId: string, answers: UserInputAnswers) => void,
): QuestionDock | null {
  const requestId = card?.requestId ?? null;
  const questions = card?.request.questions ?? [];
  const [state, setState] = useState<DockState>(() => initialState(requestId, questions));

  // A different question took the dock (the previous one was answered or
  // closed, or the owner switched chats): open where this one left off.
  if (state.requestId !== requestId) {
    setState(initialState(requestId, questions));
  }

  const commit = useCallback(
    (next: DockState, answers: UserInputAnswers | null, request: string | null) => {
      setState(next);
      if (next.requestId !== null) writeQuestionDrafts(next.requestId, next.drafts);
      if (answers !== null && request !== null) onAnswer(request, answers);
    },
    [onAnswer],
  );

  const progress = derivePendingUserInputProgress(questions, state.drafts, state.index);

  const chooseOption = useCallback(
    (optionValue: string) => {
      const question = progress.activeQuestion;
      if (question === null || requestId === null) return;
      const drafts: QuestionDrafts = {
        ...state.drafts,
        [question.id]: togglePendingUserInputOptionSelection(
          question,
          state.drafts[question.id],
          optionValue,
        ),
      };
      // A multi-select set keeps collecting until its own Send answer; a
      // single-select tap is the whole question and moves straight on. The
      // last question of a set submits everything answered so far.
      const nextIndex = question.multiSelect
        ? state.index
        : Math.min(state.index + 1, Math.max(0, questions.length - 1));
      const answers = question.multiSelect ? null : buildPendingUserInputAnswers(questions, drafts);
      commit({ requestId, index: nextIndex, drafts }, answers, requestId);
    },
    [commit, progress.activeQuestion, questions, requestId, state.drafts, state.index],
  );

  const answerWithText = useCallback(
    (text: string) => {
      const question = progress.activeQuestion;
      if (question === null || requestId === null || text.trim().length === 0) return;
      if (question.allowCustomAnswer === false) return;
      const drafts: QuestionDrafts = {
        ...state.drafts,
        [question.id]: setPendingUserInputCustomAnswer(state.drafts[question.id], text),
      };
      const nextIndex = Math.min(state.index + 1, Math.max(0, questions.length - 1));
      commit(
        { requestId, index: nextIndex, drafts },
        buildPendingUserInputAnswers(questions, drafts),
        requestId,
      );
    },
    [commit, progress.activeQuestion, questions, requestId, state.drafts, state.index],
  );

  const submit = useCallback(() => {
    if (requestId === null) return;
    commit(state, buildPendingUserInputAnswers(questions, state.drafts), requestId);
  }, [commit, questions, requestId, state]);

  if (card === null) return null;

  return { progress, drafts: state.drafts, chooseOption, answerWithText, submit };
}
