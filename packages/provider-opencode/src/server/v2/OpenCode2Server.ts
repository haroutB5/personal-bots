// One OpenCode 2 process serves all directories; share it across instance threads.
import type { OpenCodeClient } from "@opencode/client/effect";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as P from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as HttpClientError from "effect/http/HttpClientError";

import { withProviderSessionEnvironment } from "@t3tools/provider-core/server/mcpSession";

import * as OpenCodeRuntime from "../OpenCodeRuntime.ts";
import * as OpenCodeServerOwner from "../OpenCodeServerOwner.ts";
import { personalBotOpenCodeEnvironment } from "../opencodeBotIsolation.ts";
import * as OpenCode2Client from "./OpenCode2Client.ts";

const INFO_TIMEOUT = "5 seconds";

export interface OpenCode2Connection extends OpenCode2Client.OpenCode2Api {
  readonly url: string;
  readonly version: string;
  readonly external: boolean;
}

export interface OpenCode2BotEnvironment {
  readonly model?: string | undefined;
  readonly personalSecretEnvironment?: Readonly<Record<string, string>> | undefined;
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>> | undefined;
}

export class OpenCode2Server extends Context.Service<
  OpenCode2Server,
  {
    readonly withConnection: <A, E, R>(
      use: (connection: OpenCode2Connection) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | OpenCodeRuntime.OpenCodeRuntimeError, R>;
    /** A bot's own server: the bots config home, never the owner's. */
    readonly withBotConnection: <A, E, R>(
      input: OpenCode2BotEnvironment,
      use: (connection: OpenCode2Connection) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | OpenCodeRuntime.OpenCodeRuntimeError, R | Scope.Scope>;
  }
>()("@t3tools/provider-opencode/server/v2/OpenCode2Server") {}

/**
 * OpenCode 2 always requires one and prints a generated one to stdout
 * otherwise, so T3 supplies its own and keeps it in memory.
 */
const generatePassword = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const bytes = yield* random.randomBytes(32);
  return Redacted.make(Base64Url.encode(bytes), { label: "OPENCODE_PASSWORD" });
});

/** OPENCODE_PASSWORD overrides OPENCODE_SERVER_PASSWORD; drop the inherited 1.x variable. */
export const serverEnvironment = (
  environment: NodeJS.ProcessEnv,
  password: Redacted.Redacted,
): NodeJS.ProcessEnv => {
  const { OPENCODE_SERVER_PASSWORD: _inherited, ...rest } = environment;
  return { ...rest, OPENCODE_PASSWORD: Redacted.value(password) };
};

const httpFailureOf = (cause: unknown): HttpClientError.HttpClientError | undefined => {
  if (HttpClientError.isHttpClientError(cause)) return cause;
  if (
    P.isTagged(cause, "ClientError") &&
    P.hasProperty(cause, "cause") &&
    HttpClientError.isHttpClientError(cause.cause)
  ) {
    return cause.cause;
  }
  return undefined;
};

// Empty 401s still reject passwords; undecodable 2xx may be 1.x HTML, not OpenCode 2.
const describeInfoFailure = (cause: unknown) => {
  const failure = httpFailureOf(cause);
  if (failure?.reason._tag === "TransportError") {
    return "Could not reach the OpenCode server.";
  }
  const status = failure?.response?.status;
  if (status === 401) return "The OpenCode server rejected the server password.";
  if (status !== undefined && (status < 200 || status >= 300)) {
    return `The OpenCode server returned HTTP ${status}.`;
  }
  return "The server is not an OpenCode 2 server.";
};

/** Only server info proves readiness; keep credential-bearing failure details out of client text. */
export const verifyServer = (client: OpenCodeClient) =>
  client.server.info().pipe(
    Effect.timeoutOrElse({
      duration: INFO_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new OpenCodeRuntime.OpenCodeRuntimeError({
            operation: "server.info",
            detail: "Timed out waiting for the OpenCode server.",
          }),
        ),
    }),
    Effect.catchTags({
      UnauthorizedError: (cause) =>
        Effect.fail(
          new OpenCodeRuntime.OpenCodeRuntimeError({
            operation: "server.info",
            detail: "The OpenCode server rejected the server password.",
            cause,
          }),
        ),
    }),
    Effect.mapError((cause) =>
      OpenCodeRuntime.isOpenCodeRuntimeError(cause)
        ? cause
        : new OpenCodeRuntime.OpenCodeRuntimeError({
            operation: "server.info",
            detail: describeInfoFailure(cause),
            cause,
          }),
    ),
    Effect.map((info) => info.version),
  );

