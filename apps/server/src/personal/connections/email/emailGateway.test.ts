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

import { PersonalBrowser } from "../../browser/PersonalBrowser.ts";
import * as PersonalTaskService from "../../tasks/PersonalTaskService.ts";
import * as Adapters from "../adapters.ts";
import * as ApprovalRepository from "../approvalRepository.ts";
import * as ApprovalService from "../approvalService.ts";
import * as CredentialStore from "../credentialStore.ts";
import * as Gateway from "../gateway.ts";
import * as ConnectionService from "../service.ts";
import type { VendorHttp } from "../vendors/vendorHttp.ts";
import { makeEmailAdapter } from "./adapter.ts";
import { makeGmailApi } from "./gmailApi.ts";
import { makeEndpoints } from "./oauthEndpoints.ts";
import type { EmailOAuthHttp } from "./oauthHttp.ts";
import type { EmailTokenBroker } from "./tokenBroker.ts";

const ACCESS = "ya29.gateway-access-token";
const caller = {
  threadId: ThreadId.make("thread-1"),
  botId: PersonalBotId.make("bot-1"),
  taskId: PersonalTaskId.make("task-1"),
};

const harness = () => {
  const approvals = new Map<string, PersonalConnectionApproval>();
  const requests: Array<{ method: string; url: string }> = [];
  const http: VendorHttp = (request) =>
    Effect.sync(() => {
      requests.push({ method: request.method, url: request.url });
      if (request.url.endsWith("/profile")) {
        return { status: 200, body: { emailAddress: "owner@gmail.com" }, headers: {} };
      }
      if (request.url.endsWith("/drafts")) {
        return { status: 200, body: { id: "draft-1" }, headers: {} };
      }
      if (request.url.endsWith("/messages/send")) {
        return { status: 200, body: { id: "sent-1" }, headers: {} };
      }
      return {
        status: 500,
        body: { error: `unexpected ${request.url} with ${ACCESS}` },
        headers: {},
      };
    });
  const broker: EmailTokenBroker["Service"] = {
    accessToken: () => Effect.succeed(Redacted.make(ACCESS)),
    forget: () => Effect.void,
  };

  const connections = Layer.mock(ConnectionService.PersonalConnectionService)({
    markNeedsReauth: () => Effect.void,
    resolveForOperation: (vendorId, account) =>
      Effect.succeed(
        vendorId === "gmail" && account?.toLowerCase() === "owner@gmail.com"
          ? Option.some({
              connectionId: ConnectionId.make("conn-1"),
              vendorId,
              credentialRef: "ref-1",
              credentialVersion: 1,
              account: {
                accountId: "owner@gmail.com",
                accountName: "owner@gmail.com",
                teamId: null,
                teamName: null,
              },
              settings: { whatsappDailySendCap: null },
            })
          : Option.none(),
      ),
  });
  const credentials = Layer.succeed(
    CredentialStore.PersonalConnectionCredentialStore,
    CredentialStore.PersonalConnectionCredentialStore.of({
      create: () => Effect.die("unused"),
      createNext: () => Effect.die("unused"),
      replaceInPlace: () => Effect.die("unused"),
      read: () =>
        Effect.succeed(Option.some({ refreshToken: Redacted.make("1//0stored-refresh") })),
      remove: () => Effect.void,
    }),
  );
  const repository = ApprovalRepository.PersonalConnectionApprovalRepository.of({
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
        if (row === undefined) return false;
        const settlingClaim =
          input.outcome !== "dispatching" && row.executionOutcome === "dispatching";
        if (row.executedAt !== null && !settlingClaim) return false;
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

  const adapters = Layer.effect(
    Adapters.ConnectionVendorAdapters,
    makeEmailAdapter("gmail", makeGmailApi(http), {
      vendorHttp: http,
      broker,
      clients: {
        get: () => Effect.succeed(Option.none()),
        set: () => Effect.void,
        configured: () => Effect.succeed([]),
      },
      oauthHttp: { post: () => Effect.die("unused") } as EmailOAuthHttp["Service"],
      endpoints: makeEndpoints({}),
    }).pipe(Effect.map((adapter) => Adapters.makeAdapters([adapter]))),
  );

  const layer = Gateway.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        connections,
        credentials,
        browser,
        adapters,
        ApprovalService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ApprovalRepository.PersonalConnectionApprovalRepository, repository),
              tasks,
            ),
          ),
        ),
      ),
    ),
  );
  return { layer, approvals, requests };
};

