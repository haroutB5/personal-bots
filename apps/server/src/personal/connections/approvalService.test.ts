import {
  ConnectionId,
  PersonalBotId,
  PersonalConnectionApprovalId,
  PersonalTaskId,
  ThreadId,
  PersonalTasksError,
  type PersonalConnectionApproval,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as PersonalTaskService from "../tasks/PersonalTaskService.ts";
import * as ApprovalRepository from "./approvalRepository.ts";
import * as ApprovalService from "./approvalService.ts";

type TaskCall =
  | { readonly kind: "wait"; readonly taskId: string }
  | { readonly kind: "resume"; readonly taskId: string; readonly note: string }
  | { readonly kind: "fail"; readonly taskId: string; readonly message: string };

interface Harness {
  readonly layer: Layer.Layer<ApprovalService.PersonalConnectionApprovalService>;
  readonly rows: Map<string, PersonalConnectionApproval>;
  readonly taskCalls: Array<TaskCall>;
  /** Fresh service over the same rows: what a restart looks like from here. */
  readonly restart: () => Layer.Layer<ApprovalService.PersonalConnectionApprovalService>;
}

const makeHarness = (options?: { readonly taskIsWaiting?: boolean }): Harness => {
  const rows = new Map<string, PersonalConnectionApproval>();
  const taskCalls: Array<TaskCall> = [];

  const repository = ApprovalRepository.PersonalConnectionApprovalRepository.of({
    insert: (approval) =>
      Effect.sync(() => {
        rows.set(approval.approvalId, approval);
      }),
    // Reads are Effect.sync, not Effect.succeed: a query that answers from the
    // moment it was built, not the moment it ran, would hide a sweep.
    get: (approvalId) => Effect.sync(() => Option.fromNullishOr(rows.get(approvalId))),
    listByDigest: (digest) =>
      Effect.sync(() => [...rows.values()].filter((row) => row.actionDigest === digest)),
    listByStatus: (status) =>
      Effect.sync(() => [...rows.values()].filter((row) => row.status === status)),
    listPastDue: (now) =>
      Effect.sync(() =>
        [...rows.values()].filter(
          (row) =>
            row.status === "pending" &&
            DateTime.toEpochMillis(row.expiresAt) <= DateTime.toEpochMillis(now),
        ),
      ),
    writeStatus: (input) =>
      Effect.sync(() => {
        const row = rows.get(input.approvalId);
        if (row === undefined || row.status !== input.expectedStatus) return false;
        rows.set(input.approvalId, {
          ...row,
          status: input.status,
          decidedAt: input.decidedAt,
        });
        return true;
      }),
    writeReceipt: (input) =>
      Effect.sync(() => {
        const row = rows.get(input.approvalId);
        if (row === undefined) return false;
        // As the SQL: unspent, or the claim being settled by its owner.
        const settlingClaim =
          input.outcome !== "dispatching" && row.executionOutcome === "dispatching";
        if (row.executedAt !== null && !settlingClaim) return false;
        rows.set(input.approvalId, {
          ...row,
          executedAt: input.executedAt,
          executionOutcome: input.outcome,
        });
        return true;
      }),
  });

  // The service never reads the task these return; only that the call was
  // made and whether it failed. Nothing here needs a whole PersonalTask.
  const parked = Effect.succeed(undefined as unknown as never);
  const tasks = Layer.mock(PersonalTaskService.PersonalTaskService)({
    waitForUser: (input) =>
      Effect.sync(() => {
        taskCalls.push({ kind: "wait", taskId: input.taskId });
      }).pipe(
        Effect.andThen(
          options?.taskIsWaiting === true
            ? Effect.fail(new PersonalTasksError({ message: "Task 'task-1' is waiting_for_user." }))
            : parked,
        ),
      ),
    resumeFromUser: (input) =>
      Effect.sync(() => {
        taskCalls.push({ kind: "resume", taskId: input.taskId, note: input.note });
      }).pipe(Effect.andThen(parked)),
    failWaitingForUser: (input) =>
      Effect.sync(() => {
        taskCalls.push({ kind: "fail", taskId: input.taskId, message: input.message });
      }).pipe(Effect.andThen(parked)),
  });

  const layerOf = () =>
    ApprovalService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ApprovalRepository.PersonalConnectionApprovalRepository, repository),
          tasks,
        ),
      ),
    );

  return { rows, taskCalls, layer: layerOf(), restart: layerOf };
};

const request = (overrides?: Partial<ApprovalService.ConnectionApprovalRequest>) => ({
  actionDigest: "digest-1",
  connectionId: ConnectionId.make("connection-1"),
  vendorId: "github" as const,
  operationId: "github.create_repository",
  riskReason: "account_write" as const,
  summary: "Create the private GitHub repository hbots-demo.",
  targetResources: ["github:repository:hbots-demo"],
  credentialVersion: 1,
  threadId: ThreadId.make("thread-1"),
  botId: PersonalBotId.make("bot-1"),
  taskId: PersonalTaskId.make("task-1"),
  ...overrides,
});

