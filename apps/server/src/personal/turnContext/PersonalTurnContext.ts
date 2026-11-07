/**
 * The personal half of a provider turn on the v2 engine.
 *
 * One module owns the turn-time personal behaviour: the bot's persona for a
 * session, the memory and voice-call context for a turn, the reply quote, and
 * the chat-name rules for titles. Provider code calls it instead of reaching
 * into the personal repositories.
 *
 * @module personal/turnContext/PersonalTurnContext
 */
import type {
  MessageId,
  OrchestrationMessageContext,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  VoiceCallRecord,
} from "@t3tools/contracts";
import { VOICE_CALL_SUMMARY_CONTEXT_CALLS, withPersonalReplyQuote } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  ProjectionStoreV2,
  type ProjectionStoreV2Shape,
} from "../../orchestration-v2/ProjectionStore.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import { personalBotSystemInstructions } from "../personalBotInstructions.ts";
import { isPersonalTaskMessageId } from "../personalThreadTitles.ts";
import { uniqueAutomaticTitle } from "../personalChatTitles.ts";
import * as PersonalMemoryService from "../memory/PersonalMemoryService.ts";
import * as PersonalSessionAccess from "../secrets/PersonalSessionAccess.ts";
import * as PersonalVoiceCallRepository from "../voiceCalls/PersonalVoiceCallRepository.ts";
import { voiceCallSummaryContextPacked } from "../voiceCalls/voiceCallSummaryContext.ts";

export interface PersonalThreadLookup {
  readonly personalBot: boolean;
  readonly personalBotId: string | undefined;
  readonly personalTaskChat: boolean;
  readonly botGrant: boolean;
  readonly linked: boolean;
  readonly systemInstructions: string | undefined;
  readonly secretEnvironment: Readonly<Record<string, string>> | undefined;
}

export type ActiveSession = {
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId?: ProviderInstanceId | null | undefined;
  readonly createdAt: DateTime.Utc;
};

export interface PreparedPersonalTurn {
  readonly text: string;
  readonly extraContext: string | undefined;
  readonly memoryBlock: string | undefined;
  readonly memoryPreferencesBlock: string | undefined;
  readonly callContext: string;
  readonly onSent: (delivery: "full" | "reduced" | "none" | undefined) => Effect.Effect<void>;
}

/** The personal half of a provider session, read once when the session opens. */
export interface PersonalSession {
  readonly personalBot: boolean;
  readonly personalBotId: string | undefined;
  readonly personalTaskChat: boolean;
  readonly secretEnvironment: Readonly<Record<string, string>> | undefined;
}

export interface PersonalTurnContextShape {
  readonly sessionInstructions: (threadId: ThreadId) => Effect.Effect<Option.Option<string>>;
  readonly sessionPersonal: (threadId: ThreadId) => Effect.Effect<PersonalSession>;
  readonly isPersonalBotThread: (threadId: ThreadId) => Effect.Effect<boolean>;
  readonly uniqueTitle: (input: {
    readonly threadId: ThreadId;
    readonly title: string;
  }) => Effect.Effect<string>;
  readonly prepareTurn: (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId | undefined;
    readonly text: string;
    readonly context: OrchestrationMessageContext | null | undefined;
    readonly freshSession: boolean;
    readonly activeSession: ActiveSession | undefined;
  }) => Effect.Effect<PreparedPersonalTurn>;
}

export class PersonalTurnContext extends Context.Service<
  PersonalTurnContext,
  PersonalTurnContextShape
>()("t3/personal/turnContext/PersonalTurnContext") {}

