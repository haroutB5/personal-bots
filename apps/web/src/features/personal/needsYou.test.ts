import type {
  PersonalGroupRound,
  PersonalLoginRequest,
  PersonalSecretRequest,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveNeedsYou,
  NEEDS_YOU_PILL_LABEL,
  openLoginRequests,
  rowRequest,
  type NeedsYouInput,
  type NeedsYouThread,
} from "./needsYou";

const thread = (
  threadId: string,
  botId = "bot-forge",
  shell: NeedsYouThread["shell"] = { hasPendingUserInput: false, hasPendingApprovals: false },
): NeedsYouThread => ({ threadId, botId, shell });

const secret = (threadId: string, requestId: string, status = "pending") =>
  ({
    requestId,
    threadId,
    botId: "bot-ledger",
    status,
    name: "EXAMPLE_KEY",
    label: "Example key",
    purpose: "testing",
  }) as unknown as PersonalSecretRequest;

const login = (threadId: string, requestId: string, status = "pending") =>
  ({
    requestId,
    threadId,
    botId: "bot-scout",
    status,
    origin: "https://example.test",
  }) as unknown as PersonalLoginRequest;

const round = (groupId: string, status: PersonalGroupRound["status"]) =>
  ({
    roundId: `round-${groupId}`,
    groupId,
    status,
    activeThreadId: `thread-${groupId}`,
  }) as unknown as PersonalGroupRound;

const base = (overrides: Partial<NeedsYouInput> = {}): NeedsYouInput => ({
  threads: [],
  secretRequests: [],
  loginRequests: [],
  browserHelpThreadId: null,
  approvalThreadIds: new Set(),
  groupIds: new Set(),
  rounds: [],
  ...overrides,
});

