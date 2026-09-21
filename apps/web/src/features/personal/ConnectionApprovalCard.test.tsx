import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it } from "vite-plus/test";

import {
  ConnectionId,
  PersonalBotId,
  PersonalConnectionApprovalId,
  ThreadId,
  type PersonalConnectionApproval,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { ConnectionApprovalCard } from "./ConnectionApprovalCard";
import type { ConnectionApprovalCardItem } from "./connectionApprovalCards";

let renderer: ReactTestRenderer | null = null;
afterEach(() => {
  renderer?.unmount();
  renderer = null;
});

const approval = (
  overrides: Partial<PersonalConnectionApproval> = {},
): PersonalConnectionApproval => ({
  approvalId: PersonalConnectionApprovalId.make("approval-1"),
  connectionId: ConnectionId.make("connection-1"),
  vendorId: "vercel",
  operationId: "vercel.deploy",
  actionDigest: "digest-1",
  riskReason: "deployment",
  summary: "Deploy matchday to production",
  targetResources: ["matchday"],
  credentialVersion: 1,
  threadId: ThreadId.make("thread-1"),
  botId: PersonalBotId.make("bot-1"),
  taskId: null,
  status: "pending",
  createdAt: DateTime.makeUnsafe("2026-09-21T10:00:00.000Z"),
  expiresAt: DateTime.makeUnsafe("2026-09-21T11:00:00.000Z"),
  decidedAt: null,
  executedAt: null,
  executionOutcome: null,
  ...overrides,
});

const pending = (
  overrides: Partial<PersonalConnectionApproval> = {},
): ConnectionApprovalCardItem => ({
  kind: "pending",
  approvalId: "approval-1",
  createdAtMs: Date.parse("2026-09-21T10:00:00.000Z"),
  approval: approval(overrides),
});

const texts = (): string => JSON.stringify(renderer?.toJSON() ?? null);

const tap = async (label: string) => {
  const button = renderer!.root.findAll(
    (node) => node.type === "button" && JSON.stringify(node.children).includes(label),
  )[0];
  await act(async () => {
    (button!.props as { onClick: () => void }).onClick();
  });
};

const render = async (element: React.ReactElement) => {
  await act(async () => {
    renderer = create(element);
  });
};

it("shows the server's words, not the bot's, and what the call will touch", async () => {
  await render(
    <ConnectionApprovalCard
      card={pending()}
      botName="Ada"
      expired={false}
      responding={false}
      onApprove={() => {}}
      onDeny={() => {}}
    />,
  );

  const rendered = texts();
  expect(rendered).toContain("Deploy matchday to production");
  expect(rendered).toContain("This deploys");
  expect(rendered).toContain("matchday");
});

it("passes the approval id back for each decision", async () => {
  const approved: string[] = [];
  const denied: string[] = [];
  await render(
    <ConnectionApprovalCard
      card={pending()}
      botName="Ada"
      expired={false}
      responding={false}
      onApprove={(id) => approved.push(id)}
      onDeny={(id) => denied.push(id)}
    />,
  );

  await tap("Allow once");
  await tap("Don"); // "Don't allow"; the apostrophe is an entity in the tree.

  expect(approved).toEqual(["approval-1"]);
  expect(denied).toEqual(["approval-1"]);
});

it("offers no button once the approval has run out of time", async () => {
  await render(
    <ConnectionApprovalCard
      card={pending()}
      botName="Ada"
      expired
      responding={false}
      onApprove={() => {}}
      onDeny={() => {}}
    />,
  );

  // A lazily-swept approval can still arrive listed as pending; a button that
  // failed on tap would be worse than saying so.
  expect(renderer!.root.findAll((node) => node.type === "button")).toHaveLength(0);
  expect(texts()).toContain("ran out of time");
});

it("names every risk the contract can carry", async () => {
  for (const [reason, expected] of [
    ["read_only", "This only reads"],
    ["account_write", "This changes your account"],
    ["publication", "This publishes"],
    ["deployment", "This deploys"],
    ["unbounded_statement", "cannot check in advance"],
  ] as const) {
    await render(
      <ConnectionApprovalCard
        card={pending({ riskReason: reason })}
        botName="Ada"
        expired={false}
        responding={false}
        onApprove={() => {}}
        onDeny={() => {}}
      />,
    );
    expect(texts()).toContain(expected);
    renderer?.unmount();
    renderer = null;
  }
});

it("records the ending in the transcript once it is decided", async () => {
  await render(
    <ConnectionApprovalCard
      card={{
        kind: "denied",
        approvalId: "approval-1",
        createdAtMs: Date.parse("2026-09-21T10:00:00.000Z"),
        summary: "Delete repository hbots-demo",
        vendorId: "github",
      }}
      botName="Ada"
      expired={false}
      responding={false}
      onApprove={() => {}}
      onDeny={() => {}}
    />,
  );

  // JSX splits the sentence across children, so the assertion reads the pieces.
  expect(texts()).toContain("You did not approve: ");
  expect(texts()).toContain("Delete repository hbots-demo");
});
