import {
  MessageId,
  PersonalBotId,
  PersonalSecretRequestId,
  ThreadId,
  type ApprovalRequestId,
  type EnvironmentId,
  type PersonalSecretRequest,
  type ScopedThreadRef,
  type UserInputQuestion,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { act, create, type ReactTestRenderer, type ReactTestInstance } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import type { ConversationItem } from "./conversationModel";
import { MessageList } from "./MessageList";
import type { QuestionCardItem, UserInputAnswers } from "./questionCards";
import type { SecretRequestCardItem } from "./secretRequestCards";

/** Cards live in the transcript now, so tests hand them to `items` too. */
const questionItem = (card: QuestionCardItem): ConversationItem => ({
  kind: "question",
  id: `question:${card.requestId}`,
  card,
});

const secretItem = (card: SecretRequestCardItem): ConversationItem => ({
  kind: "secret",
  id: `secret:${card.requestId}`,
  card,
});

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: React.PropsWithChildren) => children,
}));
vi.mock("~/assets/assetUrls", () => ({ useAssetUrls: () => [null] }));
vi.mock("~/components/ChatMarkdown", () => ({ default: ({ text }: { text: string }) => text }));
vi.mock("~/components/chat/MessagesTimeline.logic", () => ({
  shouldPreserveAssistantLineBreaks: () => false,
}));
vi.mock("~/session-logic", () => ({
  selectMessageImageResources: () => [
    { _tag: "attachment", attachmentId: "thread-1-dead-attachment" },
  ],
}));
vi.mock("./ToolDetails", () => ({ ToolDetails: () => null }));

let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

function stubEnvironment(): void {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
}

const BASE_PROPS = {
  environmentId: "env-1" as EnvironmentId,
  threadRef: { threadId: "thread-1" } as ScopedThreadRef,
  items: [],
  pending: [],
  working: false,
  botName: "Assistant",
  workspaceRoot: undefined,
  approvals: [],
  respondingIds: new Set<string>(),
  onRespondToApproval: () => {},
  onAnswerQuestion: () => {},
  onDismissQuestion: () => {},
  onProvideSecret: () => {},
  onDeclineSecret: () => {},
  errorText: null,
  loadEarlier: null,
  now: new Date("2026-09-14T10:01:00.000Z"),
  describeTurn: () => "",
  renderDelegation: () => null,
} as const;

const SCOPE_QUESTION = {
  id: "scope",
  header: "Scope",
  question: "What should I do first?",
  options: [
    { label: "Fix the failing tests", description: "Green the suite first", value: "tests" },
    { label: "Ship the feature", description: "", value: "ship" },
  ],
  multiSelect: false,
} as const;

function pendingCard(
  overrides: Partial<{
    questions: ReadonlyArray<UserInputQuestion>;
    dismissible: boolean;
  }> = {},
): QuestionCardItem {
  return {
    kind: "pending",
    requestId: "req-1",
    createdAt: "2026-09-14T10:00:00.000Z",
    request: {
      requestId: "req-1" as ApprovalRequestId,
      createdAt: "2026-09-14T10:00:00.000Z",
      questions: overrides.questions ?? [SCOPE_QUESTION],
      dismissible: overrides.dismissible ?? true,
    },
  };
}

const PENDING_SECRET: SecretRequestCardItem = {
  kind: "pending",
  requestId: "secret-1",
  createdAtMs: Date.parse("2026-09-14T10:00:00.000Z"),
  request: {
    requestId: PersonalSecretRequestId.make("secret-1"),
    taskId: null,
    rootTaskId: null,
    threadId: ThreadId.make("thread-1"),
    botId: PersonalBotId.make("bot-1"),
    name: "GITHUB_TOKEN",
    label: "GitHub token",
    purpose: "Push the release tag.",
    status: "pending",
    shared: false,
    createdAt: DateTime.makeUnsafe("2026-09-14T10:00:00.000Z"),
    fulfilledAt: null,
  } satisfies PersonalSecretRequest,
};

