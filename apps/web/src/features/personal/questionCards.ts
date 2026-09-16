import type { PendingUserInput } from "@t3tools/client-runtime/pending-requests";
import type { OrchestrationThreadActivity, UserInputQuestion } from "@t3tools/contracts";

/** What the provider expects back: one answer per question id. */
export type UserInputAnswers = Record<string, string | string[]>;

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
      readonly request: PendingUserInput;
    }
  | {
      readonly kind: "answered";
      readonly requestId: string;
      readonly createdAt: string;
      readonly questions: ReadonlyArray<UserInputQuestion>;
      readonly answers: UserInputAnswers;
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
): ReadonlyMap<string, UserInputAnswers | null> {
  const resolutions = new Map<string, UserInputAnswers | null>();
  for (const activity of activities) {
    if (activity.kind !== "user-input.resolved") continue;
    const payload = activity.payload;
    if (typeof payload !== "object" || payload === null) continue;
    const requestId = (payload as { requestId?: unknown }).requestId;
    if (typeof requestId !== "string") continue;
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
 * The cards to render, oldest first.
 *
 * `seen` is every request this screen has shown so far: once a question is
 * answered it leaves `pending`, and without that memory the card would vanish
 * mid-tap with no record of what was chosen. Questions answered before this
 * screen mounted are not in `seen`, so old history stays out of the way.
 */
export function deriveQuestionCards(
  pending: ReadonlyArray<PendingUserInput>,
  seen: ReadonlyMap<string, PendingUserInput>,
  resolutions: ReadonlyMap<string, UserInputAnswers | null>,
): ReadonlyArray<QuestionCardItem> {
  const pendingById = new Map(pending.map((request) => [request.requestId as string, request]));
  const requests = new Map<string, PendingUserInput>(seen);
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
  answer: string | string[] | undefined,
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