export const make = Effect.fn("OpenCode2Server.make")(function* (input: {
  readonly binaryPath: string;
  readonly serverUrl: string;
  readonly serverPassword: string;
  readonly directory: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly botConfigHome?: string | undefined;
}) {
  const opencode = yield* OpenCode2Client.OpenCode2Client;
  const runtime = yield* OpenCodeRuntime.OpenCodeRuntime;
  const random = yield* SecureRandom.SecureRandom;
  const connectTo = Effect.fn("OpenCode2Server.connectTo")(function* (
    url: string,
    password: Redacted.Redacted,
    external: boolean,
  ) {
    const api = yield* opencode.connect({ baseUrl: url, password });
    const version = yield* verifyServer(api.client);
    return { ...api, url, version, external } satisfies OpenCode2Connection;
  });
  let latest: OpenCode2Connection | undefined;
  const remember = (connection: OpenCode2Connection) =>
    Effect.sync(() => {
      latest = connection;
      return connection.version;
    });
  const refuseBotOnExternalServer = Effect.fail(
    new OpenCodeRuntime.OpenCodeRuntimeError({
      operation: "server.start",
      detail:
        "Bots can't use an external OpenCode server. Clear the OpenCode server URL in Settings > Providers.",
    }),
  );

  const serverUrl = input.serverUrl.trim();
  if (serverUrl.length > 0) {
    const connect = connectTo(serverUrl, Redacted.make(input.serverPassword), true).pipe(
      Effect.tap(remember),
    );
    return OpenCode2Server.of({
      withConnection: Effect.fn("OpenCode2Server.withConnection")(function (use) {
        return Effect.suspend(() => (latest === undefined ? connect : Effect.succeed(latest))).pipe(
          Effect.flatMap(use),
        );
      }),
      withBotConnection: () => refuseBotOnExternalServer,
    });
  }

  const password = yield* generatePassword;
  const owner = yield* OpenCodeServerOwner.make({
    binaryPath: input.binaryPath,
    directory: input.directory,
    environment: serverEnvironment(input.environment, password),
    verify: (url) => connectTo(url, password, false).pipe(Effect.flatMap(remember)),
  });
  const withBotConnection = Effect.fn("OpenCode2Server.withBotConnection")(function* <A, E, R>(
    botInput: OpenCode2BotEnvironment,
    use: (connection: OpenCode2Connection) => Effect.Effect<A, E, R>,
  ): Effect.fn.Return<A, E | OpenCodeRuntime.OpenCodeRuntimeError, R | Scope.Scope> {
    if (input.botConfigHome === undefined) {
      return yield* new OpenCodeRuntime.OpenCodeRuntimeError({
        operation: "server.start",
        detail: "OpenCode could not prepare the bots' private settings folder, so bots can't run.",
      });
    }
    const botPassword = yield* generatePassword.pipe(
      Effect.provideService(SecureRandom.SecureRandom, random),
    );
    const environment = personalBotOpenCodeEnvironment({
      base: withProviderSessionEnvironment(input.environment, {
        ...(botInput.agentDeviceEnvironment === undefined
          ? {}
          : { agentDeviceEnvironment: botInput.agentDeviceEnvironment }),
        ...(botInput.personalSecretEnvironment === undefined
          ? {}
          : { personalSecretEnvironment: botInput.personalSecretEnvironment }),
      }),
      configHome: input.botConfigHome,
      model: botInput.model,
    });
    const botOwner = yield* OpenCodeServerOwner.make({
      binaryPath: input.binaryPath,
      directory: input.directory,
      environment: serverEnvironment(environment, botPassword),
      verify: (url) =>
        connectTo(url, botPassword, false).pipe(Effect.map((connection) => connection.version)),
    }).pipe(Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, runtime));
    return yield* botOwner.withServer((server) =>
      connectTo(server.url, botPassword, false).pipe(Effect.flatMap(use)),
    );
  });
  return OpenCode2Server.of({
    withConnection: Effect.fn("OpenCode2Server.withConnection")(function (use) {
      return owner.withServer((server) =>
        latest?.url === server.url
          ? use(latest)
          : Effect.die(new Error("OpenCode 2 server was lent before verification.")),
      );
    }),
    withBotConnection,
  });
});
