import {
  EnvironmentId,
  PersonalBotId,
  PersonalMemoryId,
  ProviderInstanceId,
  ThreadId,
  type PersonalBot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import { PersonalBotRepository } from "../../../personal/PersonalBotRepository.ts";
import { PersonalBrowser } from "../../../personal/browser/PersonalBrowser.ts";
import { PersonalMemoryService } from "../../../personal/memory/PersonalMemoryService.ts";
import { PersonalRoutineService } from "../../../personal/routines/PersonalRoutineService.ts";
import { PersonalSessionAccess } from "../../../personal/secrets/PersonalSessionAccess.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { PersonalToolkitHandlersLive } from "./handlers.ts";
import { PersonalToolkit } from "./tools.ts";

const encodeResult = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const botId = PersonalBotId.make("cfo");
const epoch = DateTime.makeUnsafe("2026-09-23T00:00:00.000Z");

const bot = (memoryAutoSave: boolean): PersonalBot => ({
  botId,
  name: "CFO",
  title: "",
  description: "",
  instructions: "",
  avatarShape: "blob",
  avatarColor: "#1A73E8",
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" },
  enabled: true,
  sortOrder: 0,
  memoryAutoSave,
  createdAt: epoch,
  updatedAt: epoch,
});

function saveMemory(input: {
  readonly memoryAutoSave: boolean;
  readonly exposure: ReadonlyArray<string>;
  readonly userRequest: string;
}) {
  const saved = vi.fn();
  const layer = PersonalToolkitHandlersLive.pipe(
    Layer.provide(
      Layer.mock(PersonalBrowser)({ sensitiveExposure: () => Effect.succeed(input.exposure) }),
    ),
    Layer.provide(
      Layer.mock(PersonalBotRepository)({
        listBots: () => Effect.succeed([bot(input.memoryAutoSave)]),
        getBotById: () => Effect.succeed(Option.some(bot(input.memoryAutoSave))),
      }),
    ),
    Layer.provide(Layer.mock(PersonalRoutineService)({})),
    Layer.provide(
      Layer.mock(PersonalMemoryService)({
        botForThread: () => Effect.succeed(Option.some(botId)),
        save: (entry) =>
          Effect.sync(() => {
            saved(entry);
            return {
              memoryId: PersonalMemoryId.make("memory-1"),
              scope: entry.scope,
              scopeId: entry.scopeId ?? null,
              kind: entry.kind,
              content: entry.content,
              source: entry.source ?? "",
              sensitivity: "normal",
              createdAt: epoch,
              updatedAt: epoch,
              version: 1,
            };
          }),
      }),
    ),
    Layer.provide(Layer.mock(PersonalSessionAccess)({})),
  );
  return Effect.gen(function* () {
    const toolkit = yield* PersonalToolkit;
    const result = yield* toolkit
      .handle("save_memory", {
        content: "Holds 2 ETH on Kraken, bought at about 1,900 GBP.",
        userRequest: input.userRequest,
      })
      .pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.catch((error) => Effect.succeed(String(error))),
      );
    return { encoded: encodeResult(result), saved };
  }).pipe(
    Effect.provide(layer),
    Effect.provideService(McpInvocationContext, {
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make("thread"),
      providerSessionId: "session",
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      capabilities: new Set(["personal" as const]),
      issuedAt: 1,
    }),
  );
}

describe("save_memory with a standing permission", () => {
  const unasked = "I hold 2 ETH on Kraken, bought at about 1,900 GBP";

  it.effect("saves an unasked fact for a bot the owner allowed", () =>
    Effect.gen(function* () {
      const { saved } = yield* saveMemory({
        memoryAutoSave: true,
        exposure: [],
        userRequest: unasked,
      });
      expect(saved).toHaveBeenCalledTimes(1);
      expect(saved.mock.calls[0]?.[0]).toMatchObject({ scope: "shared", source: "bot:cfo" });
    }),
  );

  it.effect("refuses the same fact for a bot without the permission", () =>
    Effect.gen(function* () {
      const { encoded, saved } = yield* saveMemory({
        memoryAutoSave: false,
        exposure: [],
        userRequest: unasked,
      });
      expect(saved).not.toHaveBeenCalled();
      expect(encoded).toContain("explicitly asks");
    }),
  );

  it.effect("refuses an unasked save in a chat that had a sensitive site open", () =>
    Effect.gen(function* () {
      const { encoded, saved } = yield* saveMemory({
        memoryAutoSave: true,
        exposure: ["https://www.kraken.com"],
        userRequest: unasked,
      });
      expect(saved).not.toHaveBeenCalled();
      expect(encoded).toContain("https://www.kraken.com");
    }),
  );

  it.effect("still saves on an explicit ask, as before", () =>
    Effect.gen(function* () {
      const { saved } = yield* saveMemory({
        memoryAutoSave: false,
        exposure: [],
        userRequest: `remember this: ${unasked}`,
      });
      expect(saved).toHaveBeenCalledTimes(1);
    }),
  );
});
