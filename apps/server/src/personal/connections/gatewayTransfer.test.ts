import * as NodeUtil from "node:util";

import {
  ConnectionId,
  PersonalBotId,
  PersonalTaskId,
  ThreadId,
  type PersonalConnectionApproval,
  type PersonalConnectionVendorId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import { PersonalBrowser } from "../browser/PersonalBrowser.ts";
import * as PersonalTaskService from "../tasks/PersonalTaskService.ts";
import * as Adapters from "./adapters.ts";
import * as ApprovalRepository from "./approvalRepository.ts";
import * as ApprovalService from "./approvalService.ts";
import * as CredentialStore from "./credentialStore.ts";
import * as Gateway from "./gateway.ts";
import * as ConnectionService from "./service.ts";

/**
 * The gateway half of the server-side credential transfer.
 *
 * An operation that names a `secondaryVendorId` needs two connections, and
 * the properties that matter are all the gateway's: both are resolved now,
 * both are bound into what the owner approved, both are re-read immediately
 * before dispatch, and neither credential reaches a result, a log or an error.
 */

const NEON_KEY = "neon_fake_APIKEY_value_0123456789";
const VERCEL_TOKEN = "vercel_fake_TOKEN_value_0123456789";

const text = (value: unknown) =>
  NodeUtil.inspect(value, {
    depth: null,
    breakLength: Infinity,
    maxArrayLength: null,
    maxStringLength: null,
  });

const caller = {
  threadId: ThreadId.make("thread-1"),
  botId: PersonalBotId.make("bot-1"),
  taskId: PersonalTaskId.make("task-1"),
};

const transfer = {
  operation: "neon.attach_connection_string_to_vercel",
  arguments: {
    project: "shiny-wind-028834",
    branch: null,
    database: "neondb",
    role: "neondb_owner",
    pooled: true,
    vercelProject: "hbots-demo",
    target: "production",
    variableName: "DATABASE_URL",
  },
  caller,
};

interface HarnessOptions {
  readonly vercelConnected?: boolean;
  /** Rotates the Vercel credential after this many resolves: a rotation mid-call. */
  readonly rotateVercelAfterResolves?: number;
  readonly execute?: (
    call: Adapters.ConnectionVendorCall,
  ) => Effect.Effect<Readonly<Record<string, unknown>>, Adapters.ConnectionVendorError>;
}

const makeHarness = (options?: HarnessOptions) => {
  const approvals = new Map<string, PersonalConnectionApproval>();
  const calls: Array<Adapters.ConnectionVendorCall> = [];
  const logs: Array<string> = [];
  const state = { vercelVersion: 1 };
  let vercelResolves = 0;

  const connections = Layer.mock(ConnectionService.PersonalConnectionService)({
    markNeedsReauth: () => Effect.void,
    resolveForOperation: (vendorId: PersonalConnectionVendorId) =>
      Effect.sync(() => {
        if (vendorId === "vercel") {
          vercelResolves += 1;
          if (
            options?.rotateVercelAfterResolves !== undefined &&
            vercelResolves > options.rotateVercelAfterResolves
          ) {
            state.vercelVersion = 2;
          }
          return options?.vercelConnected === false
            ? Option.none()
            : Option.some({
                connectionId: ConnectionId.make("connection-vercel"),
                vendorId,
                credentialRef: "opaque-vercel",
                credentialVersion: state.vercelVersion,
                account: {
                  accountId: "u1",
                  accountName: "harout",
                  teamId: "team_abc",
                  teamName: "Harout",
                },
              });
        }
        return Option.some({
          connectionId: ConnectionId.make("connection-neon"),
          vendorId,
          credentialRef: "opaque-neon",
          credentialVersion: 1,
          account: null,
        });
      }),
    list: () => Effect.succeed({ connections: [] }),
  });

  const credentials = Layer.succeed(
    CredentialStore.PersonalConnectionCredentialStore,
    CredentialStore.PersonalConnectionCredentialStore.of({
      create: () => Effect.die("unused"),
      createNext: () => Effect.die("unused"),
      read: (handle) =>
        Effect.sync(() =>
          handle.credentialRef === "opaque-vercel"
            ? handle.version === state.vercelVersion
              ? Option.some({ accessToken: Redacted.make(VERCEL_TOKEN) })
              : Option.none()
            : Option.some({ apiKey: Redacted.make(NEON_KEY) }),
        ),
      remove: () => Effect.void,
    }),
  );

  const approvalRepository = ApprovalRepository.PersonalConnectionApprovalRepository.of({
    insert: (approval) =>
      Effect.sync(() => {
        approvals.set(approval.approvalId, approval);
      }),
    get: (approvalId) => Effect.sync(() => Option.fromNullishOr(approvals.get(approvalId))),
    listByDigest: (digest) =>
      Effect.sync(() => [...approvals.values()].filter((row) => row.actionDigest === digest)),
    listByStatus: (status) =>
      Effect.sync(() => [...approvals.values()].filter((row) => row.status === status)),
    listPastDue: () => Effect.sync(() => []),
    writeStatus: (input) =>
      Effect.sync(() => {
        const row = approvals.get(input.approvalId);
        if (row === undefined || row.status !== input.expectedStatus) return false;
        approvals.set(input.approvalId, {
          ...row,
          status: input.status,
          decidedAt: input.decidedAt,
        });
        return true;
      }),
    writeReceipt: (input) =>
      Effect.sync(() => {
        const row = approvals.get(input.approvalId);
        if (row === undefined || row.executedAt !== null) return false;
        approvals.set(input.approvalId, {
          ...row,
          executedAt: input.executedAt,
          executionOutcome: input.outcome,
        });
        return true;
      }),
  });

  const parked = Effect.succeed(undefined as unknown as never);
  const tasks = Layer.mock(PersonalTaskService.PersonalTaskService)({
    waitForUser: () => parked,
    resumeFromUser: () => parked,
    failWaitingForUser: () => parked,
  });

  const browser = Layer.mock(PersonalBrowser)({ sensitiveExposure: () => Effect.succeed([]) });

  const neon: Adapters.ConnectionVendorAdapter = {
    vendorId: "neon",
    validate: () => Effect.die("validate is not part of a gateway call"),
    vendorSchema: (operationId) =>
      operationId === "neon.run_sql"
        ? Effect.fail(
            new Adapters.ConnectionVendorError({
              operationId,
              detail: "The Neon adapter does not speak for neon.run_sql.",
            }),
          )
        : Effect.succeed(
            operationId === "neon.list_projects"
              ? "neon/v2-projects@2026-09-20"
              : "neon/v2-connection-uri@2026-09-21+vercel/v10-project-env@2026-09-20",
          ),
    execute: (call) =>
      Effect.sync(() => {
        calls.push(call);
      }).pipe(
        Effect.andThen(
          options?.execute?.(call) ??
            Effect.succeed({
              vercelProject: "hbots-demo",
              target: "production",
              keys: ["DATABASE_URL"],
            }),
        ),
      ),
  };

  const layer = Gateway.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        connections,
        credentials,
        browser,
        Adapters.layerOf([neon]),
        ApprovalService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(
                ApprovalRepository.PersonalConnectionApprovalRepository,
                approvalRepository,
              ),
              tasks,
            ),
          ),
        ),
      ),
    ),
    Layer.provideMerge(Logger.layer([Logger.make((entry) => logs.push(text(entry)))])),
  );

  return { layer, approvals, calls, logs, state };
};

