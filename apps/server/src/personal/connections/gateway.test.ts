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

/** A value distinctive enough that finding it anywhere is a leak. */
const TOKEN = "ghp_fake_TOKEN_value_0123456789";

/** Every string inside `value`, untruncated, on one line: what a leak scan reads. */
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

interface HarnessOptions {
  readonly status?: "connected" | "disabled";
  readonly credentialVersion?: number;
  readonly sensitiveOrigins?: ReadonlyArray<string>;
  readonly vendorSchema?: string;
  /** Disables the connection after this many resolves: a disable mid-call. */
  readonly disableAfterResolves?: number;
  readonly adapters?: "none" | "fake";
  readonly execute?: (
    call: Adapters.ConnectionVendorCall,
  ) => Effect.Effect<Readonly<Record<string, unknown>>, Adapters.ConnectionVendorError>;
}

interface Harness {
  readonly layer: Layer.Layer<Gateway.PersonalConnectionGateway>;
  readonly approvals: Map<string, PersonalConnectionApproval>;
  readonly calls: Array<Adapters.ConnectionVendorCall>;
  readonly logs: Array<string>;
  /** Mutated mid-test to stand for a disable or a rotation while a card is open. */
  readonly connection: {
    status: "connected" | "disabled";
    credentialVersion: number;
    credentialRef: string;
  };
}

