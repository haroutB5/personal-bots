import {
  ConnectionId,
  PersonalBotId,
  PersonalTaskId,
  ThreadId,
  type PersonalConnectionApproval,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import { PersonalBrowser } from "../browser/PersonalBrowser.ts";
import * as PersonalTaskService from "../tasks/PersonalTaskService.ts";
import * as Adapters from "./adapters.ts";
import * as ApprovalRepository from "./approvalRepository.ts";
import * as ApprovalService from "./approvalService.ts";
import * as CredentialStore from "./credentialStore.ts";
import { COMMONPOST_REVIEWED_SCHEMA } from "./email/thunderbird/pins.ts";
import * as Gateway from "./gateway.ts";
import * as ConnectionService from "./service.ts";

const caller = {
  threadId: ThreadId.make("thread-1"),
  botId: PersonalBotId.make("bot-1"),
  taskId: PersonalTaskId.make("task-1"),
};

interface Mailbox {
  readonly connectionId: string;
  readonly address: string;
  readonly status: "connected" | "disabled";
}

const GMAIL_SCHEMA = COMMONPOST_REVIEWED_SCHEMA;

const makeHarness = (mailboxes: ReadonlyArray<Mailbox>) => {
  const approvals = new Map<string, PersonalConnectionApproval>();
  const calls: Array<Adapters.ConnectionVendorCall> = [];
  const accountOf = (mailbox: Mailbox) => ({
    accountId: mailbox.address,
    accountName: mailbox.address,
    teamId: null,
    teamName: null,
  });

  const connections = Layer.mock(ConnectionService.PersonalConnectionService)({
    markNeedsReauth: () => Effect.void,
    resolveForOperation: (vendorId, account) =>
      Effect.sync(() => {
        const found = mailboxes.find(
          (mailbox) =>
            vendorId === "gmail" && account !== null && mailbox.address === account.toLowerCase(),
        );
        return found !== undefined && found.status === "connected"
          ? Option.some({
              connectionId: ConnectionId.make(found.connectionId),
              vendorId,
              credentialRef: `ref-${found.connectionId}`,
              credentialVersion: 1,
              account: accountOf(found),
              settings: { whatsappDailySendCap: null },
            })
          : Option.none();
      }),
    list: () =>
      Effect.sync(() => ({
        connections: mailboxes.map((mailbox) => ({
          connectionId: ConnectionId.make(mailbox.connectionId),
          vendorId: "gmail" as const,
          status: mailbox.status,
          account: accountOf(mailbox),
          verifiedCapabilities: [],
          settings: { whatsappDailySendCap: null },
          credentialVersion: 1,
          lastValidatedAt: null,
          createdAt: undefined as never,
          updatedAt: undefined as never,
        })),
      })),
  });

  const credentials = Layer.succeed(
    CredentialStore.PersonalConnectionCredentialStore,
    CredentialStore.PersonalConnectionCredentialStore.of({
      create: () => Effect.die("unused"),
      createNext: () => Effect.die("unused"),
      replaceInPlace: () => Effect.die("unused"),
      read: () => Effect.succeed(Option.some({ refreshToken: Redacted.make("refresh-token") })),
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
    writeStatus: () => Effect.succeed(true),
    writeReceipt: () => Effect.succeed(true),
  });

  const tasks = Layer.mock(PersonalTaskService.PersonalTaskService)({
    waitForUser: () => Effect.succeed(undefined as unknown as never),
    resumeFromUser: () => Effect.succeed(undefined as unknown as never),
    failWaitingForUser: () => Effect.succeed(undefined as unknown as never),
  });
  const browser = Layer.mock(PersonalBrowser)({ sensitiveExposure: () => Effect.succeed([]) });

  const gmail: Adapters.ConnectionVendorAdapter = {
    vendorId: "gmail",
    validate: () => Effect.die("validate is not part of a gateway call"),
    vendorSchema: () => Effect.succeed(GMAIL_SCHEMA),
    execute: (call) =>
      Effect.sync(() => {
        calls.push(call);
        return { messages: [], standingRule: "rule", internalNote: "never returned" };
      }),
  };

  const layer = Gateway.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        connections,
        credentials,
        browser,
        Adapters.layerOf([gmail]),
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
  );
  return { layer, approvals, calls };
};

const two: ReadonlyArray<Mailbox> = [
  { connectionId: "conn-a", address: "a@gmail.com", status: "connected" },
  { connectionId: "conn-b", address: "b@gmail.com", status: "connected" },
];

describe("PersonalConnectionGateway with several mailboxes", () => {
  it.effect("sends each call to the connection that owns the named mailbox", () =>
    Effect.gen(function* () {
      const harness = makeHarness(two);
      yield* Effect.gen(function* () {
        const gateway = yield* Gateway.PersonalConnectionGateway;
        const first = yield* gateway.call({
          operation: "gmail.search",
          arguments: { mailbox: "a@gmail.com", text: "invoice" },
          caller,
        });
        yield* gateway.call({
          operation: "gmail.search",
          arguments: { mailbox: "B@gmail.com" },
          caller,
        });
        expect(harness.calls.map((call) => call.connectionId)).toEqual(["conn-a", "conn-b"]);
        expect(first).toMatchObject({
          _tag: "completed",
          result: { messages: [], standingRule: "rule" },
        });
        expect(first).not.toHaveProperty("result.internalNote");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("refuses a mailbox that is not connected and names the ones that are", () =>
    Effect.gen(function* () {
      const harness = makeHarness([
        ...two,
        { connectionId: "conn-c", address: "c@gmail.com", status: "disabled" },
      ]);
      yield* Effect.gen(function* () {
        const gateway = yield* Gateway.PersonalConnectionGateway;
        const error = yield* Effect.flip(
          gateway.call({
            operation: "gmail.search",
            arguments: { mailbox: "c@gmail.com" },
            caller,
          }),
        );
        expect(error.reason).toContain("c@gmail.com");
        expect(error.reason).toContain("Connected: a@gmail.com, b@gmail.com");
        expect(harness.calls).toEqual([]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("saves a draft in the mailbox that was named, with no approval card", () =>
    Effect.gen(function* () {
      const harness = makeHarness(two);
      yield* Effect.gen(function* () {
        const gateway = yield* Gateway.PersonalConnectionGateway;
        const draft = { to: ["x@example.com"], subject: "Hello", body: "Hi there" };
        const inA = yield* gateway.call({
          operation: "gmail.create_draft",
          arguments: { mailbox: "a@gmail.com", ...draft },
          caller,
        });
        const inB = yield* gateway.call({
          operation: "gmail.create_draft",
          arguments: { mailbox: "b@gmail.com", ...draft },
          caller,
        });
        expect(inA._tag).toBe("completed");
        expect(inB._tag).toBe("completed");
        expect(harness.approvals.size).toBe(0);
        expect(harness.calls.map((call) => call.connectionId)).toEqual(["conn-a", "conn-b"]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("describes a multi-account vendor once, with every connected address", () =>
    Effect.gen(function* () {
      const harness = makeHarness([
        ...two,
        { connectionId: "conn-c", address: "c@gmail.com", status: "disabled" },
      ]);
      yield* Effect.gen(function* () {
        const gateway = yield* Gateway.PersonalConnectionGateway;
        const described = yield* gateway.describe();
        expect(described).toHaveLength(1);
        expect(described[0]).toMatchObject({
          vendorId: "gmail",
          displayName: "Gmail",
          accounts: ["a@gmail.com", "b@gmail.com"],
        });
        expect(described[0]?.operations.map((operation) => operation.operation)).toEqual([
          "gmail.search",
          "gmail.list_threads",
          "gmail.read_message",
          "gmail.read_thread",
          "gmail.create_draft",
        ]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});
