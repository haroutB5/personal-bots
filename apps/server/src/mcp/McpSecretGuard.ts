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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer } from "effect/unstable/ai";
import type * as Tool from "effect/unstable/ai/Tool";
import type * as Toolkit from "effect/unstable/ai/Toolkit";

import { secretRedactor, type SecretRedactor } from "../personal/secrets/secretRedaction.ts";

type McpServerService = McpServer.McpServer["Service"];

/** The same server, with every tool it registers handed a payload with saved values masked. */
export const guardMcpServer = (
  server: McpServerService,
  redactor: SecretRedactor = secretRedactor,
): McpServerService =>
  Object.create(server, {
    addTool: {
      value: ((options) =>
        server.addTool({
          ...options,
          handle: (payload) => options.handle(redactor.redact(payload)),
        })) satisfies McpServerService["addTool"],
    },
  }) as McpServerService;

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
  ).pipe(Layer.provide(McpServer.McpServer.layer));
