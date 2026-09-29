import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it } from "vite-plus/test";

import { PersonalBotId, PersonalLeadBotChangeId, ThreadId } from "@t3tools/contracts";
import type { PersonalLeadBotChange } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { LeadBotChangeCard } from "./LeadBotChangeCard";
import type { LeadBotChangeCardItem } from "./leadBotChangeCards";

let renderer: ReactTestRenderer | null = null;
afterEach(() => {
  renderer?.unmount();
  renderer = null;
});

const NOW = Date.parse("2026-09-21T10:02:00.000Z");

const card = (overrides: Partial<PersonalLeadBotChange> = {}): LeadBotChangeCardItem => {
  const change: PersonalLeadBotChange = {
    changeId: PersonalLeadBotChangeId.make("change-1"),
    changeHash: "hash-1",
    leadBotId: PersonalBotId.make("lead-1"),
    leadName: "CFO",
    action: "update",
    targetBotId: PersonalBotId.make("bot-2"),
    targetName: "Tax",
    team: "Finance",
    threadId: ThreadId.make("thread-1"),
    lines: ["instructions: 412 → 530 chars", "name: 'Tax' → 'Tax Pro'"],
    reason: null,
    status: "pending",
    outcome: null,
    createdAt: DateTime.makeUnsafe("2026-09-21T10:00:00.000Z"),
    expiresAt: DateTime.makeUnsafe("2026-09-21T10:10:00.000Z"),
    decidedAt: null,
    ...overrides,
  };
  return {
    kind: change.status,
    changeId: change.changeId,
    createdAtMs: Date.parse("2026-09-21T10:00:00.000Z"),
    change,
  };
};

type Decide = (
  id: string,
  hash: string,
  decision: "approved" | "declined",
) => Promise<string | null>;

const texts = (): string => JSON.stringify(renderer?.toJSON() ?? null);
const buttons = () => renderer!.root.findAll((node) => node.type === "button");

const tap = async (label: string) => {
  const button = buttons().find((node) => JSON.stringify(node.children).includes(label));
  await act(async () => {
    (button!.props as { onClick: () => void }).onClick();
  });
};

const render = async (
  item: LeadBotChangeCardItem,
  props: { nowMs?: number; responding?: boolean; onDecide?: Decide } = {},
) => {
  await act(async () => {
    renderer = create(
      <LeadBotChangeCard
        card={item}
        nowMs={props.nowMs ?? NOW}
        responding={props.responding ?? false}
        onDecide={props.onDecide ?? (async () => null)}
      />,
    );
  });
};

it("shows the server's lines, the expiry and both buttons while pending", async () => {
  await render(card());
  const rendered = texts();
  expect(rendered).toContain("CFO asks to change Tax");
  expect(rendered).toContain("instructions: 412 → 530 chars");
  expect(rendered).toContain("name: 'Tax' → 'Tax Pro'");
  expect(rendered).toContain("Only you can approve this. It expires in ");
  expect(buttons().map((node) => JSON.stringify(node.children))).toEqual([
    expect.stringContaining("No"),
    expect.stringContaining("Yes"),
  ]);
});

it("names a removal and its reason", async () => {
  await render(card({ action: "remove", lines: ["Remove Tax from Finance"], reason: "Duplicate" }));
  expect(texts()).toContain("CFO asks to remove Tax");
  expect(texts()).toContain("Reason: ");
  expect(texts()).toContain("Duplicate");
});

it("sends the change id, hash and decision for each button", async () => {
  const sent: string[] = [];
  await render(card(), {
    onDecide: async (id, hash, decision) => {
      sent.push(`${id}|${hash}|${decision}`);
      return null;
    },
  });
  await tap("Yes");
  await tap("No");
  expect(sent).toEqual(["change-1|hash-1|approved", "change-1|hash-1|declined"]);
});

it("disables both buttons while an answer is in flight", async () => {
  await render(card(), { responding: true });
  expect(buttons().map((node) => (node.props as { disabled: boolean }).disabled)).toEqual([
    true,
    true,
  ]);
});

it("shows the failure on the card and keeps the buttons", async () => {
  await render(card(), { onDecide: async () => "This request already expired." });
  await tap("Yes");
  expect(texts()).toContain("This request already expired.");
  expect(buttons()).toHaveLength(2);
});

it("offers no buttons once the request has run out of time on this clock", async () => {
  await render(card(), { nowMs: Date.parse("2026-09-21T10:10:01.000Z") });
  expect(buttons()).toHaveLength(0);
  expect(texts()).toContain("Not answered in time, nothing changed");
});

it("leaves a one-line ending for every settled state, with no buttons", async () => {
  const cases: Array<[Partial<PersonalLeadBotChange>, string[]]> = [
    [{ status: "approved" }, ["You approved: ", "change Tax", "instructions: 412 → 530 chars"]],
    [{ status: "declined", action: "remove", lines: ["x"] }, ["You declined: ", "remove Tax"]],
    [{ status: "expired" }, ["Not answered in time, nothing changed"]],
    [
      { status: "failed", outcome: "Tax was renamed meanwhile" },
      ["Approved, but not applied: ", "Tax was renamed meanwhile"],
    ],
    [{ status: "superseded" }, ["Replaced by a newer request"]],
  ];
  for (const [overrides, expected] of cases) {
    await render(card(overrides));
    for (const text of expected) expect(texts()).toContain(text);
    expect(buttons()).toHaveLength(0);
    renderer?.unmount();
    renderer = null;
  }
});