const send = {
  operation: "gmail.send",
  arguments: {
    mailbox: "owner@gmail.com",
    to: ["friend@example.com", "boss@example.com"],
    cc: ["audit@example.com"],
    subject: "Quarterly numbers",
    body: "Line one\nLine two",
  },
  caller,
} as const;

describe("sending mail through the real Gmail adapter", () => {
  it.effect("holds a send until the owner answers, shows everything, and runs it once", () => {
    const h = harness();
    return Effect.gen(function* () {
      const gateway = yield* Gateway.PersonalConnectionGateway;
      const approvals = yield* ApprovalService.PersonalConnectionApprovalService;

      const first = yield* gateway.call(send);
      expect(first._tag).toBe("awaiting_approval");
      expect(h.requests).toEqual([]);
      const approvalId = first._tag === "awaiting_approval" ? first.approvalId : "";
      const summary = h.approvals.get(approvalId)?.summary ?? "";
      expect(summary).toContain("owner@gmail.com");
      expect(summary).toContain("friend@example.com, boss@example.com");
      expect(summary).toContain("cc audit@example.com");
      expect(summary).toContain("Quarterly numbers");
      expect(summary).toContain("Line one\nLine two");

      yield* approvals.decide({ approvalId: approvalId as never, decision: "approved" });
      const second = yield* gateway.call(send);
      expect(second._tag).toBe("completed");
      expect(h.requests.filter((request) => request.url.endsWith("/messages/send"))).toHaveLength(
        1,
      );

      const third = yield* gateway.call(send);
      expect(third._tag).toBe("awaiting_approval");
      expect(h.requests.filter((request) => request.url.endsWith("/messages/send"))).toHaveLength(
        1,
      );
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("a changed body is a new approval, not the old one reused", () => {
    const h = harness();
    return Effect.gen(function* () {
      const gateway = yield* Gateway.PersonalConnectionGateway;
      const approvals = yield* ApprovalService.PersonalConnectionApprovalService;
      const first = yield* gateway.call(send);
      const approvalId = first._tag === "awaiting_approval" ? first.approvalId : "";
      yield* approvals.decide({ approvalId: approvalId as never, decision: "approved" });
      const changed = yield* gateway.call({
        ...send,
        arguments: { ...send.arguments, body: "Something else entirely" },
      });
      expect(changed._tag).toBe("awaiting_approval");
      expect(h.requests).toEqual([]);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("a denied send never reaches Gmail", () => {
    const h = harness();
    return Effect.gen(function* () {
      const gateway = yield* Gateway.PersonalConnectionGateway;
      const approvals = yield* ApprovalService.PersonalConnectionApprovalService;
      const first = yield* gateway.call(send);
      const approvalId = first._tag === "awaiting_approval" ? first.approvalId : "";
      yield* approvals.decide({ approvalId: approvalId as never, decision: "denied" });
      const again = yield* Effect.exit(gateway.call(send));
      expect(h.requests).toEqual([]);
      expect(again._tag === "Success" ? again.value._tag : "failed").not.toBe("completed");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("a draft needs no approval and nothing is sent", () => {
    const h = harness();
    return Effect.gen(function* () {
      const gateway = yield* Gateway.PersonalConnectionGateway;
      const result = yield* gateway.call({ ...send, operation: "gmail.create_draft" });
      expect(result).toMatchObject({ _tag: "completed", result: { draftRef: "draft-1" } });
      expect(h.requests.some((request) => request.url.endsWith("/messages/send"))).toBe(false);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("an error the provider returned never carries the access token to the bot", () => {
    const h = harness();
    return Effect.gen(function* () {
      const gateway = yield* Gateway.PersonalConnectionGateway;
      const failure = yield* Effect.flip(
        gateway.call({
          ...send,
          operation: "gmail.read_message",
          arguments: { mailbox: "owner@gmail.com", messageRef: "m1" },
        }),
      );
      expect(failure.reason).toContain("[redacted]");
      expect(failure.reason).not.toContain(ACCESS);
    }).pipe(Effect.provide(h.layer));
  });
});