function optionButton(label: string): ReactTestInstance {
  return renderer!.root.find(
    (node) =>
      node.type === "button" &&
      node.findAll((child) => child.children.includes(label), { deep: true }).length > 0,
  );
}

it("renders a missing image attachment as an inert placeholder", async () => {
  stubEnvironment();
  await act(async () => {
    renderer = create(
      <MessageList
        {...BASE_PROPS}
        items={[
          {
            kind: "message",
            id: "message-1",
            message: {
              id: MessageId.make("message-1"),
              role: "user",
              text: "See attached",
              attachments: [
                {
                  type: "image",
                  id: "thread-1-dead-attachment",
                  name: "deleted.png",
                  mimeType: "image/png",
                  sizeBytes: 10,
                },
              ],
              turnId: null,
              streaming: false,
              createdAt: "2026-09-14T10:00:00.000Z",
              updatedAt: "2026-09-14T10:00:00.000Z",
            },
          },
        ]}
      />,
    );
  });

  expect(renderer!.root.findAllByType("img")).toEqual([]);
  expect(
    renderer!.root.findAll(
      (node) =>
        node.type === "span" &&
        typeof node.props.className === "string" &&
        node.props.className.includes("size-24") &&
        node.props.className.includes("personal-fill-muted"),
    ),
  ).toHaveLength(1);
});

it("answers a single-select question with one tap, in this view", async () => {
  stubEnvironment();
  const answered: Array<[string, UserInputAnswers]> = [];
  await act(async () => {
    renderer = create(
      <MessageList
        {...BASE_PROPS}
        items={[questionItem(pendingCard())]}
        onAnswerQuestion={(requestId, answers) => answered.push([requestId, answers])}
      />,
    );
  });

  // The escape hatch into the developer view is gone: answering happens here.
  expect(
    renderer!.root.findAll((node) => node.children.includes("Answer in Developer view")),
  ).toEqual([]);
  // Option descriptions are part of the choice, not decoration.
  expect(
    renderer!.root.findAll((node) => node.children.includes("Green the suite first")),
  ).toHaveLength(1);

  await act(async () => optionButton("Fix the failing tests").props.onClick());
  expect(answered).toEqual([["req-1", { scope: "tests" }]]);
});

it("collects every pick before sending a multi-select answer", async () => {
  stubEnvironment();
  const answered: Array<[string, UserInputAnswers]> = [];
  await act(async () => {
    renderer = create(
      <MessageList
        {...BASE_PROPS}
        items={[
          questionItem(pendingCard({ questions: [{ ...SCOPE_QUESTION, multiSelect: true }] })),
        ]}
        onAnswerQuestion={(requestId, answers) => answered.push([requestId, answers])}
      />,
    );
  });

  await act(async () => optionButton("Fix the failing tests").props.onClick());
  expect(answered).toEqual([]);
  await act(async () => optionButton("Ship the feature").props.onClick());
  expect(answered).toEqual([]);
  await act(async () => optionButton("Send answer").props.onClick());
  expect(answered).toEqual([["req-1", { scope: ["tests", "ship"] }]]);
});

it("walks through several questions before submitting once", async () => {
  stubEnvironment();
  const answered: Array<[string, UserInputAnswers]> = [];
  const second = {
    ...SCOPE_QUESTION,
    id: "when",
    header: "When",
    question: "When should I start?",
    options: [{ label: "Right now", description: "", value: "now" }],
  } as const;
  await act(async () => {
    renderer = create(
      <MessageList
        {...BASE_PROPS}
        items={[questionItem(pendingCard({ questions: [SCOPE_QUESTION, second] }))]}
        onAnswerQuestion={(requestId, answers) => answered.push([requestId, answers])}
      />,
    );
  });

  expect(renderer!.root.findAll((node) => node.children.includes("1 of 2"))).toHaveLength(1);
  await act(async () => optionButton("Fix the failing tests").props.onClick());
  expect(answered).toEqual([]);
  await act(async () => optionButton("Right now").props.onClick());
  expect(answered).toEqual([["req-1", { scope: "tests", when: "now" }]]);
});

