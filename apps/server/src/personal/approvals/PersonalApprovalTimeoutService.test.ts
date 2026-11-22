import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { personalTestDatabase } from "../test/personalReadsTestLayer.ts";
import {
  approvalTimeoutFeedback,
  dueApprovalDeclines,
  PERSONAL_APPROVAL_TIMEOUT_DEFAULT_MS,
  personalApprovalTimeoutMs,
  type PersonalApprovalRequestRow,
} from "./approvalTimeoutPolicy.ts";
import * as PersonalApprovalTimeout from "./PersonalApprovalTimeoutService.ts";

const OPENED = "2026-11-22T19:11:20.000Z";
const OPENED_MS = Date.parse(OPENED);
const FEEDBACK =
  "No one answered this approval within 2 minutes. Retry as a simpler command: one plain command, no $VAR as the command name, no loops or chained steps; or write the steps to a script file and run bash <file>.";

const row = (patch: Partial<PersonalApprovalRequestRow> = {}): PersonalApprovalRequestRow => ({
  requestId: "req-1",
  threadId: "thread-1",
  status: "pending",
  createdAt: OPENED,
  supportsFeedback: true,
  ...patch,
});

describe("personalApprovalTimeoutMs", () => {
  it("defaults to 2 minutes", () => {
    expect(personalApprovalTimeoutMs({})).toBe(120_000);
    expect(PERSONAL_APPROVAL_TIMEOUT_DEFAULT_MS).toBe(120_000);
  });

  it("takes a positive whole number of ms and ignores junk", () => {
    expect(personalApprovalTimeoutMs({ T3CODE_PERSONAL_APPROVAL_TIMEOUT_MS: "300000" })).toBe(
      300_000,
    );
    expect(personalApprovalTimeoutMs({ PERSONAL_APPROVAL_TIMEOUT_MS: "90000" })).toBe(90_000);
    expect(personalApprovalTimeoutMs({ T3CODE_PERSONAL_APPROVAL_TIMEOUT_MS: "soon" })).toBe(
      120_000,
    );
    expect(personalApprovalTimeoutMs({ T3CODE_PERSONAL_APPROVAL_TIMEOUT_MS: "-5" })).toBe(120_000);
  });

  it("is off with the kill switch or an off value", () => {
    expect(personalApprovalTimeoutMs({ T3CODE_PERSONAL_APPROVAL_TIMEOUT: "off" })).toBe(0);
    expect(personalApprovalTimeoutMs({ PERSONAL_APPROVAL_TIMEOUT: "false" })).toBe(0);
    expect(personalApprovalTimeoutMs({ T3CODE_PERSONAL_APPROVAL_TIMEOUT_MS: "0" })).toBe(0);
    expect(personalApprovalTimeoutMs({ T3CODE_PERSONAL_APPROVAL_TIMEOUT_MS: "off" })).toBe(0);
    expect(
      personalApprovalTimeoutMs({
        T3CODE_PERSONAL_APPROVAL_TIMEOUT: "off",
        T3CODE_PERSONAL_APPROVAL_TIMEOUT_MS: "60000",
      }),
    ).toBe(0);
  });
});

describe("approvalTimeoutFeedback", () => {
  it("names the configured wait", () => {
    expect(approvalTimeoutFeedback(120_000)).toBe(FEEDBACK);
    expect(approvalTimeoutFeedback(60_000)).toContain("within 1 minute.");
    expect(approvalTimeoutFeedback(90_000)).toContain("within 90 seconds.");
  });
});

describe("dueApprovalDeclines", () => {
  const due = (rows: ReadonlyArray<PersonalApprovalRequestRow>, afterMs: number, declined = []) =>
    dueApprovalDeclines({
      rows,
      nowMs: OPENED_MS + afterMs,
      timeoutMs: 120_000,
      alreadyDeclined: new Set<string>(declined),
    });

  it("leaves a request alone until the timeout", () => {
    expect(due([row()], 119_999)).toEqual([]);
  });

  it("declines a pending request after the timeout, with feedback", () => {
    expect(due([row()], 120_000)).toEqual([
      { requestId: "req-1", threadId: "thread-1", feedback: FEEDBACK },
    ]);
  });

  it("declines without feedback when the request cannot take it", () => {
    expect(due([row({ supportsFeedback: false })], 200_000)).toEqual([
      { requestId: "req-1", threadId: "thread-1" },
    ]);
  });

  it("skips answered, cancelled and already-declined requests", () => {
    expect(due([row({ status: "resolved" })], 200_000)).toEqual([]);
    expect(due([row({ status: "cancelled" })], 200_000)).toEqual([]);
    expect(due([row()], 200_000, ["req-1"] as never)).toEqual([]);
  });

  it("does nothing while disabled", () => {
    expect(
      dueApprovalDeclines({
        rows: [row()],
        nowMs: OPENED_MS + 3_600_000,
        timeoutMs: 0,
        alreadyDeclined: new Set(),
      }),
    ).toEqual([]);
  });
});

interface Harness {
  readonly dispatched: Array<Record<string, unknown>>;
}

const layerFor = (harness: Harness, env: NodeJS.ProcessEnv = {}) =>
  Layer.effect(
    PersonalApprovalTimeout.PersonalApprovalTimeout,
    PersonalApprovalTimeout.make({ env }),
  ).pipe(
    Layer.provideMerge(
      Layer.succeed(ThreadManagementService.ThreadManagementService, {
        dispatch: (command: Record<string, unknown>) =>
          Effect.gen(function* () {
            harness.dispatched.push(command);
            // What the orchestrator does when the decline lands.
            const sql = yield* SqlClient.SqlClient;
            yield* sql`
              UPDATE orchestration_v2_projection_runtime_requests
              SET status = 'resolved' WHERE runtime_request_id = ${String(command.requestId)}
            `;
            return { sequence: harness.dispatched.length };
          }).pipe(Effect.orDie),
      } as never),
    ),
    Layer.provideMerge(personalTestDatabase),
  );