describe("deriveNeedsYou", () => {
  it("counts nothing when there is nothing open", () => {
    const model = deriveNeedsYou(base({ threads: [thread("t1")] }));
    expect(model.count).toBe(0);
    expect(model.all).toEqual([]);
    expect(rowRequest(model, "t1")).toBeNull();
  });

  it("reads a pending question off the chat's shell", () => {
    const model = deriveNeedsYou(
      base({
        threads: [thread("t1", "bot-juno", { hasPendingUserInput: true })],
      }),
    );
    expect(model.count).toBe(1);
    expect(rowRequest(model, "t1")?.kind).toBe("answer");
    expect(NEEDS_YOU_PILL_LABEL[rowRequest(model, "t1")!.kind]).toBe("Answer");
  });

  it("reads an approval off the shell, and a decision from the connection approvals", () => {
    const shellModel = deriveNeedsYou(
      base({ threads: [thread("t1", "bot-relay", { hasPendingApprovals: true })] }),
    );
    expect(rowRequest(shellModel, "t1")?.kind).toBe("approve");

    const connectionModel = deriveNeedsYou(
      base({
        threads: [thread("t1", "bot-relay")],
        approvalThreadIds: new Set(["t1"]),
      }),
    );
    expect(connectionModel.count).toBe(1);
    expect(rowRequest(connectionModel, "t1")?.kind).toBe("approve");
  });

  it("does not count the same approval twice when both sources report it", () => {
    const model = deriveNeedsYou(
      base({
        threads: [thread("t1", "bot-relay", { hasPendingApprovals: true })],
        approvalThreadIds: new Set(["t1"]),
      }),
    );
    expect(model.count).toBe(1);
  });

  it("counts one secret request per request, not per chat", () => {
    const model = deriveNeedsYou(
      base({
        threads: [thread("t1", "bot-ledger")],
        secretRequests: [secret("t1", "req-1"), secret("t1", "req-2")],
      }),
    );
    expect(model.count).toBe(2);
    expect(model.byRow.get("t1")).toHaveLength(2);
    expect(rowRequest(model, "t1")?.kind).toBe("secret");
  });

  it("ignores secret requests that are no longer pending", () => {
    const model = deriveNeedsYou(
      base({
        threads: [thread("t1", "bot-ledger")],
        secretRequests: [secret("t1", "req-1", "fulfilled"), secret("t1", "req-2", "cancelled")],
      }),
    );
    expect(model.count).toBe(0);
  });

  it("counts a sign-in while it is pending or filling, and drops it after", () => {
    const pending = deriveNeedsYou(
      base({
        threads: [thread("t1", "bot-scout")],
        loginRequests: [login("t1", "login-1", "pending"), login("t1", "login-2", "filling")],
      }),
    );
    expect(pending.count).toBe(2);
    expect(rowRequest(pending, "t1")?.kind).toBe("login");

    const answered = deriveNeedsYou(
      base({
        threads: [thread("t1", "bot-scout")],
        loginRequests: [login("t1", "login-1", "filled"), login("t1", "login-2", "cancelled")],
      }),
    );
    expect(answered.count).toBe(0);
  });

  it("counts browser help on its own chat", () => {
    const model = deriveNeedsYou(
      base({ threads: [thread("t1", "bot-probe")], browserHelpThreadId: "t1" }),
    );
    expect(model.count).toBe(1);
    expect(rowRequest(model, "t1")?.kind).toBe("help");
  });

  it("counts a group round paused for a vote, keyed by the group", () => {
    const model = deriveNeedsYou(
      base({
        groupIds: new Set(["group-plans"]),
        rounds: [round("group-plans", "paused_vote")],
      }),
    );
    expect(model.count).toBe(1);
    expect(model.byRow.get("group-plans")?.[0]?.kind).toBe("vote");
    expect(NEEDS_YOU_PILL_LABEL.vote).toBe("Decide");
  });

  it("ignores live, completed and paused-budget rounds", () => {
    for (const status of ["running", "waiting_provider", "paused_budget", "completed"] as const) {
      const model = deriveNeedsYou(
        base({ groupIds: new Set(["g"]), rounds: [round("g", status)] }),
      );
      expect(model.count, status).toBe(0);
    }
  });

  it("leaves out requests on chats the home is not showing (archived, relay, snoozed)", () => {
    const model = deriveNeedsYou(
      base({
        threads: [thread("shown")],
        secretRequests: [secret("hidden", "req-1")],
        loginRequests: [login("hidden", "login-1")],
        browserHelpThreadId: "hidden",
        approvalThreadIds: new Set(["hidden"]),
      }),
    );
    expect(model.count).toBe(0);
  });

  it("leaves out a vote on a group that is not in the list", () => {
    const model = deriveNeedsYou(
      base({ groupIds: new Set(), rounds: [round("archived-group", "paused_vote")] }),
    );
    expect(model.count).toBe(0);
  });

  it("counts one chat's several kinds separately and shows the blocking one", () => {
    const model = deriveNeedsYou(
      base({
        threads: [
          thread("t1", "bot-juno", { hasPendingUserInput: true, hasPendingApprovals: true }),
        ],
        secretRequests: [secret("t1", "req-1")],
      }),
    );
    expect(model.count).toBe(3);
    // The pill: secret blocks the bot's task, so it outranks the approval and
    // the question (the same order botStatus reads its row through).
    expect(rowRequest(model, "t1")?.kind).toBe("secret");
  });

  it("calls the same entries for one input, every time (the chip, badge and list agree)", () => {
    const input = base({
      threads: [
        thread("t1", "bot-juno", { hasPendingUserInput: true }),
        thread("t2", "bot-relay", { hasPendingApprovals: true }),
      ],
      secretRequests: [secret("t2", "req-1")],
      browserHelpThreadId: "t3",
      groupIds: new Set(["g"]),
      rounds: [round("g", "paused_vote")],
    });
    const first = deriveNeedsYou(input);
    const second = deriveNeedsYou(input);
    expect(first.count).toBe(4);
    expect(second.count).toBe(first.count);
    expect([...second.byRow.entries()]).toEqual([...first.byRow.entries()]);
  });

  it("counts one request of every kind at once", () => {
    const model = deriveNeedsYou(
      base({
        threads: [
          thread("t-answer", "a", { hasPendingUserInput: true }),
          thread("t-approve", "b", { hasPendingApprovals: true }),
          thread("t-secret", "c"),
          thread("t-login", "d"),
          thread("t-help", "e"),
          thread("t-group", "f"),
        ],
        secretRequests: [secret("t-secret", "req-1")],
        loginRequests: [login("t-login", "login-1")],
        browserHelpThreadId: "t-help",
        groupIds: new Set(["g"]),
        rounds: [round("g", "paused_vote")],
      }),
    );
    expect(model.count).toBe(6);
    expect(new Set(model.all.map((request) => request.kind))).toEqual(
      new Set(["answer", "approve", "secret", "login", "help", "vote"]),
    );
  });
});

describe("openLoginRequests", () => {
  it("keeps pending and filling only", () => {
    const kept = openLoginRequests([
      login("t1", "1", "pending"),
      login("t1", "2", "filling"),
      login("t1", "3", "filled"),
      login("t1", "4", "expired"),
    ]);
    expect(kept.map((request) => request.requestId)).toEqual(["1", "2"]);
  });
});
