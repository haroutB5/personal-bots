import type { OrchestrationV2ThreadProjection, UserInputQuestion } from "@t3tools/contracts";
import {
  createQuestionHistoryProjector,
  derivePendingThreadRequests,
} from "@t3tools/client-runtime/state/thread-requests";
import * as DateTime from "effect/DateTime";

import type { OrchestrationThreadActivity } from "./wireTypes.ts";

/** What the provider expects back: one answer per question id. */
export type UserInputAnswers = Record<string, string | ReadonlyArray<string>>;

/** One question request, in the shape the cards render. */
export interface QuestionRequest {
  readonly requestId: string;
  readonly createdAt: string;
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly dismissible: boolean;
}

/** The projection fields a question card is derived from. */
export type QuestionProjection = Pick<
  OrchestrationV2ThreadProjection,
  "visibleTurnItems" | "turnItems" | "runtimeRequests"
>;

/**
 * A question the bot asked, in the state the transcript should show it:
 * still waiting, answered (with what was chosen), or closed without an answer
 * because the turn ended, the agent cancelled it, or another device replied.
 */
export type QuestionCardItem =
  | {
      readonly kind: "pending";
      readonly requestId: string;
      readonly createdAt: string;
      readonly request: QuestionRequest;
    }
  | {
      readonly kind: "answered";
      readonly requestId: string;
      readonly createdAt: string;
      readonly questions: ReadonlyArray<UserInputQuestion>;
      readonly answers: UserInputAnswers;
    }
  | {
      readonly kind: "superseded";
      readonly requestId: string;
      readonly createdAt: string;
      readonly questions: ReadonlyArray<UserInputQuestion>;
    }
  | {
      readonly kind: "closed";
      readonly requestId: string;
      readonly createdAt: string;
      readonly questions: ReadonlyArray<UserInputQuestion>;
    };

function coerceAnswer(value: unknown): string | string[] | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value as string[];
  }
  return null;
}

/**
 * Every question this thread has already settled, and how.
 *
 * `user-input.resolved` carries the answers when someone replied and carries
 * none when the question was dismissed or the turn died under it, so a `null`
 * value means "closed, no answer" rather than "not resolved".
 */
