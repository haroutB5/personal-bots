import { EnvironmentId, PersonalBotId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "@effect/vitest";

import { PersonalEngine } from "../../../personal/engine/PersonalEngine.ts";
import { PersonalBotRepository } from "../../../personal/PersonalBotRepository.ts";
import { PersonalBrowser } from "../../../personal/browser/PersonalBrowser.ts";
import { PersonalGroupService } from "../../../personal/groups/PersonalGroupService.ts";
import { PersonalLeadBotService } from "../../../personal/leadBots/PersonalLeadBotService.ts";
import { PersonalLoginRequestService } from "../../../personal/secrets/PersonalLoginRequestService.ts";
import { PersonalLoginService } from "../../../personal/secrets/PersonalLoginService.ts";
import { PersonalSecretService } from "../../../personal/secrets/PersonalSecretService.ts";
import { FCM_SERVICE_ACCOUNT_SECRET_NAME } from "../../../personal/secrets/serverOnlySecrets.ts";
import { PersonalTaskService } from "../../../personal/tasks/PersonalTaskService.ts";
import { mcpThreadScope } from "../../../personal/testing/mcpThreadScope.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { BotsToolkitHandlersLive } from "./handlers.ts";
import { BotsToolkit } from "./tools.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const BOT = PersonalBotId.make("bot");
const THREAD = ThreadId.make("thread");

function requestSecret(input: {
  readonly name: string;
  readonly status: "pending" | "fulfilled";
  readonly mode: "brokered" | "env";
}) {
  const layer = BotsToolkitHandlersLive.pipe(
    Layer.provide(
      Layer.mock(PersonalTaskService)({
        resolveCallerTask: () => Effect.succeed({ taskId: "task" } as never),
      }),
    ),
    Layer.provide(
      Layer.mock(PersonalBotRepository)({
        getThreadLink: () => Effect.succeed(Option.some({ botId: BOT } as never)),
        getBotById: () => Effect.succeed(Option.none()),
      }),
    ),
    Layer.provide(
      Layer.mock(PersonalSecretService)({
        request: (request) =>
          Effect.succeed({
            status: input.status,
            request: {
              requestId: "request",
              name: request.name,
              mode: input.mode,
              origins: ["https://fcm.googleapis.com"],
            } as never,
          }),
      }),
    ),
    Layer.provide(Layer.mock(PersonalLoginService)({})),
    Layer.provide(Layer.mock(PersonalLoginRequestService)({})),
    Layer.provide(
      Layer.mock(PersonalEngine)({
        getThread: () =>
          Effect.succeed(Option.some({ session: { activeTurnId: "turn" } } as never)),
      }),
    ),
    Layer.provide(Layer.mock(PersonalBrowser)({})),
    Layer.provide(
      Layer.mock(PersonalGroupService)({
        groupNameForMemberThread: () => Effect.succeed(Option.none()),
      }),
    ),
    Layer.provide(Layer.mock(PersonalLeadBotService)({})),
  );
  return Effect.gen(function* () {
    const toolkit = yield* BotsToolkit;
    const results = yield* toolkit
      .handle("request_secret", {
        name: input.name,
        label: input.name,
        purpose: "Test.",
        origins: ["https://fcm.googleapis.com"],
      })
      .pipe(Stream.unwrap, Stream.runCollect);
    return encode(results);
  }).pipe(
    Effect.provide(layer),
    Effect.provideService(
      McpInvocationContext,
      mcpThreadScope({
        environmentId: EnvironmentId.make("env"),
        threadId: THREAD,
        providerSessionId: "session",
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(["bots" as const]),
        issuedAt: 1,
      }),
    ),
  );
}

describe("request_secret for a server-only key", () => {
  for (const status of ["pending", "fulfilled"] as const) {
    it.effect(`tells the bot it cannot use the key when the request is ${status}`, () =>
      Effect.gen(function* () {
        const text = yield* requestSecret({
          name: FCM_SERVICE_ACCOUNT_SECRET_NAME,
          status,
          mode: "env",
        });
        expect(text).toContain("server-only");
        expect(text).toContain("bots cannot use it");
        expect(text).not.toContain("PB_SECRET");
        expect(text).not.toContain("brokered");
      }),
    );
  }

  it.effect("an ordinary key still gets its environment variable and brokered guidance", () =>
    Effect.gen(function* () {
      const env = yield* requestSecret({ name: "DEPLOY_KEY", status: "fulfilled", mode: "env" });
      expect(env).toContain("PB_SECRET_DEPLOY_KEY");
      expect(env).not.toContain("server-only");
      const brokered = yield* requestSecret({
        name: "DEPLOY_KEY",
        status: "fulfilled",
        mode: "brokered",
      });
      expect(brokered).toContain("{{secret:DEPLOY_KEY}}");
    }),
  );
});