const seedRequest = (input: {
  readonly requestId: string;
  readonly threadId?: string;
  readonly kind?: string;
  readonly status?: string;
  readonly linked?: boolean;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threadId = input.threadId ?? "thread-1";
    yield* sql`
      INSERT OR IGNORE INTO personal_bots
        (bot_id, name, avatar_shape, avatar_color, model_selection_json, created_at, updated_at)
      VALUES ('bot-1', 'Opuser', 'circle', 'blue', '{}', ${OPENED}, ${OPENED})
    `;
    if (input.linked !== false) {
      yield* sql`
        INSERT OR IGNORE INTO personal_bot_threads (thread_id, bot_id, created_at)
        VALUES (${threadId}, 'bot-1', ${OPENED})
      `;
    }
    const payload = JSON.stringify({
      id: input.requestId,
      responseCapability: { type: "live", providerSessionId: "s-1", supportsFeedback: true },
    });
    yield* sql`
      INSERT INTO orchestration_v2_projection_runtime_requests
        (runtime_request_id, thread_id, node_id, provider_turn_id, kind, status, created_at,
         resolved_at, payload_json)
      VALUES (${input.requestId}, ${threadId}, 'node-1', NULL, ${input.kind ?? "command"},
              ${input.status ?? "pending"}, ${OPENED}, NULL, ${payload})
    `;
  });

const setStatus = (requestId: string, status: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE orchestration_v2_projection_runtime_requests
      SET status = ${status} WHERE runtime_request_id = ${requestId}
    `;
  });

describe("PersonalApprovalTimeout sweep", () => {
  it.effect("an approval answered in time is never declined", () => {
    const harness: Harness = { dispatched: [] };
    return Effect.gen(function* () {
      const service = yield* PersonalApprovalTimeout.PersonalApprovalTimeout;
      yield* seedRequest({ requestId: "req-1" });
      yield* TestClock.setTime(OPENED_MS + 60_000);
      expect(yield* service.sweep).toBe(0);
      // The owner taps Approve at 1:30.
      yield* setStatus("req-1", "resolved");
      yield* TestClock.setTime(OPENED_MS + 180_000);
      expect(yield* service.sweep).toBe(0);
      expect(harness.dispatched).toEqual([]);
    }).pipe(Effect.provide(layerFor(harness)));
  });

  it.effect("an unanswered approval is declined once after 2 minutes, with feedback", () => {
    const harness: Harness = { dispatched: [] };
    return Effect.gen(function* () {
      const service = yield* PersonalApprovalTimeout.PersonalApprovalTimeout;
      yield* seedRequest({ requestId: "req-1" });
      yield* TestClock.setTime(OPENED_MS + 119_000);
      expect(yield* service.sweep).toBe(0);
      yield* TestClock.setTime(OPENED_MS + 121_000);
      expect(yield* service.sweep).toBe(1);
      yield* TestClock.setTime(OPENED_MS + 200_000);
      expect(yield* service.sweep).toBe(0);
      expect(harness.dispatched).toEqual([
        {
          type: "runtime-request.respond",
          threadId: "thread-1",
          commandId: "approval-timeout:req-1",
          requestId: "req-1",
          decision: "decline",
          feedback: FEEDBACK,
        },
      ]);
    }).pipe(Effect.provide(layerFor(harness)));
  });

  it.effect("a request cancelled first is left alone", () => {
    const harness: Harness = { dispatched: [] };
    return Effect.gen(function* () {
      const service = yield* PersonalApprovalTimeout.PersonalApprovalTimeout;
      yield* seedRequest({ requestId: "req-1" });
      // The owner's next message cancels it before the timeout.
      yield* setStatus("req-1", "cancelled");
      yield* TestClock.setTime(OPENED_MS + 600_000);
      expect(yield* service.sweep).toBe(0);
      expect(harness.dispatched).toEqual([]);
    }).pipe(Effect.provide(layerFor(harness)));
  });

  it.effect("only personal-bot approvals are declined; questions and other chats wait", () => {
    const harness: Harness = { dispatched: [] };
    return Effect.gen(function* () {
      const service = yield* PersonalApprovalTimeout.PersonalApprovalTimeout;
      yield* seedRequest({ requestId: "req-question", kind: "user_input" });
      yield* seedRequest({ requestId: "req-dev", threadId: "dev-thread", linked: false });
      yield* seedRequest({ requestId: "req-file", kind: "file_change" });
      yield* TestClock.setTime(OPENED_MS + 600_000);
      expect(yield* service.sweep).toBe(1);
      expect(harness.dispatched.map((command) => command.requestId)).toEqual(["req-file"]);
    }).pipe(Effect.provide(layerFor(harness)));
  });

  it.effect("the kill switch turns the sweep off", () => {
    const harness: Harness = { dispatched: [] };
    return Effect.gen(function* () {
      const service = yield* PersonalApprovalTimeout.PersonalApprovalTimeout;
      yield* seedRequest({ requestId: "req-1" });
      yield* TestClock.setTime(OPENED_MS + 600_000);
      expect(yield* service.sweep).toBe(0);
      expect(harness.dispatched).toEqual([]);
    }).pipe(Effect.provide(layerFor(harness, { T3CODE_PERSONAL_APPROVAL_TIMEOUT: "off" })));
  });
});