it("sends a typed answer when the question allows one", async () => {
  stubEnvironment();
  const answered: Array<[string, UserInputAnswers]> = [];
  await act(async () => {
    renderer = create(
      <MessageList
        {...BASE_PROPS}
        items={[questionItem(pendingCard())]}
        onAnswerQuestion={(requestId, answers) => answered.push([requestId, answers])}
      />,
    );
  });

  const input = renderer!.root.findByType("input");
  await act(async () => input.props.onChange({ target: { value: "neither, rewrite it" } }));
  await act(async () => optionButton("Send answer").props.onClick());
  expect(answered).toEqual([["req-1", { scope: "neither, rewrite it" }]]);
});

it("closes an async question without answering it", async () => {
  stubEnvironment();
  const dismissed: string[] = [];
  await act(async () => {
    renderer = create(
      <MessageList
        {...BASE_PROPS}
        items={[questionItem(pendingCard())]}
        onDismissQuestion={(requestId) => dismissed.push(requestId)}
      />,
    );
  });

  await act(async () => optionButton("Not now").props.onClick());
  expect(dismissed).toEqual(["req-1"]);
});

it("keeps the answer on screen once the question resolves", async () => {
  stubEnvironment();
  await act(async () => {
    renderer = create(
      <MessageList
        {...BASE_PROPS}
        items={[
          questionItem({
            kind: "answered",
            requestId: "req-1",
            createdAt: "2026-09-14T10:00:00.000Z",
            questions: [SCOPE_QUESTION],
            answers: { scope: "tests" },
          }),
        ]}
      />,
    );
  });

  expect(
    renderer!.root.findAll((node) => node.children.includes("Fix the failing tests")),
  ).not.toEqual([]);
  expect(renderer!.root.findAllByType("button")).toEqual([]);
});

it("says so when a question is closed elsewhere", async () => {
  stubEnvironment();
  await act(async () => {
    renderer = create(
      <MessageList
        {...BASE_PROPS}
        items={[
          questionItem({
            kind: "closed",
            requestId: "req-1",
            createdAt: "2026-09-14T10:00:00.000Z",
            questions: [SCOPE_QUESTION],
          }),
        ]}
      />,
    );
  });

  expect(
    renderer!.root.findAll((node) =>
      node.children.includes("This question closed without an answer."),
    ),
  ).toHaveLength(1);
  expect(renderer!.root.findAllByType("button")).toEqual([]);
});

it("shows a secret the bot asked for, and sends the typed value once", async () => {
  stubEnvironment();
  const provided: Array<[string, string]> = [];
  await act(async () => {
    renderer = create(
      <MessageList
        {...BASE_PROPS}
        items={[secretItem(PENDING_SECRET)]}
        onProvideSecret={(requestId, value) => provided.push([requestId, value])}
      />,
    );
  });

  // The ask is readable without opening anything: what, and what for.
  expect(renderer!.root.findAll((node) => node.children.includes("GitHub token"))).not.toEqual([]);
  expect(
    renderer!.root.findAll((node) => node.children.includes("Push the release tag.")),
  ).toHaveLength(1);

  const input = renderer!.root.findByType("input");
  // Never a plain text field, and never offered to the phone's autofill.
  expect(input.props.type).toBe("password");
  expect(input.props.autoComplete).toBe("off");

  // Empty is not sendable: an empty value is an error the server would reject.
  expect(optionButton("Save secret").props.disabled).toBe(true);
  await act(async () => input.props.onChange({ target: { value: "ghp_live_value" } }));
  await act(async () => optionButton("Save secret").props.onClick());
  expect(provided).toEqual([["secret-1", "ghp_live_value"]]);

  // The field is cleared before the send, so the value is nowhere in the tree.
  expect(renderer!.root.findByType("input").props.value).toBe("");
  expect(JSON.stringify(renderer!.toJSON())).not.toContain("ghp_live_value");
});

