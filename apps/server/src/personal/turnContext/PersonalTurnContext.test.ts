import {
  MessageId,
  ThreadId,
  personalReplyContext,
  makePersonalReplyQuote,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as PersonalBotRepository from "../PersonalBotRepository.ts";
import type * as PersonalMemoryService from "../memory/PersonalMemoryService.ts";
import type * as PersonalVoiceCallRepository from "../voiceCalls/PersonalVoiceCallRepository.ts";
import { makePersonalTurnContext } from "./PersonalTurnContext.ts";

const THREAD = ThreadId.make("thread-personal");
const AT = DateTime.makeUnsafe("2026-11-06T12:00:00.000Z");

const persona = {
  name: "Nova",
  title: "Coach",
  instructions: "Keep answers short.",
  model: "claude-opus-5-5",
  effort: "high",
} as const;

interface Marks {
  delivered: Array<string>;
  confirmed: number;
}

const harness = (input: {
  readonly linked?: boolean;
  readonly instructions?: boolean;
  readonly memoryBlock?: string;
  readonly preferencesBlock?: string;
  readonly callSummaries?: ReadonlyArray<unknown>;
}) => {
  const marks: Marks = { delivered: [], confirmed: 0 };
  const context = makePersonalTurnContext({
    personalBots: {
      getInstructionsForThread: () =>
        Effect.succeed(
          input.instructions === false ? Option.none() : Option.some(persona as never),
        ),
      getThreadLink: () =>
        Effect.succeed(input.linked === false ? Option.none() : Option.some({ threadId: THREAD })),
      getChatTitleScope: () =>
        Effect.succeed(Option.some({ archived: false, peerTitles: ["Main"] })),
    } as unknown as PersonalBotRepository.PersonalBotRepository["Service"],
    personalMemory: Option.some({
      contextForThread: () =>
        Effect.succeed({
          block: input.memoryBlock ?? null,
          memoryIds: [],
          ...(input.preferencesBlock === undefined
            ? {}
            : { preferencesBlock: input.preferencesBlock }),
        }),
      confirmPreferencesSent: () =>
        Effect.sync(() => {
          marks.confirmed += 1;
        }),
    } as unknown as PersonalMemoryService.PersonalMemoryService["Service"]),
    voiceCalls: {
      summariesForTurn: () => Effect.succeed((input.callSummaries ?? []) as never),
      markSummariesDelivered: ({ callIds }: { readonly callIds: ReadonlyArray<string> }) =>
        Effect.sync(() => {
          marks.delivered.push(...callIds);
        }),
    } as unknown as PersonalVoiceCallRepository.PersonalVoiceCallRepository["Service"],
    projectionStore: {
      getThreadShell: () =>
        Effect.succeed({
          id: THREAD,
          projectId: "project-1",
        } as never),
    },
  });
  return { context, marks };
};

const callSummary = (callId: string) => ({
  callId,
  threadId: THREAD,
  botId: "bot-1",
  startedAt: AT,
  endedAt: AT,
  durationSeconds: 60,
  endReason: "owner_hangup",
  messageCount: 1,
  voiceName: "Charon",
  model: "gemini-3.8-live",
  detail: "",
  transcript: [],
  summary: {
    summary: "The owner asked for the deploy status.",
    points: [],
    decision: null,
    open: null,
  },
});

describe("PersonalTurnContext", () => {
  it.effect("session instructions carry the bot persona and app rules", () =>
    Effect.gen(function* () {
      const { context } = harness({});
      const instructions = yield* context.sessionInstructions(THREAD);
      expect(Option.isSome(instructions)).toBe(true);
      expect(Option.getOrThrow(instructions)).toContain("You are Nova (Coach)");
      expect(Option.getOrThrow(instructions)).toContain("<app_rules>");
    }),
  );

  it.effect("a thread with no bot gets no session instructions", () =>
    Effect.gen(function* () {
      const { context } = harness({ instructions: false });
      expect(yield* context.sessionInstructions(THREAD)).toEqual(Option.none());
    }),
  );

  it.effect("prepareTurn adds the reply quote and puts the call summary before memory", () =>
    Effect.gen(function* () {
      const { context } = harness({
        memoryBlock: "Known facts from memory.",
        callSummaries: [callSummary("call-1")],
      });
      const prepared = yield* context.prepareTurn({
        threadId: THREAD,
        messageId: MessageId.make("message-1"),
        text: "what changed?",
        context: personalReplyContext(
          makePersonalReplyQuote({
            messageId: "quoted-1",
            name: "You",
            text: "Ship it",
          }),
        ),
        freshSession: false,
        activeSession: undefined,
      });
      expect(prepared.text).toBe('[Replying to my earlier message: "Ship it"]\n\nwhat changed?');
      expect(prepared.extraContext).toContain("The owner asked for the deploy status.");
      expect(prepared.extraContext).toContain("Known facts from memory.");
      expect(prepared.extraContext?.indexOf("The owner asked")).toBeLessThan(
        prepared.extraContext?.indexOf("Known facts") ?? -1,
      );
      expect(prepared.callContext).toContain("The owner asked");
      expect(prepared.memoryBlock).toBe("Known facts from memory.");
    }),
  );

  it.effect("onSent full marks the call summaries and the preference list; none does neither", () =>
    Effect.gen(function* () {
      const { context, marks } = harness({ callSummaries: [callSummary("call-1")] });
      const prepared = yield* context.prepareTurn({
        threadId: THREAD,
        messageId: undefined,
        text: "hello",
        context: undefined,
        freshSession: true,
        activeSession: undefined,
      });
      yield* prepared.onSent("none");
      expect(marks).toEqual({ delivered: [], confirmed: 0 });
      yield* prepared.onSent("full");
      expect(marks.delivered).toEqual(["call-1"]);
      expect(marks.confirmed).toBe(1);
    }),
  );

  it.effect("uniqueTitle numbers a title another open chat of the bot already has", () =>
    Effect.gen(function* () {
      const { context } = harness({});
      expect(yield* context.uniqueTitle({ threadId: THREAD, title: "Main" })).toBe("Main 2");
      expect(yield* context.uniqueTitle({ threadId: THREAD, title: "Fresh" })).toBe("Fresh");
    }),
  );

  it.effect("isPersonalBotThread follows the thread link", () =>
    Effect.gen(function* () {
      expect(yield* harness({}).context.isPersonalBotThread(THREAD)).toBe(true);
      expect(yield* harness({ linked: false }).context.isPersonalBotThread(THREAD)).toBe(false);
    }),
  );
});
