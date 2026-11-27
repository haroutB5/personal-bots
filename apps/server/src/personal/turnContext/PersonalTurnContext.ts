/**
 * The personal half of a provider turn on the v2 engine.
 *
 * One module owns the turn-time personal behaviour: the bot's persona for a
 * session, the memory and voice-call context for a turn, the reply quote, and
 * a lead's open projects, the chat-name rules for titles. Provider code calls it instead of reaching
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
import * as SqlClient from "effect/sql/SqlClient";
import { PersonalBotId } from "@t3tools/contracts";
import type {
  ProviderAdapterV2EcoOutcome,
  ProviderAdapterV2PersonalSession,
} from "@t3tools/provider-core/server/ProviderAdapter";

import {
  ProjectionStoreV2,
  type ProjectionStoreV2Shape,
} from "../../orchestration-v2/ProjectionStore.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import { ecoTurnModels } from "../eco/ecoMode.ts";
import { makeEcoTurnRecorder } from "../eco/ecoTurnRecorder.ts";
import * as UsageService from "../../usage/UsageService.ts";
import { personalBotSystemInstructions } from "../personalBotInstructions.ts";
import { isPersonalTaskMessageId } from "../personalThreadTitles.ts";
import { uniqueAutomaticTitle } from "../personalChatTitles.ts";
import * as PersonalMemoryService from "../memory/PersonalMemoryService.ts";
import * as PersonalExternalMcpService from "../externalMcp/PersonalExternalMcpService.ts";
import * as PersonalProjectRepository from "../projects/PersonalProjectRepository.ts";
import { openProjectsContext } from "../projects/projectText.ts";
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
  /** Eco mode: read at each turn of a bot's session (see `ecoTurnModels`). */
  readonly ecoForTurn?: ProviderAdapterV2PersonalSession["ecoForTurn"];
}

export interface PersonalTurnContextShape {
  readonly sessionInstructions: (threadId: ThreadId) => Effect.Effect<Option.Option<string>>;
  readonly sessionPersonal: (threadId: ThreadId) => Effect.Effect<PersonalSession>;
  readonly isPersonalBotThread: (threadId: ThreadId) => Effect.Effect<boolean>;
  readonly externalMcpServersForThread?: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<{ readonly serverId: string; readonly slug: string }>>;
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
  readonly personalExternalMcp?: Option.Option<
    PersonalExternalMcpService.PersonalExternalMcpService["Service"]
  >;
  readonly voiceCalls: PersonalVoiceCallRepository.PersonalVoiceCallRepository["Service"];
  readonly projectionStore: Pick<ProjectionStoreV2Shape, "getThreadShell">;
  readonly projects?: Pick<
    PersonalProjectRepository.PersonalProjectRepository["Service"],
    "listOpenForLead"
  >;
  /** Stores an Eco turn's outcome; absent means Eco turns are not recorded. */
  readonly recordEcoTurn?: (
    botId: string | undefined,
    outcome: ProviderAdapterV2EcoOutcome,
  ) => Effect.Effect<void>;
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
      const personalBotId = botId === null ? undefined : String(botId);
      return {
        personalBot: linked || botId !== null,
        personalBotId,
        personalTaskChat: linked ? facts.value.taskChat || facts.value.routineChat : false,
        secretEnvironment,
        ...(personalBotId === undefined ? {} : { ecoForTurn: ecoForTurn(personalBotId) }),
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

  /** Eco mode v1: the bot is read at each turn, so a changed setting or a fallback applies at once. */
  const ecoForTurn =
    (botId: string): NonNullable<PersonalSession["ecoForTurn"]> =>
    (input) =>
      deps.personalBots.getBotById({ botId: PersonalBotId.make(botId) }).pipe(
        Effect.map((found) => {
          if (Option.isNone(found)) return undefined;
          const models = ecoTurnModels({
            bot: found.value,
            messageId: input.messageId,
            modelSelection: input.modelSelection,
          });
          if (models === undefined) return undefined;
          const record = deps.recordEcoTurn;
          return {
            ...models,
            record: (outcome: ProviderAdapterV2EcoOutcome) =>
              record === undefined ? Effect.void : record(botId, outcome),
          };
        }),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logDebug("eco lookup failed; running the turn without Eco", {
                botId,
                cause: Cause.pretty(cause).slice(0, 1_000),
              }).pipe(Effect.as(undefined)),
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

  const externalMcpServersForThread = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const externalMcp = deps.personalExternalMcp;
      if (externalMcp === undefined || Option.isNone(externalMcp)) return [];
      const link = yield* deps.personalBots.getThreadLink({ threadId });
      if (Option.isNone(link)) return [];
      const servers = yield* externalMcp.value.forBot(link.value.botId);
      return servers.map((server) => ({
        serverId: String(server.serverId),
        slug: server.slug,
      }));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logDebug("external MCP servers lookup failed; continuing without them", {
          threadId,
          cause: Cause.pretty(cause),
        }).pipe(
          Effect.as([] as ReadonlyArray<{ readonly serverId: string; readonly slug: string }>),
        ),
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

  const leadProjectsContext = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const projects = deps.projects;
      if (projects === undefined) return undefined;
      const facts = yield* deps.personalBots.getChatFacts({ threadId });
      if (Option.isNone(facts)) return undefined;
      const bot = yield* deps.personalBots.getBotById({ botId: facts.value.botId });
      if (Option.isNone(bot) || bot.value.lead !== true) return undefined;
      const open = yield* projects.listOpenForLead(facts.value.botId);
      return openProjectsContext(open, DateTime.toEpochMillis(yield* DateTime.now)) ?? undefined;
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logDebug("lead projects lookup failed; sending the turn without them", {
              threadId,
              cause: Cause.pretty(cause).slice(0, 1_000),
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
      const projectsContext = yield* leadProjectsContext(input.threadId);
      const contextParts = [callContext, projectsContext, memoryContext].filter(
        (part): part is string => part !== undefined && part.length > 0,
      );
      const extraContext = contextParts.length === 0 ? memoryContext : contextParts.join("\n\n");
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

  return {
    sessionInstructions,
    sessionPersonal,
    isPersonalBotThread,
    externalMcpServersForThread,
    uniqueTitle,
    prepareTurn,
  };
};

const make = Effect.gen(function* () {
  const personalBots = yield* PersonalBotRepository.PersonalBotRepository;
  const personalSessions = yield* Effect.serviceOption(PersonalSessionAccess.PersonalSessionAccess);
  const personalMemory = yield* Effect.serviceOption(PersonalMemoryService.PersonalMemoryService);
  const personalExternalMcp = yield* Effect.serviceOption(
    PersonalExternalMcpService.PersonalExternalMcpService,
  );
  const voiceCalls = yield* PersonalVoiceCallRepository.PersonalVoiceCallRepository;
  const projectionStore = yield* ProjectionStoreV2;
  const projects = yield* PersonalProjectRepository.PersonalProjectRepository;
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  const usage = yield* Effect.serviceOption(UsageService.UsageService);
  return makePersonalTurnContext({
    personalBots,
    personalSessions,
    personalMemory,
    personalExternalMcp,
    voiceCalls,
    projectionStore,
    projects,
    recordEcoTurn: makeEcoTurnRecorder({
      sql,
      priceUsage: Option.isSome(usage) ? usage.value.priceUsage : undefined,
      newId: () => crypto.randomUUID(),
    }),
  });
});

export const layer = Layer.effect(PersonalTurnContext, make);