it("declines a secret request without providing a value", async () => {
  stubEnvironment();
  const declined: string[] = [];
  await act(async () => {
    renderer = create(
      <MessageList
        {...BASE_PROPS}
        items={[secretItem(PENDING_SECRET)]}
        onDeclineSecret={(requestId) => declined.push(requestId)}
      />,
    );
  });

  // Not "Not now": declining cancels the request and fails the waiting task.
  expect(
    renderer!.root.findAll((node) =>
      node.children.includes("Declining stops this task. You can retry it from Tasks later."),
    ),
  ).toHaveLength(1);
  await act(async () => optionButton("Decline").props.onClick());
  expect(declined).toEqual(["secret-1"]);
});

it("keeps a settled secret request on screen with its ending", async () => {
  stubEnvironment();
  await act(async () => {
    renderer = create(
      <MessageList
        {...BASE_PROPS}
        items={[
          secretItem({
            kind: "declined",
            requestId: "secret-1",
            createdAtMs: Date.parse("2026-09-14T10:00:00.000Z"),
            name: "GITHUB_TOKEN",
            label: "GitHub token",
          }),
        ]}
      />,
    );
  });

  expect(
    renderer!.root.findAll((node) => node.children.includes(", so this task stopped.")),
  ).not.toEqual([]);
  expect(renderer!.root.findAll((node) => node.children.includes("GitHub token"))).not.toEqual([]);
  // Nothing left to tap, and no field that could take a value.
  expect(renderer!.root.findAllByType("button")).toEqual([]);
  expect(renderer!.root.findAllByType("input")).toEqual([]);
});

it("locks the secret card while the value is in flight", async () => {
  stubEnvironment();
  await act(async () => {
    renderer = create(
      <MessageList
        {...BASE_PROPS}
        items={[secretItem(PENDING_SECRET)]}
        respondingIds={new Set(["secret-1"])}
      />,
    );
  });

  expect(renderer!.root.findByType("input").props.disabled).toBe(true);
  expect(optionButton("Decline").props.disabled).toBe(true);
});

it("locks the card while the answer is in flight", async () => {
  stubEnvironment();
  const answered: Array<[string, UserInputAnswers]> = [];
  await act(async () => {
    renderer = create(
      <MessageList
        {...BASE_PROPS}
        items={[questionItem(pendingCard())]}
        respondingIds={new Set(["req-1"])}
        onAnswerQuestion={(requestId, answers) => answered.push([requestId, answers])}
      />,
    );
  });

  expect(optionButton("Fix the failing tests").props.disabled).toBe(true);
  expect(
    renderer!.root.findAll((node) => node.children.includes("Sending your answer")),
  ).toHaveLength(1);
});

it("renders what the bot said next below the question it answered", async () => {
  stubEnvironment();
  const reply = {
    kind: "message",
    id: "a2",
    message: {
      id: MessageId.make("a2"),
      role: "assistant",
      text: "Heads-up set for 11:00.",
      attachments: [],
      turnId: null,
      streaming: false,
      createdAt: "2026-09-14T10:02:00.000Z",
      updatedAt: "2026-09-14T10:02:00.000Z",
    },
  } as const satisfies ConversationItem;
  await act(async () => {
    renderer = create(
      <MessageList
        {...BASE_PROPS}
        items={[
          questionItem({
            kind: "answered",
            requestId: "req-1",
            createdAt: "2026-09-14T10:00:00.000Z",
            questions: [SCOPE_QUESTION],
            answers: { scope: "tests" },
          }),
          reply,
        ]}
      />,
    );
  });

  const rendered = JSON.stringify(renderer!.toJSON());
  const card = rendered.indexOf("Fix the failing tests");
  const said = rendered.indexOf("Heads-up set for 11:00.");
  expect(card).toBeGreaterThan(-1);
  expect(said).toBeGreaterThan(card);
});
