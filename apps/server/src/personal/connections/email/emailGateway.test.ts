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

import { PersonalBrowser } from "../../browser/PersonalBrowser.ts";
import * as PersonalTaskService from "../../tasks/PersonalTaskService.ts";
import * as Adapters from "../adapters.ts";
import * as ApprovalRepository from "../approvalRepository.ts";
import * as ApprovalService from "../approvalService.ts";
import * as CredentialStore from "../credentialStore.ts";
import * as Gateway from "../gateway.ts";
import * as ConnectionService from "../service.ts";
import { makeEmailAdapter } from "./adapter.ts";
import type { CommonpostClient } from "./thunderbird/commonpostClient.ts";
import { THUNDERBIRD_CLOSED_LINE } from "./thunderbird/status.ts";
import { makeThunderbirdMailApi } from "./thunderbird/thunderbirdMailApi.ts";

const ROOT = "imap://owner%40gmail.com@imap.gmail.com";
const caller = {
  threadId: ThreadId.make("thread-1"),
  botId: PersonalBotId.make("bot-1"),
  taskId: PersonalTaskId.make("task-1"),
};

type Tool = Parameters<CommonpostClient["Service"]["call"]>[0];

const harness = (options: { readonly closed?: boolean } = {}) => {
  const approvals = new Map<string, PersonalConnectionApproval>();
  const calls: Array<{ tool: Tool; args: Readonly<Record<string, unknown>> }> = [];
  const reauthed: Array<string> = [];
  const client: CommonpostClient["Service"] = {
    call: (tool, args) => {
      calls.push({ tool, args });
      if (options.closed === true) {
        return Effect.fail(
          new Adapters.ConnectionVendorError({
            operationId: `thunderbird.${tool}`,
            detail: THUNDERBIRD_CLOSED_LINE,
            unavailable: true,
          }),
        );
      }
      if (tool === "listAccounts") {
        return Effect.succeed([
          {
            id: "account1",
            type: "imap",
            identities: [{ id: "i1", email: "owner@gmail.com", isDefault: true }],
          },
        ]);
      }
      if (tool === "listFolders") {
        return Effect.succeed([{ name: "INBOX", path: `${ROOT}/INBOX`, accountId: "account1" }]);
      }
      if (tool === "saveDraft") {
        return Effect.succeed({ messageId: "d1@mail", folderPath: `${ROOT}/Drafts` });
      }
      return Effect.succeed({ messages: [] });
    },
    status: () => Effect.succeed({ _tag: "closed" }),
  };

  const connections = Layer.mock(ConnectionService.PersonalConnectionService)({
    markNeedsReauth: (connectionId) =>
      Effect.sync(() => {
        reauthed.push(connectionId);
      }),
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
      read: () => Effect.die("a mailbox read through Thunderbird has no stored credential"),
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
    makeEmailAdapter("gmail", makeThunderbirdMailApi(client)).pipe(
      Effect.map((adapter) => Adapters.makeAdapters([adapter])),
    ),
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
  return { layer, approvals, calls, reauthed };
};

const draft = {
  operation: "gmail.create_draft",
  arguments: {
    mailbox: "owner@gmail.com",
    to: ["friend@example.com", "boss@example.com"],
    cc: ["audit@example.com"],
    subject: "Quarterly numbers",
    body: "Line one\nLine two",
  },
  caller,
} as const;

describe("a Gmail mailbox read through Thunderbird", () => {
  it.effect("saves a draft without an approval and without reading a stored credential", () => {
    const h = harness();
    return Effect.gen(function* () {
      const gateway = yield* Gateway.PersonalConnectionGateway;
      const result = yield* gateway.call(draft);
      expect(result._tag).toBe("completed");
      expect(result._tag === "completed" ? result.result : null).toMatchObject({
        draftRef: expect.stringMatching(/^[A-Za-z0-9_\-=+.]+$/),
      });
      expect(h.calls.map((call) => call.tool)).toEqual([
        "listAccounts",
        "listFolders",
        "saveDraft",
      ]);
      expect(h.calls[2]?.args).toMatchObject({ from: "owner@gmail.com", isHtml: false });
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("has no send operation to ask for", () => {
    const h = harness();
    return Effect.gen(function* () {
      const gateway = yield* Gateway.PersonalConnectionGateway;
      const failure = yield* Effect.flip(gateway.call({ ...draft, operation: "gmail.send" }));
      expect(failure.reason).toContain("gmail.send");
      expect(h.calls).toEqual([]);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect(
    "tells the bot Thunderbird is not running, leaves the connection alone and says nothing may have happened",
    () => {
      const h = harness({ closed: true });
      return Effect.gen(function* () {
        const gateway = yield* Gateway.PersonalConnectionGateway;
        const failure = yield* Effect.flip(gateway.call(draft));
        expect(failure.reason).toBe(THUNDERBIRD_CLOSED_LINE);
        expect(failure.ambiguous).toBeUndefined();
        expect(h.reauthed).toEqual([]);
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.effect("reads a mailbox search through the mailbox's folder root", () => {
    const h = harness();
    return Effect.gen(function* () {
      const gateway = yield* Gateway.PersonalConnectionGateway;
      const result = yield* gateway.call({
        ...draft,
        operation: "gmail.search",
        arguments: { mailbox: "owner@gmail.com", from: "alice@example.com", limit: 5 },
      });
      expect(result).toMatchObject({ _tag: "completed", result: { messages: [] } });
      expect(h.calls.at(-1)).toEqual({
        tool: "searchMessages",
        args: { query: 'from:"alice@example.com"', folderPath: ROOT, maxResults: 5 },
      });
    }).pipe(Effect.provide(h.layer));
  });
});
