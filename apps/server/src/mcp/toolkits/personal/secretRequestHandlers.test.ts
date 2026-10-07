// @effect-diagnostics nodeBuiltinImport:off - a real local HTTPS server is the point of these tests.
import * as NodeHttps from "node:https";
import type * as NodeNet from "node:net";

import { EnvironmentId, PersonalBotId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import { PersonalBotRepository } from "../../../personal/PersonalBotRepository.ts";
import { PersonalBrowser } from "../../../personal/browser/PersonalBrowser.ts";
import { PersonalMemoryService } from "../../../personal/memory/PersonalMemoryService.ts";
import { PersonalRoutineService } from "../../../personal/routines/PersonalRoutineService.ts";
import {
  PersonalSessionAccess,
  type PersonalSessionSecret,
} from "../../../personal/secrets/PersonalSessionAccess.ts";
import { SecretBrokerConfig } from "../../../personal/secrets/secretBroker.ts";
import { TEST_TLS_CERT, TEST_TLS_KEY } from "../../../personal/secrets/secretBrokerTestCert.ts";
import { secretRedactor } from "../../../personal/secrets/secretRedaction.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { PersonalToolkitHandlersLive } from "./handlers.ts";
import { PersonalToolkit } from "./tools.ts";

const VALUE = "vercel_pat_Zx9Qk2LmN4pR7sT0uV3wY6aB8cD1eF5g";
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

let server: NodeHttps.Server;
let port = 0;
const received: Array<NodeJS.Dict<string | string[]>> = [];

beforeAll(async () => {
  server = NodeHttps.createServer(
    { key: TEST_TLS_KEY, cert: TEST_TLS_CERT },
    (request, response) => {
      received.push(request.headers);
      response.setHeader("content-type", "application/json");
      // An API that echoes the credential back in its answer.
      response.end(
        JSON.stringify({ projects: [], echoedAuthorization: request.headers.authorization }),
      );
    },
  );
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as NodeNet.AddressInfo).port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function call(options: {
  readonly capability?: boolean;
  readonly linked?: boolean;
  readonly exposure?: ReadonlyArray<string>;
  readonly secrets?: ReadonlyArray<PersonalSessionSecret>;
  readonly url?: string;
}) {
  const origin = `https://api.test.example:${port}`;
  const secrets = options.secrets ?? [
    { name: "VERCEL_TOKEN", mode: "brokered", origins: [origin], value: VALUE },
  ];
  const layer = PersonalToolkitHandlersLive.pipe(
    Layer.provide(
      Layer.mock(PersonalBrowser)({
        sensitiveExposure: () => Effect.succeed(options.exposure ?? []),
      }),
    ),
    Layer.provide(Layer.mock(PersonalBotRepository)({ listBots: () => Effect.succeed([]) })),
    Layer.provide(Layer.mock(PersonalRoutineService)({})),
    Layer.provide(
      Layer.mock(PersonalMemoryService)({
        botForThread: () =>
          Effect.succeed(
            options.linked === false ? Option.none() : Option.some(PersonalBotId.make("bot")),
          ),
      }),
    ),
    Layer.provide(
      Layer.mock(PersonalSessionAccess)({
        forThread: () =>
          Effect.succeed({
            botId: PersonalBotId.make("bot"),
            systemInstructions: null,
            environment: {},
          }),
        secretsForThread: () => Effect.succeed(secrets),
      }),
    ),
    Layer.provide(
      Layer.succeed(SecretBrokerConfig, {
        resolve: async () => [{ address: "127.0.0.1", family: 4 }],
        isAddressAllowed: () => true,
        requestOptions: { ca: TEST_TLS_CERT },
      }),
    ),
  );
  return Effect.gen(function* () {
    const toolkit = yield* PersonalToolkit;
    return yield* toolkit
      .handle("secret_request", {
        method: "GET",
        url: options.url ?? `${origin}/v9/projects`,
        headers: { Authorization: "Bearer {{secret:VERCEL_TOKEN}}" },
      })
      .pipe(Stream.unwrap, Stream.runCollect);
  }).pipe(
    Effect.provide(layer),
    Effect.provideService(McpInvocationContext, {
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make("thread"),
      providerSessionId: "session",
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(options.capability === false ? [] : ["personal" as const]),
      issuedAt: 1,
    }),
  );
}

const refusal = (effect: ReturnType<typeof call>) =>
  effect.pipe(Effect.catch((error) => Effect.succeed(`REFUSED ${String(error)} ${encode(error)}`)));

describe("secret_request tool", () => {
  it.effect("sends the request with the key added and returns an answer without it", () =>
    Effect.gen(function* () {
      secretRedactor.set("VERCEL_TOKEN", VALUE);
      received.length = 0;
      const result = yield* call({}).pipe(
        Effect.ensuring(Effect.sync(() => secretRedactor.clear())),
      );
      expect(received[0]?.authorization).toBe(`Bearer ${VALUE}`);
      const text = encode(result);
      expect(text).not.toContain(VALUE);
      expect(text).toContain("[secret VERCEL_TOKEN]");
      expect(text).toContain('"status":200');
      expect(text).toContain(`https://api.test.example:${port}`);
    }),
  );

  it.effect("refuses outside a personal bot chat", () =>
    Effect.gen(function* () {
      for (const options of [{ capability: false }, { linked: false }]) {
        received.length = 0;
        const text = encode(yield* refusal(call(options)));
        expect(text).toMatch(/REFUSED|capability|personal bot chat/i);
        expect(received).toEqual([]);
      }
    }),
  );

  it.effect("is closed for the rest of a chat once a sensitive site was open", () =>
    Effect.gen(function* () {
      received.length = 0;
      const text = encode(yield* refusal(call({ exposure: ["https://bank.example"] })));
      expect(text).toMatch(/sensitive/i);
      expect(received).toEqual([]);
      // Its own wording: about API keys and a new chat, not the search tools.
      expect(text).toContain("API keys cannot be used in this chat");
      expect(text).toContain("https://bank.example");
      expect(text).toContain("start a new chat");
      expect(text).not.toMatch(/research tools|search provider|look it up|search it/i);
    }),
  );

  it.effect(
    "refuses a key that is not brokered, another origin and a host that is not allowed",
    () =>
      Effect.gen(function* () {
        received.length = 0;
        const env = encode(
          yield* refusal(
            call({
              secrets: [{ name: "VERCEL_TOKEN", mode: "env", origins: [], value: VALUE }],
            }),
          ),
        );
        expect(env).toContain("environment variable");
        const other = encode(yield* refusal(call({ url: "https://evil.example.com/steal" })));
        expect(other).toContain("not allowed to be sent to https://evil.example.com");
        const internal = encode(yield* refusal(call({ url: "https://127.0.0.1/x" })));
        expect(internal).toContain("not allowed");
        for (const text of [env, other, internal]) expect(text).not.toContain(VALUE);
        expect(received).toEqual([]);
      }),
  );

  it.effect("PERSONAL_SECRET_BROKER=off refuses every call", () =>
    Effect.gen(function* () {
      vi.stubEnv("PERSONAL_SECRET_BROKER", "off");
      received.length = 0;
      const text = encode(
        yield* refusal(call({})).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs()))),
      );
      expect(text).toContain("switched off");
      expect(received).toEqual([]);
    }),
  );
});