/** Raises the card, approves it, and calls again: what the owner's yes looks like. */
const approveAndRun = (_harness: ReturnType<typeof makeHarness>) =>
  Effect.gen(function* () {
    const gateway = yield* Gateway.PersonalConnectionGateway;
    const approvals = yield* ApprovalService.PersonalConnectionApprovalService;
    const pending = yield* gateway.call(transfer);
    if (pending._tag !== "awaiting_approval") {
      return yield* Effect.die("a credential transfer must be approved before it runs");
    }
    yield* approvals.decide({ approvalId: pending.approvalId as never, decision: "approved" });
    return yield* gateway.call(transfer);
  });

describe("gateway: server-side credential transfer", () => {
  it.effect("hands the adapter both connections, each with its own credential", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const result = yield* approveAndRun(harness);
        expect(result._tag).toBe("completed");
        const call = harness.calls[0];
        expect(Redacted.value(call?.credentials["apiKey"] ?? Redacted.make(""))).toBe(NEON_KEY);
        expect(call?.secondary?.vendorId).toBe("vercel");
        expect(
          Redacted.value(call?.secondary?.credentials["accessToken"] ?? Redacted.make("")),
        ).toBe(VERCEL_TOKEN);
        // The Vercel team the owner saw on the connect screen, not one
        // resolved per call.
        expect(call?.secondary?.account?.teamId).toBe("team_abc");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("supplies no second connection for an operation that did not ask for one", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const gateway = yield* Gateway.PersonalConnectionGateway;
        yield* gateway.call({ operation: "neon.list_projects", arguments: {}, caller });
        expect(harness.calls[0]?.secondary).toBeUndefined();
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("refuses before asking the owner when the second vendor is not connected", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ vercelConnected: false });
      yield* Effect.gen(function* () {
        const gateway = yield* Gateway.PersonalConnectionGateway;
        const error = yield* Effect.flip(gateway.call(transfer));
        expect(error.reason).toContain("Vercel");
        // No card was raised for an action that could never have run.
        expect(harness.approvals.size).toBe(0);
        expect(harness.calls).toEqual([]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("binds the second connection into the approval, so its rotation invalidates one", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const gateway = yield* Gateway.PersonalConnectionGateway;
        const first = yield* gateway.call(transfer);
        const approval =
          first._tag === "awaiting_approval" ? harness.approvals.get(first.approvalId) : undefined;
        // The owner is told which Vercel connection this writes into, and the
        // digest is bound to its version.
        expect(approval?.targetResources).toContain("vercel:connection:connection-vercel@v1");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("does not dispatch when the second connection changes while the card is open", () =>
    Effect.gen(function* () {
      // Two resolves raise and re-raise the card; the Vercel credential is
      // rotated after them, which is the window between the resolve the
      // approval was matched against and the re-read immediately before
      // dispatch.
      const harness = makeHarness({ rotateVercelAfterResolves: 2 });
      yield* Effect.gen(function* () {
        const gateway = yield* Gateway.PersonalConnectionGateway;
        const approvals = yield* ApprovalService.PersonalConnectionApprovalService;
        const pending = yield* gateway.call(transfer);
        const approvalId = pending._tag === "awaiting_approval" ? pending.approvalId : "none";
        yield* approvals.decide({ approvalId: approvalId as never, decision: "approved" });

        const error = yield* Effect.flip(gateway.call(transfer));
        expect(error.reason).toContain("Vercel");
        expect(harness.calls).toEqual([]);
        // Closed out, so the approval cannot be spent later.
        expect(harness.approvals.get(approvalId)?.executionOutcome).toBe("not_dispatched");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("keeps both credentials out of a failed transfer's error and logs", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        execute: () =>
          Effect.fail(
            new Adapters.ConnectionVendorError({
              operationId: "neon.attach_connection_string_to_vercel",
              // A vendor error that quotes both halves of the call back.
              detail: `neon key ${NEON_KEY} and vercel token ${VERCEL_TOKEN} were refused`,
            }),
          ),
      });
      yield* Effect.gen(function* () {
        const error = yield* Effect.flip(approveAndRun(harness));
        expect(error.message).toContain("refused");
        expect(text(error)).not.toContain(NEON_KEY);
        // The second connection's credential is scrubbed too: the gateway
        // reads it in this call, so it is in scope for this call's failure.
        expect(text(error)).not.toContain(VERCEL_TOKEN);
        expect(text(harness.logs)).not.toContain(NEON_KEY);
        expect(text(harness.logs)).not.toContain(VERCEL_TOKEN);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("names an operation its adapter does not speak for instead of guessing", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const gateway = yield* Gateway.PersonalConnectionGateway;
        const error = yield* Effect.flip(
          gateway.call({
            operation: "neon.run_sql",
            arguments: { project: "p", database: "neondb", statement: "SELECT 1" },
            caller,
          }),
        );
        expect(error.reason).toContain("neon.run_sql");
        expect(harness.approvals.size).toBe(0);
        expect(harness.calls).toEqual([]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});
