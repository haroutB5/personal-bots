import * as NodeUtil from "node:util";

import {
  EnvironmentId,
  PersonalBotId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PersonalBotRepository } from "../../../personal/PersonalBotRepository.ts";
import * as Gateway from "../../../personal/connections/gateway.ts";
import * as PersonalTaskService from "../../../personal/tasks/PersonalTaskService.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { ConnectionsToolkitHandlersLive } from "./handlers.ts";
import { ConnectionsToolkit } from "./tools.ts";

/** Every string in the encoded results, on one line: what the model would read. */
const text = (value: unknown) =>
  NodeUtil.inspect(value, { depth: null, breakLength: Infinity, maxStringLength: null });

interface CallRecord {
  readonly operation: string;
  readonly caller: Gateway.ConnectionGatewayCaller;
}

const run = (input: {
  readonly capability: boolean;
  readonly linked: boolean;
  readonly gatewayResult?: Gateway.ConnectionCallResult;
  readonly gatewayError?: string;
  readonly recorded: Array<CallRecord>;
}) => {
  const layer = ConnectionsToolkitHandlersLive.pipe(
    Layer.provide(
      Layer.mock(Gateway.PersonalConnectionGateway)({
        call: (call) =>
          Effect.sync(() => {
            input.recorded.push({ operation: call.operation, caller: call.caller });
          }).pipe(
            Effect.andThen(
              input.gatewayError !== undefined
                ? Effect.fail(
                    new Gateway.PersonalConnectionGatewayError({ reason: input.gatewayError }),
                  )
                : Effect.succeed(
                    input.gatewayResult ?? {
                      _tag: "completed" as const,
                      operationId: call.operation,
                      result: { repositories: ["me/app"] },
                      approvalId: null,
                    },
                  ),
            ),
          ),
        describe: () =>
          Effect.succeed([
            {
              vendorId: "github",
              displayName: "GitHub",
              operations: [
                {
                  operation: "github.list_repositories",
                  description: "List the repositories the connected GitHub account can reach.",
                  argumentsJsonSchema: '{"type":"object"}',
                },
              ],
            },
          ]),
      }),
    ),
    Layer.provide(
      Layer.mock(PersonalBotRepository)({
        getThreadLink: () =>
          Effect.succeed(
            input.linked
              ? Option.some({
                  threadId: ThreadId.make("thread"),
                  botId: PersonalBotId.make("bot"),
                } as never)
              : Option.none(),
          ),
      }),
    ),
    Layer.provide(Layer.mock(PersonalTaskService.PersonalTaskService)({})),
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
        // No running turn in this chat: the card can still be raised, the bot
        // just is not resumed automatically.
        getThreadShellById: () => Effect.succeedNone,
      }),
    ),
  );

  return Effect.provideService(
    Effect.provide(
      Effect.gen(function* () {
        const toolkit = yield* ConnectionsToolkit;
        return yield* toolkit
          .handle("connection_call", {
            operation: "github.list_repositories",
            arguments: {},
          })
          .pipe(Stream.unwrap, Stream.runCollect);
      }),
      layer,
    ),
    McpInvocationContext,
    {
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make("thread"),
      providerSessionId: "session",
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(input.capability ? (["bots"] as const) : []),
      issuedAt: 1,
    },
  );
};

describe("connections toolkit", () => {
  it.effect("refuses outside a personal bot thread and never reaches the gateway", () =>
    Effect.gen(function* () {
      for (const [capability, linked] of [
        [false, true],
        [true, false],
      ] as const) {
        const recorded: Array<CallRecord> = [];
        const error = yield* Effect.flip(run({ capability, linked, recorded }));
        expect(error._tag).toBe(
          capability ? "ConnectionsToolError" : "McpCapabilityUnavailableError",
        );
        expect(recorded).toEqual([]);
      }
    }),
  );

  it.effect("passes the thread's own identity to the gateway, not the model's claim", () =>
    Effect.gen(function* () {
      const recorded: Array<CallRecord> = [];
      yield* run({ capability: true, linked: true, recorded });
      expect(recorded).toEqual([
        {
          operation: "github.list_repositories",
          caller: {
            threadId: "thread",
            botId: "bot",
            taskId: null,
          },
        },
      ]);
    }),
  );

  it.effect("hands the awaiting-approval note straight back to the model", () =>
    Effect.gen(function* () {
      const recorded: Array<CallRecord> = [];
      const results = yield* run({
        capability: true,
        linked: true,
        recorded,
        gatewayResult: {
          _tag: "awaiting_approval",
          approvalId: "approval-1",
          summary: "Create the private GitHub repository hbots-demo.",
          note: Gateway.AWAITING_APPROVAL_NOTE,
        },
      });
      const encoded = text([...results]);
      expect(encoded).toContain("awaiting_approval");
      expect(encoded).toContain("Create the private GitHub repository hbots-demo.");
      // No result field while nothing has run.
      expect(encoded).toContain("result: null");
    }),
  );

  it.effect("surfaces a gateway refusal as the tool's own error", () =>
    Effect.gen(function* () {
      const recorded: Array<CallRecord> = [];
      const error = yield* Effect.flip(
        run({
          capability: true,
          linked: true,
          recorded,
          gatewayError: "GitHub is not connected, or the user disabled it.",
        }),
      );
      expect(error._tag).toBe("ConnectionsToolError");
      expect(error.message).toContain("not connected");
    }),
  );
});
