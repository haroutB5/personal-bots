import {
  ConnectionId,
  PersonalBotId,
  PersonalConnectionApprovalId,
  PersonalTaskId,
  ThreadId,
  type PersonalConnectionApproval,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../../persistence/Migrations.ts";
import * as ApprovalRepository from "./approvalRepository.ts";

const at = DateTime.makeUnsafe("2026-09-20T10:00:00.000Z");
const expires = DateTime.makeUnsafe("2026-09-20T10:15:00.000Z");

const pending: PersonalConnectionApproval = {
  approvalId: PersonalConnectionApprovalId.make("approval-1"),
  connectionId: ConnectionId.make("connection-1"),
  vendorId: "github",
  operationId: "github.create_repository",
  actionDigest: "digest-1",
  riskReason: "account_write",
  summary: "Create the private GitHub repository hbots-demo.",
  targetResources: ["github:repository:hbots-demo"],
  credentialVersion: 1,
  threadId: ThreadId.make("thread-1"),
  botId: PersonalBotId.make("bot-1"),
  taskId: PersonalTaskId.make("task-1"),
  status: "pending",
  createdAt: at,
  expiresAt: expires,
  decidedAt: null,
  executedAt: null,
  executionOutcome: null,
};

const TestLayer = ApprovalRepository.layer.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()));

describe("PersonalConnectionApprovalRepository", () => {
  it.effect("stores a decision and its receipt, each written once", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 73 });
      const repository = yield* ApprovalRepository.PersonalConnectionApprovalRepository;

      yield* repository.insert(pending);
      expect(Option.getOrThrow(yield* repository.get(pending.approvalId))).toEqual(pending);
      expect(yield* repository.listByDigest("digest-1")).toEqual([pending]);
      expect(yield* repository.listByStatus("pending")).toEqual([pending]);

      const decidedAt = DateTime.makeUnsafe("2026-09-20T10:05:00.000Z");
      expect(
        yield* repository.writeStatus({
          approvalId: pending.approvalId,
          expectedStatus: "pending",
          status: "approved",
          decidedAt,
        }),
      ).toBe(true);
      // The second click of the same button finds nothing left to decide.
      expect(
        yield* repository.writeStatus({
          approvalId: pending.approvalId,
          expectedStatus: "pending",
          status: "denied",
          decidedAt,
        }),
      ).toBe(false);
      const approved = Option.getOrThrow(yield* repository.get(pending.approvalId));
      expect(approved.status).toBe("approved");
      expect(approved.decidedAt).toEqual(decidedAt);

      const executedAt = DateTime.makeUnsafe("2026-09-20T10:06:00.000Z");
      expect(
        yield* repository.writeReceipt({
          approvalId: pending.approvalId,
          executedAt,
          outcome: "succeeded",
        }),
      ).toBe(true);
      // An approval is spent once: a second dispatch cannot claim the same one.
      expect(
        yield* repository.writeReceipt({
          approvalId: pending.approvalId,
          executedAt,
          outcome: "succeeded",
        }),
      ).toBe(false);
      const executed = Option.getOrThrow(yield* repository.get(pending.approvalId));
      expect(executed.executionOutcome).toBe("succeeded");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("lets one dispatch claim an approval and only that claim settle it", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 76 });
      const repository = yield* ApprovalRepository.PersonalConnectionApprovalRepository;
      yield* repository.insert({ ...pending, status: "approved", decidedAt: at });
      const receipt = (outcome: "dispatching" | "succeeded") =>
        repository.writeReceipt({ approvalId: pending.approvalId, executedAt: at, outcome });

      // Claimed before the vendor is called: the second racer gets nothing.
      expect(yield* receipt("dispatching")).toBe(true);
      expect(yield* receipt("dispatching")).toBe(false);
      const claimed = Option.getOrThrow(yield* repository.get(pending.approvalId));
      expect(claimed.executionOutcome).toBe("dispatching");
      expect(claimed.executedAt).not.toBeNull();

      // The claimant settles it once; after that it is an ordinary receipt.
      expect(yield* receipt("succeeded")).toBe(true);
      expect(yield* receipt("succeeded")).toBe(false);
      expect(yield* receipt("dispatching")).toBe(false);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("finds only the pending rows whose window has closed", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 73 });
      const repository = yield* ApprovalRepository.PersonalConnectionApprovalRepository;

      yield* repository.insert(pending);
      yield* repository.insert({
        ...pending,
        approvalId: PersonalConnectionApprovalId.make("approval-2"),
        actionDigest: "digest-2",
        expiresAt: DateTime.makeUnsafe("2026-09-20T11:00:00.000Z"),
      });
      yield* repository.insert({
        ...pending,
        approvalId: PersonalConnectionApprovalId.make("approval-3"),
        actionDigest: "digest-3",
        status: "approved",
        decidedAt: at,
      });

      const pastDue = yield* repository.listPastDue(
        DateTime.makeUnsafe("2026-09-20T10:30:00.000Z"),
      );
      expect(pastDue.map((row) => row.approvalId)).toEqual(["approval-1"]);
    }).pipe(Effect.provide(TestLayer)),
  );
});
