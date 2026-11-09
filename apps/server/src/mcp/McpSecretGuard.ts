/**
 * One place where every tool call's input is cleaned of saved secret values
 * before any handler sees it.
 *
 * A bot that holds a key (an env-mode key in its shell, or one it was told in
 * a message) can write it into any text a tool stores or sends: a push, a
 * delegation brief, a routine prompt, a bot's instructions, a task title, a
 * browser-help reason, a vote. Masking each handler's output field by field
 * would miss the next one added, so the guard sits on `McpServer.addTool`: every
 * registered tool, hand-registered ones included, gets its payload masked first.
 * The brokered keys' `{{secret:NAME}}` placeholders are not values and pass.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer } from "effect/ai";
import type * as Tool from "effect/ai/Tool";
import type * as Toolkit from "effect/ai/Toolkit";

import { secretRedactor, type SecretRedactor } from "../personal/secrets/secretRedaction.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

type McpServerService = McpServer.McpServer["Service"];

/**
 * The same server, with every tool it registers handed a payload with saved values masked. It
 * is also the one place every tool is advertised from, so each gets its compact input schema
 * here (advertisedJsonSchema.ts); decoding still uses the tool's full schema.
 */
export const guardMcpServer = (
  server: McpServerService,
  redactor: SecretRedactor = secretRedactor,
): McpServerService =>
  Object.create(server, {
    addTool: {
      value: ((options) =>
        server.addTool({
          ...options,
          tool: options.tool,
          handle: (payload) => options.handle(redactor.redact(payload)),
        })) satisfies McpServerService["addTool"],
    },
  }) as McpServerService;

/**
 * Hands each tool call the services its registration was built with; the
 * request's own context still wins. Effect 4.1 models tool handler services as
 * request-level McpRequest requirements, and this middleware is the bridge
 * from the registration layer's context to that request context.
 */
export const provideRegistrationServices = <Services>() =>
  McpServer.middleware<{ provides: Services }>()(
    Effect.map(
      Effect.context<Services>(),
      (services) => (effect) =>
        Effect.updateContext(effect, (request: Context.Context<never>) =>
          Context.merge(services, request),
        ),
    ),
  );

/** `McpServer.toolkit` with the secret guard on every tool the toolkit registers. */
export const guardedToolkit = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>,
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      yield* McpServer.registerToolkit(toolkit).pipe(
        Effect.provideService(McpServer.McpServer, guardMcpServer(server)),
      );
    }),
  ).pipe(
    Layer.provide(
      provideRegistrationServices<
        Exclude<Tool.Requirements<Tools[keyof Tools]>, McpInvocationContext.McpInvocationContext>
      >().layer,
    ),
    Layer.provide(McpServer.McpServer.layer),
  );