export function deriveUserInputResolutions(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyMap<string, UserInputAnswers | "superseded" | null> {
  const resolutions = new Map<string, UserInputAnswers | "superseded" | null>();
  const latestAsk = new Map<string, string>();
  const latestResolution = new Map<string, string>();
  for (const activity of activities) {
    if (activity.kind !== "user-input.requested") continue;
    const payload = activity.payload;
    if (typeof payload !== "object" || payload === null) continue;
    const requestId = (payload as { requestId?: unknown }).requestId;
    if (typeof requestId === "string" && (latestAsk.get(requestId) ?? "") < activity.createdAt) {
      latestAsk.set(requestId, activity.createdAt);
    }
  }
  for (const activity of activities) {
    if (activity.kind !== "user-input.resolved") continue;
    const payload = activity.payload;
    if (typeof payload !== "object" || payload === null) continue;
    const requestId = (payload as { requestId?: unknown }).requestId;
    if (typeof requestId !== "string") continue;
    if ((latestAsk.get(requestId) ?? "") > activity.createdAt) continue;
    if ((latestResolution.get(requestId) ?? "") > activity.createdAt) continue;
    latestResolution.set(requestId, activity.createdAt);
    if ((payload as { responseMode?: unknown }).responseMode === "superseded") {
      resolutions.set(requestId, "superseded");
      continue;
    }
    const rawAnswers = (payload as { answers?: unknown }).answers;
    if (typeof rawAnswers !== "object" || rawAnswers === null || Array.isArray(rawAnswers)) {
      resolutions.set(requestId, null);
      continue;
    }
    const answers: UserInputAnswers = {};
    for (const [questionId, value] of Object.entries(rawAnswers as Record<string, unknown>)) {
      const answer = coerceAnswer(value);
      if (answer !== null) answers[questionId] = answer;
    }
    resolutions.set(requestId, Object.keys(answers).length > 0 ? answers : null);
  }
  return resolutions;
}

/**
 * The question requests the thread is still waiting on, from the v2
 * projection's runtime requests plus the turn item that carries the wording.
 */
export function pendingQuestionRequests(
  projection: QuestionProjection,
): ReadonlyArray<QuestionRequest> {
  return derivePendingThreadRequests(projection).userInputs.map((request) => ({
    requestId: request.requestId,
    createdAt: request.createdAt,
    questions: request.questions,
    dismissible: request.dismissible,
  }));
}

function questionAnswers(raw: Record<string, unknown>): UserInputAnswers | null {
  const answers: UserInputAnswers = {};
  for (const [questionId, value] of Object.entries(raw)) {
    const answer = coerceAnswer(value);
    if (answer !== null) answers[questionId] = answer;
  }
  return Object.keys(answers).length > 0 ? answers : null;
}

/**
 * Cards from the live requests plus the visible user_input_request history.
 * Create it once per chat: it keeps the history projector's cache.
 */
export function createQuestionCardProjector() {
  const projectHistory = createQuestionHistoryProjector();
  return (
    projection: QuestionProjection,
    remembered: ReadonlyMap<string, QuestionRequest> = new Map(),
  ): ReadonlyArray<QuestionCardItem> => {
    const pending = pendingQuestionRequests(projection);
    const pendingIds = new Set(pending.map((request) => request.requestId));
    const requests = new Map(projection.runtimeRequests.map((request) => [request.id, request]));
    const seen = new Map<string, QuestionRequest>(remembered);
    const resolutions = new Map<string, UserInputAnswers | "superseded" | null>();
    for (const row of projectHistory(projection)) {
      const item = row.item;
      if (item.type !== "user_input_request") continue;
      // A pending request is the card above, not history.
      if (pendingIds.has(item.requestId)) continue;
      const request = requests.get(item.requestId);
      const answers =
        item.questionAnswer !== undefined
          ? questionAnswers(item.questionAnswer.answers)
          : request?.status === "resolved" && request.answers !== undefined
            ? questionAnswers(request.answers)
            : null;
      seen.set(item.requestId, {
        requestId: item.requestId,
        createdAt: DateTime.formatIso(item.startedAt ?? item.updatedAt),
        questions: item.questions,
        dismissible:
          item.responseMode === "message" || request?.responseCapability.type === "message",
      });
      resolutions.set(item.requestId, answers);
    }
    return deriveQuestionCards(pending, seen, resolutions);
  };
}

/**
 * The cards to render, oldest first.
 * `seen` is every request this screen has shown so far: once a question is
 * answered it leaves `pending`, and without that memory the card would vanish
 */
export function deriveQuestionCards(
  pending: ReadonlyArray<QuestionRequest>,
  seen: ReadonlyMap<string, QuestionRequest>,
  resolutions: ReadonlyMap<string, UserInputAnswers | "superseded" | null>,
): ReadonlyArray<QuestionCardItem> {
  const pendingById = new Map(pending.map((request) => [request.requestId, request]));
  const requests = new Map<string, QuestionRequest>(seen);
  for (const [requestId, request] of pendingById) {
    if (!requests.has(requestId)) requests.set(requestId, request);
  }

  const cards: QuestionCardItem[] = [];
  for (const [requestId, request] of requests) {
    const live = pendingById.get(requestId);
    if (live) {
      cards.push({ kind: "pending", requestId, createdAt: live.createdAt, request: live });
      continue;
    }
    const answers = resolutions.get(requestId) ?? null;
    if (answers === "superseded") {
      cards.push({
        kind: "superseded",
        requestId,
        createdAt: request.createdAt,
        questions: request.questions,
      });
      continue;
    }
    if (answers !== null) {
      cards.push({
        kind: "answered",
        requestId,
        createdAt: request.createdAt,
        questions: request.questions,
        answers,
      });
      continue;
    }
    cards.push({
      kind: "closed",
      requestId,
      createdAt: request.createdAt,
      questions: request.questions,
    });
  }
  return cards.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/**
 * The human-readable answer to one question: option labels where the value
 * matches an option, the typed text where it does not.
 */
export function describeAnswer(
  question: UserInputQuestion,
  answer: string | ReadonlyArray<string> | undefined,
): ReadonlyArray<string> {
  if (answer === undefined) return [];
  const values = Array.isArray(answer) ? answer : [answer];
  return values
    .filter((value) => value.trim().length > 0)
    .map((value) => {
      const option = question.options.find((entry) => (entry.value ?? entry.label) === value);
      return option ? option.label : value;
    });
}
