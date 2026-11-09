import {
  NodeId,
  ProviderSessionId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";

import {
  createQuestionCardProjector,
  describeAnswer,
  type QuestionProjection,
} from "./questionCards.ts";

const threadId = ThreadId.make("thread-1");
const at = (iso: string) => DateTime.makeUnsafe(iso);
const askedAt = at("2026-11-09T10:20:00.000Z");
const answeredAt = at("2026-11-09T10:20:05.000Z");

const question = (id: string, text: string) => ({
  id,
  header: "Deploy",
  question: text,
  options: [
    { label: "Staging", description: "The safe one" },
    { label: "Production", description: "The real one" },
  ],
  multiSelect: false,
});

const itemBase = {
  threadId,
  runId: RunId.make("run-1"),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  title: null,
  startedAt: askedAt,
  completedAt: null,
  updatedAt: askedAt,
} as const;

const askItem = (input: {
  requestId: string;
  questions: ReadonlyArray<ReturnType<typeof question>>;
  status?: OrchestrationV2TurnItem["status"];
  questionAnswer?: Extract<
    OrchestrationV2TurnItem,
    { type: "user_input_request" }
  >["questionAnswer"];
}): OrchestrationV2TurnItem => ({
  ...itemBase,
  id: TurnItemId.make(`item-${input.requestId}`),
  ordinal: 1,
  status: input.status ?? "waiting",
  type: "user_input_request",
  requestId: RuntimeRequestId.make(input.requestId),
  questions: input.questions,
  ...(input.questionAnswer === undefined ? {} : { questionAnswer: input.questionAnswer }),
});

const request = (input: {
  id: string;
  status?: OrchestrationV2RuntimeRequest["status"];
  answers?: Record<string, unknown>;
}): OrchestrationV2RuntimeRequest => ({
  id: RuntimeRequestId.make(input.id),
  nodeId: NodeId.make(`node-${input.id}`),
  providerTurnId: null,
  nativeRequestRef: null,
  kind: "user_input",
  status: input.status ?? "pending",
  responseCapability: {
    type: "live",
    providerSessionId: ProviderSessionId.make("session-1"),
  },
  createdAt: askedAt,
  resolvedAt: input.status === undefined || input.status === "pending" ? null : answeredAt,
  ...(input.answers === undefined ? {} : { answers: input.answers }),
});

const projection = (input: {
  requests: ReadonlyArray<OrchestrationV2RuntimeRequest>;
  items: ReadonlyArray<OrchestrationV2TurnItem>;
}): QuestionProjection => ({
  turnItems: input.items,
  visibleTurnItems: input.items.map((item, position) => ({
    position,
    visibility: "local",
    sourceThreadId: threadId,
    sourceItemId: item.id,
    item,
  })),
  runtimeRequests: input.requests,
});

it("shows one pending card with the question text", () => {
  const cards = createQuestionCardProjector()(
    projection({
      items: [
        askItem({
          requestId: "req-1",
          questions: [question("env", "Which environment should I deploy to?")],
        }),
      ],
      requests: [request({ id: "req-1" })],
    }),
  );

  expect(cards).toHaveLength(1);
  const card = cards[0]!;
  expect(card.kind).toBe("pending");
  if (card.kind !== "pending") return;
  expect(card.requestId).toBe("req-1");
  expect(card.request.questions.map((entry) => entry.question)).toEqual([
    "Which environment should I deploy to?",
  ]);
});

it("shows the chosen answer once the request resolves", () => {
  const cards = createQuestionCardProjector()(
    projection({
      items: [
        askItem({
          requestId: "req-1",
          questions: [question("env", "Which environment should I deploy to?")],
          status: "completed",
        }),
      ],
      requests: [request({ id: "req-1", status: "resolved", answers: { env: "Staging" } })],
    }),
  );

  expect(cards).toHaveLength(1);
  const card = cards[0]!;
  expect(card.kind).toBe("answered");
  if (card.kind !== "answered") return;
  expect(card.answers).toEqual({ env: "Staging" });
  expect(describeAnswer(card.questions[0]!, card.answers.env)).toEqual(["Staging"]);
});

it("closes the card when the request is cancelled without an answer", () => {
  const cards = createQuestionCardProjector()(
    projection({
      items: [
        askItem({
          requestId: "req-1",
          questions: [question("env", "Which environment should I deploy to?")],
          status: "cancelled",
        }),
      ],
      requests: [request({ id: "req-1", status: "cancelled" })],
    }),
  );

  expect(cards).toHaveLength(1);
  expect(cards[0]?.kind).toBe("closed");
});

it("closes the card when a resolved request carries no answer", () => {
  const cards = createQuestionCardProjector()(
    projection({
      items: [
        askItem({
          requestId: "req-1",
          questions: [question("env", "Which environment should I deploy to?")],
          status: "cancelled",
        }),
      ],
      requests: [request({ id: "req-1", status: "resolved" })],
    }),
  );

  expect(cards).toHaveLength(1);
  expect(cards[0]?.kind).toBe("closed");
});

it("keeps every question of a request with several questions", () => {
  const cards = createQuestionCardProjector()(
    projection({
      items: [
        askItem({
          requestId: "req-1",
          questions: [
            question("env", "Which environment should I deploy to?"),
            question("db", "Which database should I use?"),
          ],
        }),
      ],
      requests: [request({ id: "req-1" })],
    }),
  );

  expect(cards).toHaveLength(1);
  const card = cards[0]!;
  expect(card.kind).toBe("pending");
  if (card.kind !== "pending") return;
  expect(card.request.questions.map((entry) => entry.question)).toEqual([
    "Which environment should I deploy to?",
    "Which database should I use?",
  ]);
});