const makeHarness = (options?: HarnessOptions): Harness => {
  const approvals = new Map<string, PersonalConnectionApproval>();
  const calls: Array<Adapters.ConnectionVendorCall> = [];
  const logs: Array<string> = [];
  const connection = {
    status: options?.status ?? ("connected" as const),
    credentialVersion: options?.credentialVersion ?? 1,
    credentialRef: "opaque-1",
  };

  let resolves = 0;
  const connections = Layer.mock(ConnectionService.PersonalConnectionService)({
    resolveForOperation: (vendorId: PersonalConnectionVendorId) =>
      Effect.sync(() => {
        resolves += 1;
        if (
          options?.disableAfterResolves !== undefined &&
          resolves > options.disableAfterResolves
        ) {
          connection.status = "disabled";
        }
        // Both vendors resolve from one record: the gate does not care which
        // account a call belongs to, only what it was asked to do.
        return connection.status === "connected"
          ? Option.some({
              connectionId: ConnectionId.make("connection-1"),
              vendorId,
              credentialRef: connection.credentialRef,
              credentialVersion: connection.credentialVersion,
            })
          : Option.none();
      }),
    list: () =>
      Effect.sync(() => ({
        connections: [
          {
            connectionId: ConnectionId.make("connection-1"),
            vendorId: "github" as const,
            status: connection.status,
            account: null,
            verifiedCapabilities: [],
            credentialVersion: connection.credentialVersion,
            lastValidatedAt: null,
            createdAt: undefined as never,
            updatedAt: undefined as never,
          },
        ],
      })),
  });

  const credentials = Layer.succeed(
    CredentialStore.PersonalConnectionCredentialStore,
    CredentialStore.PersonalConnectionCredentialStore.of({
      create: () => Effect.die("unused"),
      createNext: () => Effect.die("unused"),
      read: (handle) =>
        Effect.sync(() =>
          handle.version === connection.credentialVersion
            ? Option.some({ accessToken: Redacted.make(TOKEN) })
            : Option.none(),
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

  const browser = Layer.mock(PersonalBrowser)({
    sensitiveExposure: () => Effect.succeed(options?.sensitiveOrigins ?? []),
  });

  const neon: Adapters.ConnectionVendorAdapter = {
    vendorId: "neon",
    vendorSchema: () => Effect.succeed("neon/v2-sql@2026-09-20"),
    execute: (call) =>
      Effect.sync(() => {
        calls.push(call);
        return { rows: [], rowCount: 0 };
      }),
  };

  const fake: Adapters.ConnectionVendorAdapter = {
    vendorId: "github",
    vendorSchema: () => Effect.succeed(options?.vendorSchema ?? "github/repos@2026-09-20"),
    execute: (call) =>
      Effect.sync(() => {
        calls.push(call);
      }).pipe(
        Effect.andThen(
          options?.execute?.(call) ??
            Effect.succeed({
              repository: "me/hbots-demo",
              htmlUrl: "https://github.com/me/hbots-demo",
              // A field the operation was never reviewed to return.
              installationToken: TOKEN,
            }),
        ),
      ),
  };

  // provideMerge, not provide: the tests decide approvals through the same
  // service instance the gateway asked, which is the point of the binding.
  const layer = Gateway.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        connections,
        credentials,
        browser,
        options?.adapters === "none" ? Adapters.layer : Adapters.layerOf([fake, neon]),
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
    // Logs are one of the places a credential must never appear.
    Layer.provideMerge(
      Logger.layer([
        Logger.make((options) => {
          logs.push(text(options));
        }),
      ]),
    ),
  );

  return { layer, approvals, calls, logs, connection };
};

const createRepository = {
  operation: "github.create_repository",
  arguments: { name: "hbots-demo", visibility: "private" },
  caller,
};

const listRepositories = { operation: "github.list_repositories", arguments: {}, caller };

describe("PersonalConnectionGateway", () => {
  it.effect("runs a read without asking, and returns only reviewed fields", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        execute: () =>
          Effect.succeed({ repositories: ["me/app"], rateLimitToken: TOKEN }),
      });
      yield* Effect.gen(function* () {
        const gateway = yield* Gateway.PersonalConnectionGateway;
        const result = yield* gateway.call(listRepositories);
        expect(result).toEqual({
          _tag: "completed",
          operationId: "github.list_repositories",
          result: { repositories: ["me/app"] },
          approvalId: null,
        });
        expect(harness.approvals.size).toBe(0);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("stops an unknown operation and an argument the schema does not describe", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const gateway = yield* Gateway.PersonalConnectionGateway;
        const unknown = yield* Effect.flip(
          gateway.call({ operation: "github.delete_account", arguments: {}, caller }),
        );
        expect(unknown.reason).toContain("No connection operation");

        const extra = yield* Effect.flip(
          gateway.call({
            ...createRepository,
            arguments: { ...createRepository.arguments, org: "someone-else" },
          }),
        );
        expect(extra.reason).toContain("Unknown argument");
        expect(harness.calls).toEqual([]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("refuses when the vendor no longer speaks the shape we reviewed", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ vendorSchema: "github/repos@2027-01-01" });
      yield* Effect.gen(function* () {
        const gateway = yield* Gateway.PersonalConnectionGateway;
        const error = yield* Effect.flip(gateway.call(listRepositories));
        expect(error.reason).toContain("changed its");
        expect(harness.calls).toEqual([]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("refuses every call while the chat carries sensitive browser data", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ sensitiveOrigins: ["https://bank.example"] });
      yield* Effect.gen(function* () {
        const gateway = yield* Gateway.PersonalConnectionGateway;
        // Not just the dangerous ones: a read is an exfiltration channel too.
        const read = yield* Effect.flip(gateway.call(listRepositories));
        expect(read.reason).toContain("bank.example");
        const write = yield* Effect.flip(gateway.call(createRepository));
        expect(write.reason).toContain("bank.example");
        expect(harness.calls).toEqual([]);
        expect(harness.approvals.size).toBe(0);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("refuses a vendor with no adapter instead of guessing", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ adapters: "none" });
      yield* Effect.gen(function* () {
        const gateway = yield* Gateway.PersonalConnectionGateway;
        const error = yield* Effect.flip(gateway.call(listRepositories));
        expect(error.reason).toContain("not available yet");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("refuses when the connection is disabled, whatever the session believes", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ status: "disabled" });
      yield* Effect.gen(function* () {
        const gateway = yield* Gateway.PersonalConnectionGateway;
        const error = yield* Effect.flip(gateway.call(listRepositories));
        expect(error.reason).toContain("not connected");
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});

describe("gateway approval", () => {
  it.effect("holds a write until the owner answers, then runs it exactly once", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const gateway = yield* Gateway.PersonalConnectionGateway;
        const approvals = yield* ApprovalService.PersonalConnectionApprovalService;

        const first = yield* gateway.call(createRepository);
        expect(first._tag).toBe("awaiting_approval");
        expect(harness.calls).toEqual([]);
        const approvalId =
          first._tag === "awaiting_approval" ? first.approvalId : "no approval was raised";
        // The owner reads the server's sentence, not the bot's.
        expect(harness.approvals.get(approvalId)?.summary).toBe(
          "Create the private GitHub repository hbots-demo.",
        );

        yield* approvals.decide({ approvalId: approvalId as never, decision: "approved" });

        const second = yield* gateway.call(createRepository);
        expect(second._tag).toBe("completed");
        expect(harness.calls).toHaveLength(1);
        expect(harness.approvals.get(approvalId)?.executionOutcome).toBe("succeeded");

        // The approval is spent: the same call asks again.
        const third = yield* gateway.call(createRepository);
        expect(third._tag).toBe("awaiting_approval");
        expect(harness.calls).toHaveLength(1);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("cannot spend an approval given before the credential rotated", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const gateway = yield* Gateway.PersonalConnectionGateway;
        const approvals = yield* ApprovalService.PersonalConnectionApprovalService;

        const pending = yield* gateway.call(createRepository);
        const approvalId =
          pending._tag === "awaiting_approval" ? pending.approvalId : "no approval was raised";
        yield* approvals.decide({ approvalId: approvalId as never, decision: "approved" });

        // The owner rotated the token while the card was open. The approval
        // is bound to the old credential version, so it buys nothing now.
        harness.connection.credentialVersion = 2;
        const after = yield* gateway.call(createRepository);
        expect(after._tag).toBe("awaiting_approval");
        expect(after._tag === "awaiting_approval" && after.approvalId).not.toBe(approvalId);
        expect(harness.calls).toEqual([]);
        expect(harness.approvals.get(approvalId)?.executedAt).toBeNull();
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("re-reads the connection immediately before dispatch", () =>
    Effect.gen(function* () {
      // Two resolves happen before the dispatch check: the one that opened
      // this call, and the one that raised the card. The third is the check.
      const harness = makeHarness({ disableAfterResolves: 2 });
      yield* Effect.gen(function* () {
        const gateway = yield* Gateway.PersonalConnectionGateway;
        const approvals = yield* ApprovalService.PersonalConnectionApprovalService;

        const pending = yield* gateway.call(createRepository);
        const approvalId =
          pending._tag === "awaiting_approval" ? pending.approvalId : "no approval was raised";
        yield* approvals.decide({ approvalId: approvalId as never, decision: "approved" });

        const error = yield* Effect.flip(gateway.call(createRepository));
        expect(error.reason).toContain("changed while this was waiting");
        expect(harness.calls).toEqual([]);
        // The approval is closed out rather than left to be replayed later.
        expect(harness.approvals.get(approvalId)?.executionOutcome).toBe("not_dispatched");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("tells the bot not to retry a denial", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const gateway = yield* Gateway.PersonalConnectionGateway;
        const approvals = yield* ApprovalService.PersonalConnectionApprovalService;
        const pending = yield* gateway.call(createRepository);
        const approvalId =
          pending._tag === "awaiting_approval" ? pending.approvalId : "no approval was raised";
        yield* approvals.decide({ approvalId: approvalId as never, decision: "denied" });

        const error = yield* Effect.flip(gateway.call(createRepository));
        expect(error.reason).toContain("declined");
        expect(harness.calls).toEqual([]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("gates a generic statement as a class, whatever it says", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const gateway = yield* Gateway.PersonalConnectionGateway;
        // A statement that reads as harmless is still a statement nobody
        // parsed: it waits like any other.
        const select = yield* gateway.call({
          operation: "neon.run_sql",
          arguments: { project: "p", database: "app", statement: "SELECT 1" },
          caller,
        });
        expect(select._tag).toBe("awaiting_approval");
        expect(select._tag === "awaiting_approval" && select.summary).toContain("SELECT 1");
        expect(harness.calls).toEqual([]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});

describe("gateway credential handling", () => {
  it.effect("keeps the credential out of results, errors, events and logs", () =>
    Effect.gen(function* () {
      const nested = new Error("outer");
      (nested as { cause?: unknown }).cause = new Error(
        `POST https://api.github.com/user/repos?access_token=${encodeURIComponent(TOKEN)} -> 401`,
      );
      const harness = makeHarness({
        execute: () =>
          Effect.fail(
            new Adapters.ConnectionVendorError({
              operationId: "github.create_repository",
              detail: JSON.stringify({
                message: "Bad credentials",
                request: {
                  authorization: `Bearer ${TOKEN}`,
                  basic: Buffer.from(TOKEN, "utf8").toString("base64"),
                  nested: String(nested.cause),
                },
              }),
            }),
          ),
      });

      yield* Effect.gen(function* () {
        const gateway = yield* Gateway.PersonalConnectionGateway;
        const approvals = yield* ApprovalService.PersonalConnectionApprovalService;
        const pending = yield* gateway.call(createRepository);
        const approvalId =
          pending._tag === "awaiting_approval" ? pending.approvalId : "no approval was raised";
        yield* approvals.decide({ approvalId: approvalId as never, decision: "approved" });

        const error = yield* Effect.flip(gateway.call(createRepository));
        // The failure still says what happened.
        expect(error.reason).toContain("Bad credentials");
        expect(error.reason).toContain("[redacted]");

        for (const surface of [
          text(error),
          text(harness.approvals.get(approvalId)),
          text([...harness.approvals.values()]),
          harness.logs.join("\n"),
        ]) {
          expect(surface).not.toContain(TOKEN);
          expect(surface).not.toContain(encodeURIComponent(TOKEN));
          expect(surface).not.toContain(Buffer.from(TOKEN, "utf8").toString("base64"));
        }

        // The adapter is the only place the value exists, and it arrives
        // redacted rather than as a plain string.
        const call = harness.calls[0]!;
        expect(text(call.arguments)).not.toContain(TOKEN);
        expect(Redacted.value(call.credentials.accessToken!)).toBe(TOKEN);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("drops vendor result fields the operation was not reviewed to return", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const gateway = yield* Gateway.PersonalConnectionGateway;
        const approvals = yield* ApprovalService.PersonalConnectionApprovalService;
        const pending = yield* gateway.call(createRepository);
        const approvalId =
          pending._tag === "awaiting_approval" ? pending.approvalId : "no approval was raised";
        yield* approvals.decide({ approvalId: approvalId as never, decision: "approved" });

        const done = yield* gateway.call(createRepository);
        expect(done).toEqual({
          _tag: "completed",
          operationId: "github.create_repository",
          result: {
            repository: "me/hbots-demo",
            htmlUrl: "https://github.com/me/hbots-demo",
          },
          approvalId,
        });
        expect(text(done)).not.toContain(TOKEN);
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});