export const makePersonalTurnContext = (deps: {
  readonly personalBots: PersonalBotRepository.PersonalBotRepository["Service"];
  readonly personalSessions: Option.Option<PersonalSessionAccess.PersonalSessionAccess["Service"]>;
  readonly personalMemory: Option.Option<PersonalMemoryService.PersonalMemoryService["Service"]>;
  readonly voiceCalls: PersonalVoiceCallRepository.PersonalVoiceCallRepository["Service"];
  readonly projectionStore: Pick<ProjectionStoreV2Shape, "getThreadShell">;
}): PersonalTurnContextShape => {
  const sessionInstructions = (threadId: ThreadId) =>
    deps.personalBots.getInstructionsForThread({ threadId }).pipe(
      Effect.map((instructions) =>
        Option.map(instructions, (persona) => personalBotSystemInstructions(persona)),
      ),
      Effect.catchCause((cause) =>
        Effect.logDebug("personal bot instructions lookup failed; continuing without them", {
          threadId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(Option.none<string>())),
      ),
    );

  const noPersonalSession: PersonalSession = {
    personalBot: false,
    personalBotId: undefined,
    personalTaskChat: false,
    secretEnvironment: undefined,
  };

  const sessionPersonal = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const access = Option.isSome(deps.personalSessions)
        ? yield* deps.personalSessions.value.forThread(threadId)
        : undefined;
      const facts = yield* deps.personalBots
        .getChatFacts({ threadId })
        .pipe(Effect.orElseSucceed(() => Option.none()));
      const linked = Option.isSome(facts);
      const botId = access?.botId ?? (linked ? facts.value.botId : null);
      const secretEnvironment =
        access !== undefined && Object.keys(access.environment).length > 0
          ? access.environment
          : undefined;
      return {
        personalBot: linked || botId !== null,
        personalBotId: botId === null ? undefined : String(botId),
        personalTaskChat: linked ? facts.value.taskChat || facts.value.routineChat : false,
        secretEnvironment,
      } satisfies PersonalSession;
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logDebug("personal session lookup failed; treating it as not personal", {
              threadId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(noPersonalSession)),
      ),
    );

  const isPersonalBotThread = (threadId: ThreadId) =>
    deps.personalBots.getThreadLink({ threadId }).pipe(
      Effect.map(Option.isSome),
      Effect.catchCause((cause) =>
        Effect.logDebug("personal bot thread lookup failed; treating thread as not personal", {
          threadId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(false)),
      ),
    );

  const uniqueTitle: PersonalTurnContextShape["uniqueTitle"] = (input) =>
    uniqueAutomaticTitle(deps.personalBots, input);

  const memoryForTurn = (input: {
    readonly threadId: ThreadId;
    readonly query: string;
    readonly messageId: MessageId | undefined;
    readonly freshSession: boolean;
    readonly activeSession: ActiveSession | undefined;
  }) =>
    Effect.gen(function* () {
      if (Option.isNone(deps.personalMemory)) return undefined;
      const thread = yield* deps.projectionStore
        .getThreadShell(input.threadId)
        .pipe(Effect.orElseSucceed(() => null));
      const session = input.activeSession;
      const context = yield* deps.personalMemory.value.contextForThread({
        threadId: input.threadId,
        query: input.query,
        projectId: thread?.projectId,
        record: true,
        ...(input.messageId !== undefined ? { messageId: input.messageId } : {}),
        excludeTaskSummaries:
          input.messageId !== undefined && isPersonalTaskMessageId(input.messageId),
        session:
          session === undefined
            ? undefined
            : {
                key: `${session.providerInstanceId ?? session.provider}:${session.createdAt}`,
                fresh: input.freshSession,
              },
      });
      const block = context.block?.trim() ?? "";
      if (block.length === 0) return undefined;
      const preferencesBlock = context.preferencesBlock?.trim() ?? "";
      return {
        block,
        ...(preferencesBlock.length > 0 && preferencesBlock !== block ? { preferencesBlock } : {}),
      };
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("personal memory lookup failed; sending the turn without memory", {
              threadId: input.threadId,
              errorTag: PersonalMemoryService.errorTagOf(Cause.squash(cause)),
              cause: PersonalMemoryService.redactSecrets(Cause.pretty(cause)).slice(0, 2_000),
            }).pipe(Effect.as(undefined)),
      ),
    );

  const prepareTurn: PersonalTurnContextShape["prepareTurn"] = (input) =>
    Effect.gen(function* () {
      const memory = yield* memoryForTurn({
        threadId: input.threadId,
        query: input.text,
        messageId: input.messageId,
        freshSession: input.freshSession,
        activeSession: input.activeSession,
      });
      const callSummaries = yield* deps.voiceCalls
        .summariesForTurn({
          threadId: input.threadId,
          limit: VOICE_CALL_SUMMARY_CONTEXT_CALLS,
        })
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<VoiceCallRecord>));
      const packedCallContext = voiceCallSummaryContextPacked(callSummaries);
      const callContext = packedCallContext.block;
      const memoryContext = memory?.block;
      const extraContext =
        callContext === ""
          ? memoryContext
          : memoryContext === undefined || memoryContext.length === 0
            ? callContext
            : `${callContext}\n\n${memoryContext}`;
      return {
        text: withPersonalReplyQuote(input.text, input.context),
        extraContext,
        memoryBlock: memoryContext,
        memoryPreferencesBlock: memory?.preferencesBlock,
        callContext,
        onSent: (delivery) =>
          Effect.gen(function* () {
            if (delivery === "none") return;
            if (packedCallContext.callIds.length > 0) {
              yield* deps.voiceCalls
                .markSummariesDelivered({
                  callIds: packedCallContext.callIds,
                  at: yield* DateTime.now,
                })
                .pipe(
                  Effect.catchCause(() =>
                    Effect.logWarning(
                      "personal voice call summaries could not be marked delivered",
                      {
                        threadId: input.threadId,
                        count: packedCallContext.callIds.length,
                      },
                    ),
                  ),
                );
            }
            if (Option.isSome(deps.personalMemory)) {
              yield* deps.personalMemory.value.confirmPreferencesSent(input.threadId);
            }
          }),
      };
    });

  return { sessionInstructions, sessionPersonal, isPersonalBotThread, uniqueTitle, prepareTurn };
};

const make = Effect.gen(function* () {
  const personalBots = yield* PersonalBotRepository.PersonalBotRepository;
  const personalSessions = yield* Effect.serviceOption(PersonalSessionAccess.PersonalSessionAccess);
  const personalMemory = yield* Effect.serviceOption(PersonalMemoryService.PersonalMemoryService);
  const voiceCalls = yield* PersonalVoiceCallRepository.PersonalVoiceCallRepository;
  const projectionStore = yield* ProjectionStoreV2;
  return makePersonalTurnContext({
    personalBots,
    personalSessions,
    personalMemory,
    voiceCalls,
    projectionStore,
  });
});

export const layer = Layer.effect(PersonalTurnContext, make);
