import type { PendingUserInput } from "@t3tools/client-runtime/pending-requests";
import type { ApprovalRequestId, OrchestrationThreadActivity } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { describeAnswer, deriveQuestionCards, deriveUserInputResolutions } from "./questionCards";

const question = {
  id: "scope",
  header: "Scope",
  question: "What should I do first?",
  options: [
    { label: "Fix the tests", description: "Green the suite before anything else", value: "tests" },
    { label: "Ship the feature", description: "", value: "ship" },
  ],
  multiSelect: false,
} as const;

function request(requestId: string, createdAt = "2026-09-16T10:00:00.000Z"): PendingUserInput {
  return {
    requestId: requestId as ApprovalRequestId,
    createdAt,
    questions: [question],
    dismissible: true,
  };
}

function resolvedActivity(requestId: string, answers?: unknown): OrchestrationThreadActivity {
  return {
    id: `activity-${requestId}`,
    kind: "user-input.resolved",
    summary: "User input submitted",
    tone: "info",
    turnId: null,
    createdAt: "2026-09-16T10:00:05.000Z",
    payload: { requestId, ...(answers === undefined ? {} : { answers }) },
  } as unknown as OrchestrationThreadActivity;
}

it("keeps a question waiting while it is still pending", () => {
  const cards = deriveQuestionCards([request("req-1")], new Map(), new Map());
  expect(cards).toHaveLength(1);
  expect(cards[0]?.kind).toBe("pending");
});

it("shows what was chosen once the question resolves", () => {
  const seen = new Map([["req-1", request("req-1")]]);
  const resolutions = deriveUserInputResolutions([resolvedActivity("req-1", { scope: "tests" })]);
  const cards = deriveQuestionCards([], seen, resolutions);
  expect(cards).toHaveLength(1);
  const card = cards[0]!;
  expect(card.kind).toBe("answered");
  if (card.kind !== "answered") return;
  expect(describeAnswer(card.questions[0]!, card.answers.scope)).toEqual(["Fix the tests"]);
});

it("marks a question closed when it resolves without an answer", () => {
  // A cancelled request, or a turn that died under it: resolved, no answers.
  const seen = new Map([["req-1", request("req-1")]]);
  const cards = deriveQuestionCards(
    [],
    seen,
    deriveUserInputResolutions([resolvedActivity("req-1")]),
  );
  expect(cards[0]?.kind).toBe("closed");
});

it("marks a question closed when it disappears with no resolution at all", () => {
  const seen = new Map([["req-1", request("req-1")]]);
  expect(deriveQuestionCards([], seen, new Map())[0]?.kind).toBe("closed");
});

it("orders cards oldest first", () => {
  const older = request("req-1", "2026-09-16T09:00:00.000Z");
  const newer = request("req-2", "2026-09-16T11:00:00.000Z");
  const cards = deriveQuestionCards(
    [newer],
    new Map([
      ["req-2", newer],
      ["req-1", older],
    ]),
    deriveUserInputResolutions([resolvedActivity("req-1", { scope: "ship" })]),
  );
  expect(cards.map((card) => card.requestId)).toEqual(["req-1", "req-2"]);
});

it("ignores answers that are not strings", () => {
  const resolutions = deriveUserInputResolutions([resolvedActivity("req-1", { scope: 7 })]);
  expect(resolutions.get("req-1")).toBeNull();
});

it("reads a multi-select answer as every chosen label", () => {
  const multi = {
    ...question,
    multiSelect: true,
  } as const;
  expect(describeAnswer(multi, ["tests", "ship"])).toEqual(["Fix the tests", "Ship the feature"]);
});

it("shows a typed answer as typed", () => {
  expect(describeAnswer(question, "neither, rewrite it")).toEqual(["neither, rewrite it"]);
});
