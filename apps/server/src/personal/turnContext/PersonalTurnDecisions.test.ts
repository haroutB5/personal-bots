import { MessageId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { PersonalEngine } from "../engine/PersonalEngine.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import * as PersonalTurnDecisionsModule from "./PersonalTurnDecisions.ts";
import { PersonalTurnDecisions } from "./PersonalTurnDecisions.ts";

const THREAD = ThreadId.make("thread-decisions");
const MODEL_A = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-a" };
const MODEL_B = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-b" };

interface Harness {
  modelSelection: typeof MODEL_A;
  thread: {
    title: string;
    titleState: { source: "manual" | "generated"; version: string } | null;
  };
}

const harness = (): Harness => ({
  modelSelection: MODEL_A,
  thread: { title: "New chat", titleState: null },
});

const layerFor = (state: Harness) =>
  PersonalTurnDecisionsModule.layer.pipe(
    Layer.provide(
      Layer.succeed(PersonalBotRepository.PersonalBotRepository, {
        getThreadLink: () => Effect.succeed(Option.some({ threadId: THREAD, botId: "bot-1" })),
        getBotById: () =>
          Effect.succeed(
            Option.some({
              botId: "bot-1",
              modelSelection: state.modelSelection,
            }),
          ),
        getChatTitleScope: () =>
          Effect.succeed(Option.some({ archived: false, peerTitles: ["Main"] })),
      } as never),
    ),
    Layer.provide(
      Layer.succeed(PersonalEngine, {
        getThread: () => Effect.succeed(Option.some(state.thread as never)),
      } as never),
    ),
  );

describe("PersonalTurnDecisions", () => {
  it.effect("reads the bot's current model selection, so an edit on an open chat wins", () => {
    const state = harness();
    return Effect.gen(function* () {
      const decisions = yield* PersonalTurnDecisions;
      expect(
        yield* decisions.modelSelection({
          threadId: THREAD,
          threadModelSelection: undefined,
        }),
      ).toEqual(MODEL_A);
      state.modelSelection = MODEL_B;
      expect(
        yield* decisions.modelSelection({
          threadId: THREAD,
          threadModelSelection: undefined,
        }),
      ).toEqual(MODEL_B);
    }).pipe(Effect.provide(layerFor(state)));
  });

  it.effect("seeds a placeholder chat with a name its bot's other chats do not have", () => {
    const state = harness();
    return Effect.gen(function* () {
      const decisions = yield* PersonalTurnDecisions;
      expect(
        yield* decisions.titleSeed({
          threadId: THREAD,
          messageId: MessageId.make("message-1"),
          titleSeed: "Main",
        }),
      ).toBe("Main 2");
    }).pipe(Effect.provide(layerFor(state)));
  });

  it.effect("a manual rename and a task turn keep their own title", () => {
    const state = harness();
    state.thread = { title: "Owner named", titleState: { source: "manual", version: "v1" } };
    return Effect.gen(function* () {
      const decisions = yield* PersonalTurnDecisions;
      expect(
        yield* decisions.titleSeed({
          threadId: THREAD,
          messageId: MessageId.make("message-1"),
          titleSeed: "Main",
        }),
      ).toBeUndefined();
      state.thread = { title: "New chat", titleState: null };
      expect(
        yield* decisions.titleSeed({
          threadId: THREAD,
          messageId: MessageId.make("personal-task-task-1-1"),
          titleSeed: "Main",
        }),
      ).toBeUndefined();
      state.thread = { title: "Already named", titleState: null };
      expect(
        yield* decisions.titleSeed({
          threadId: THREAD,
          messageId: MessageId.make("message-1"),
          titleSeed: "Main",
        }),
      ).toBeUndefined();
    }).pipe(Effect.provide(layerFor(state)));
  });
});