describe("PersonalConnectionApprovalService", () => {
  it.effect("raises one card for one action and parks the asking task", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const service = yield* ApprovalService.PersonalConnectionApprovalService;

        const first = yield* service.require(request());
        expect(first._tag).toBe("pending");
        // The same action asked for again is the same card, not a second one.
        const second = yield* service.require(request());
        expect(second._tag).toBe("pending");
        expect(second.approval.approvalId).toBe(first.approval.approvalId);
        expect(harness.rows.size).toBe(1);
        expect(harness.taskCalls.filter((call) => call.kind === "wait")).toHaveLength(2);

        // A different action is a different card, even from the same bot.
        yield* service.require(request({ actionDigest: "digest-2" }));
        expect(harness.rows.size).toBe(2);

        expect((yield* service.listPending()).approvals).toHaveLength(2);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("carries the server's own summary, never the model's words", () =>
    Effect.gen(function* () {
      const service = yield* ApprovalService.PersonalConnectionApprovalService;
      const outcome = yield* service.require(request());
      expect(outcome.approval.summary).toBe("Create the private GitHub repository hbots-demo.");
      expect(ApprovalService.approvalResumeNote(outcome.approval)).toContain(
        "Create the private GitHub repository hbots-demo.",
      );
    }).pipe(Effect.provide(makeHarness().layer)),
  );
});

describe("deciding an approval", () => {
  it.effect("approves once, releases the task, and is then spent by a dispatch", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const service = yield* ApprovalService.PersonalConnectionApprovalService;
        const pending = yield* service.require(request());
        const approvalId = pending.approval.approvalId;

        const approved = yield* service.decide({ approvalId, decision: "approved" });
        expect(approved.status).toBe("approved");
        const resumed = harness.taskCalls.find((call) => call.kind === "resume");
        expect(resumed?.note).toContain("approved");

        // The duplicate click of a two-device owner resolves once.
        const again = yield* Effect.flip(service.decide({ approvalId, decision: "denied" }));
        expect(again.message).toContain("already");

        // Until it is spent, the same call runs without asking again.
        expect((yield* service.require(request()))._tag).toBe("approved");
        expect(yield* service.recordExecution({ approvalId, outcome: "succeeded" })).toBe(true);
        // A second dispatch cannot replay the same approval.
        expect(yield* service.recordExecution({ approvalId, outcome: "succeeded" })).toBe(false);
        // And the next identical call has to ask again.
        expect((yield* service.require(request()))._tag).toBe("pending");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("keeps a denial standing for its window and tells the bot not to retry", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const service = yield* ApprovalService.PersonalConnectionApprovalService;
        const pending = yield* service.require(request());
        yield* service.decide({
          approvalId: pending.approval.approvalId,
          decision: "denied",
        });
        expect(harness.taskCalls.find((call) => call.kind === "resume")?.note).toContain(
          "declined",
        );

        const retry = yield* service.require(request());
        expect(retry._tag).toBe("denied");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("fails the task when the owner dismisses the card", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const service = yield* ApprovalService.PersonalConnectionApprovalService;
        const pending = yield* service.require(request());
        const cancelled = yield* service.cancel({ approvalId: pending.approval.approvalId });
        expect(cancelled.status).toBe("cancelled");
        expect(harness.taskCalls.find((call) => call.kind === "fail")?.message).toContain(
          "dismissed",
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("expires a card nobody answered and releases the task it parked", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const stale: PersonalConnectionApproval = {
        approvalId: PersonalConnectionApprovalId.make("approval-stale"),
        connectionId: ConnectionId.make("connection-1"),
        vendorId: "github",
        operationId: "github.create_repository",
        actionDigest: "digest-1",
        riskReason: "account_write",
        summary: "Create the private GitHub repository hbots-demo.",
        targetResources: [],
        credentialVersion: 1,
        threadId: ThreadId.make("thread-1"),
        botId: PersonalBotId.make("bot-1"),
        taskId: PersonalTaskId.make("task-1"),
        status: "pending",
        // Relative to the clock this test runs on, which starts at the epoch:
        // a fixed 2026 date would sit in its future and never fall due.
        createdAt: DateTime.subtractDuration(yield* DateTime.now, Duration.minutes(30)),
        expiresAt: DateTime.subtractDuration(yield* DateTime.now, Duration.minutes(15)),
        decidedAt: null,
        executedAt: null,
        executionOutcome: null,
      };
      harness.rows.set(stale.approvalId, stale);

      yield* Effect.gen(function* () {
        const service = yield* ApprovalService.PersonalConnectionApprovalService;
        // Listing is enough to close it: no timer had to survive anything.
        expect((yield* service.listPending()).approvals).toEqual([]);
        expect(harness.rows.get(stale.approvalId)?.status).toBe("expired");
        expect(harness.taskCalls.find((call) => call.kind === "resume")?.note).toContain(
          "timed out",
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("answers an approval taken before a restart", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const approvalId = yield* Effect.gen(function* () {
        const service = yield* ApprovalService.PersonalConnectionApprovalService;
        return (yield* service.require(request())).approval.approvalId;
      }).pipe(Effect.provide(harness.layer));

      // Nothing about the decision lived in the first service instance.
      yield* Effect.gen(function* () {
        const service = yield* ApprovalService.PersonalConnectionApprovalService;
        const approved = yield* service.decide({ approvalId, decision: "approved" });
        expect(approved.approvalId).toBe(approvalId);
        expect((yield* service.require(request()))._tag).toBe("approved");
      }).pipe(Effect.provide(harness.restart()));
    }),
  );
});
