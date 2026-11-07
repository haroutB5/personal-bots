import {
  EnvironmentAuthorizationError,
  PersonalBotsError,
  WS_METHODS,
  WsPersonalRpcGroup,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import {
  archivePersonalChats,
  deletePersonalChats,
  updatePersonalChats,
} from "../bulkPersonalChats.ts";
import {
  deletePersonalFiles,
  deletePersonalLogins,
  deletePersonalMemories,
  deletePersonalRoutines,
  setPersonalRoutinesEnabled,
} from "../bulkPersonalItems.ts";
import { deletePersonalChat } from "../deletePersonalChat.ts";
import { deletePersonalGroup } from "../deletePersonalGroup.ts";
import * as PersonalBrowser from "../browser/PersonalBrowser.ts";
import * as PersonalDesktop from "../desktop/PersonalDesktop.ts";
import * as PersonalEngine from "../engine/PersonalEngine.ts";
import * as PersonalGroupService from "../groups/PersonalGroupService.ts";
import * as PersonalLeadBots from "../leadBots/PersonalLeadBotService.ts";
import * as PersonalMemoryService from "../memory/PersonalMemoryService.ts";
import * as PersonalMemoryTidy from "../memory/PersonalMemoryTidyService.ts";
import * as PersonalBotTokenUsage from "../PersonalBotTokenUsageService.ts";
import { signPersonalFiles } from "../PersonalFiles.ts";
import * as PersonalBotService from "../PersonalBotService.ts";
import * as PersonalProviderUpdates from "../providerUpdates/PersonalProviderUpdates.ts";
import * as PersonalPushService from "../push/PersonalPushService.ts";
import * as PersonalRoutineService from "../routines/PersonalRoutineService.ts";
import * as PersonalConnectionApprovalService from "../connections/approvalService.ts";
import * as PersonalConnectionService from "../connections/service.ts";
import * as PersonalLoginRequestService from "../secrets/PersonalLoginRequestService.ts";
import * as PersonalLoginService from "../secrets/PersonalLoginService.ts";
import * as PersonalSecretService from "../secrets/PersonalSecretService.ts";
import * as PersonalTaskService from "../tasks/PersonalTaskService.ts";
import * as PersonalVoiceCallService from "../voiceCalls/PersonalVoiceCallService.ts";
import * as PersonalVoiceSampleService from "../voiceCalls/PersonalVoiceSampleService.ts";
import { listBotThreadIds } from "../personalShellSlim.ts";
import { makeProviderCatalogAdapter } from "../providerCatalog/ProviderCatalogAdapter.ts";
import type { PersonalSessionPrewarmer } from "../sessionPrewarm.ts";
import { purgePersonalBot } from "../purgePersonalBot.ts";
import { readThreadFullText } from "../threadTextPreviews.ts";
import { personalWorkingProgress } from "../workingProgress.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";

export interface PersonalWsHandlerDeps {
  readonly currentSessionId: string;
  readonly observeRpcEffect: <A, E, R>(
    method: string,
    effect: Effect.Effect<A, E, R>,
    traceAttributes?: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<A, E | EnvironmentAuthorizationError, R>;
  readonly observeRpcStream: <A, E, R>(
    method: string,
    stream: Stream.Stream<A, E, R>,
    traceAttributes?: Readonly<Record<string, unknown>>,
  ) => Stream.Stream<A, E | EnvironmentAuthorizationError, R>;
  readonly sessionPrewarmer: PersonalSessionPrewarmer;
  readonly viewing: { connectionId: string; reported: boolean };
}

/**
 * The personal RPC handlers. The shared ws layer keeps one spread; every
 * personal service is yielded here so the handler block owns its dependencies.
 */
export const makePersonalWsHandlers = (deps: PersonalWsHandlerDeps) =>
  Effect.gen(function* () {
    const { currentSessionId, observeRpcEffect, observeRpcStream, sessionPrewarmer, viewing } =
      deps;
    const sql = yield* SqlClient.SqlClient;
    const personalEngine = yield* PersonalEngine.PersonalEngine;
    const personalBots = yield* PersonalBotService.PersonalBotService;
    const personalBotTokenUsage = yield* PersonalBotTokenUsage.PersonalBotTokenUsage;
    const personalTasks = yield* PersonalTaskService.PersonalTaskService;
    const personalGroups = yield* PersonalGroupService.PersonalGroupService;
    const personalSecrets = yield* PersonalSecretService.PersonalSecretService;
    const personalVoiceCalls = yield* PersonalVoiceCallService.PersonalVoiceCallService;
    const personalVoiceSamples = yield* PersonalVoiceSampleService.PersonalVoiceSampleService;
    const personalLogins = yield* PersonalLoginService.PersonalLoginService;
    const loginRequests = yield* PersonalLoginRequestService.PersonalLoginRequestService;
    const personalConnections = yield* PersonalConnectionService.PersonalConnectionService;
    const personalConnectionApprovals =
      yield* PersonalConnectionApprovalService.PersonalConnectionApprovalService;
    const personalLeadBots = yield* PersonalLeadBots.PersonalLeadBotService;
    const personalBrowser = yield* PersonalBrowser.PersonalBrowser;
    const personalDesktop = yield* PersonalDesktop.PersonalDesktop;
    const personalRoutines = yield* PersonalRoutineService.PersonalRoutineService;
    const personalMemory = yield* PersonalMemoryService.PersonalMemoryService;
    const personalMemoryTidy = yield* PersonalMemoryTidy.PersonalMemoryTidy;
    const personalPush = yield* PersonalPushService.PersonalPushService;
    const personalProviderUpdates = yield* PersonalProviderUpdates.PersonalProviderUpdates;
    const acpRegistry = yield* AcpRegistrySupport.AcpRegistryCatalog;
    const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const providerCatalog = makeProviderCatalogAdapter({
      searchRegistry: (input) => acpRegistry.search(input),
      prepareRegistryAgent: (input) => acpRegistry.prepare(input),
      getProviders: providerRegistry.getProviders,
      getSettings: serverSettings.getSettings,
      setProvider: (input) =>
        serverSettings.updateProviderInstance({
          operation: "upsert",
          instanceId: input.instanceId,
          instance: input.instance,
        }),
      refreshProvider: (instanceId) => providerRegistry.refreshInstance(instanceId),
      testRun: (input) => personalProviderUpdates.testRun(input),
    });
    return WsPersonalRpcGroup.of({
      [WS_METHODS.personalBotsList]: (input) =>
        observeRpcEffect(WS_METHODS.personalBotsList, personalBots.list(input), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalBotsThreadShells]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalBotsThreadShells,
          Effect.gen(function* () {
            const ids = yield* listBotThreadIds(input);
            if (ids.size === 0) return { threads: [] };
            const threads = yield* personalEngine.shellSnapshot({ unsettledOnly: false });
            return { threads: threads.filter((thread) => ids.has(thread.id)) };
          }).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.mapError(
              (cause) =>
                new PersonalBotsError({
                  message: "Could not load the bot's chats.",
                  cause,
                }),
            ),
          ),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.personalBotsThreadFullText]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalBotsThreadFullText,
          readThreadFullText(input).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.mapError(
              (cause) =>
                new PersonalBotsError({
                  message: "Could not load the full text.",
                  cause,
                }),
            ),
          ),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.personalBotsCreate]: (input) =>
        observeRpcEffect(WS_METHODS.personalBotsCreate, personalBots.create(input), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalBotsUpdate]: (input) =>
        observeRpcEffect(WS_METHODS.personalBotsUpdate, personalBots.update(input), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalBotsDelete]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalBotsDelete,
          purgePersonalBot(
            {
              bots: personalBots,
              tasks: personalTasks,
              groups: personalGroups,
              routines: personalRoutines,
              memory: personalMemory,
              secrets: personalSecrets,
              engine: personalEngine,
            },
            input.botId,
          ).pipe(Effect.as({})),
          {
            "rpc.aggregate": "server",
          },
        ),
      [WS_METHODS.personalBotsCreateThread]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalBotsCreateThread,
          // A title on this call is a name the owner typed.
          personalBots.createThread({
            botId: input.botId,
            threadId: input.threadId,
            ...(input.title === undefined ? {} : { title: input.title }),
            titleSource: "owner",
          }),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.personalBotsArchiveThread]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalBotsArchiveThread,
          personalBots.archiveThread(input).pipe(
            // An archived chat cannot use the browser any more: its tabs,
            // its help card and its place in line go with it (QA's B6).
            Effect.tap(() =>
              input.archived ? personalBrowser.releaseThread(input.threadId) : Effect.void,
            ),
          ),
          {
            "rpc.aggregate": "server",
          },
        ),
      // Fire and forget: the session starts on the server, outliving this
      // request, so a dropped socket never leaves a half-started session.
      [WS_METHODS.personalBotsPrewarmThread]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalBotsPrewarmThread,
          sessionPrewarmer.prewarm(input.threadId).pipe(
            Effect.timed,
            Effect.flatMap(([duration, outcome]) =>
              outcome === "debounced" || outcome === "disabled"
                ? Effect.void
                : Effect.logInfo("personal session prewarm", {
                    threadId: input.threadId,
                    outcome,
                    durationMs: Duration.toMillis(duration),
                  }),
            ),
            Effect.forkDetach,
            Effect.as({}),
          ),
          {
            "rpc.aggregate": "server",
          },
        ),
      [WS_METHODS.personalBotsDeleteThread]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalBotsDeleteThread,
          deletePersonalChat(
            { bots: personalBots, tasks: personalTasks, groups: personalGroups },
            input.threadId,
          ).pipe(Effect.as({})),
          {
            "rpc.aggregate": "server",
          },
        ),
      [WS_METHODS.personalBotsArchiveThreads]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalBotsArchiveThreads,
          archivePersonalChats(personalBots, input.threadIds, input.archived).pipe(
            // Same as one chat: every archived chat gives up the browser.
            Effect.tap((result) =>
              input.archived
                ? Effect.forEach(
                    result.done,
                    (threadId) => personalBrowser.releaseThread(threadId),
                    {
                      discard: true,
                    },
                  )
                : Effect.void,
            ),
          ),
          {
            "rpc.aggregate": "server",
          },
        ),
      [WS_METHODS.personalBotsUpdateThreads]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalBotsUpdateThreads,
          updatePersonalChats(personalBots, input),
          {
            "rpc.aggregate": "server",
          },
        ),
      [WS_METHODS.personalBotsSearchMessages]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalBotsSearchMessages,
          personalBots.searchMessages(input),
          {
            "rpc.aggregate": "server",
          },
        ),
      [WS_METHODS.personalBotsWorkingProgress]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalBotsWorkingProgress,
          personalWorkingProgress(personalEngine, input.threadIds).pipe(
            Effect.map((notes) => ({ notes })),
            Effect.mapError(
              (cause) =>
                new PersonalBotsError({
                  message: "Could not read the working chats' progress.",
                  cause,
                }),
            ),
          ),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.personalBotsTokenUsage]: (input) =>
        observeRpcEffect(WS_METHODS.personalBotsTokenUsage, personalBotTokenUsage.read(input), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalBotsDeleteThreads]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalBotsDeleteThreads,
          deletePersonalChats(
            { bots: personalBots, tasks: personalTasks, groups: personalGroups },
            input.threadIds,
          ),
          {
            "rpc.aggregate": "server",
          },
        ),
      [WS_METHODS.personalBotsGetProfile]: (_input) =>
        observeRpcEffect(WS_METHODS.personalBotsGetProfile, personalBots.getProfile(), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalBotsSetProfile]: (input) =>
        observeRpcEffect(WS_METHODS.personalBotsSetProfile, personalBots.setProfile(input), {
          "rpc.aggregate": "server",
        }),
      // Owner-only: the app's own session, never an MCP credential. Restore brings a bot a
      // team lead removed back with its settings, chats and memory.
      [WS_METHODS.personalBotsListRemoved]: (_input) =>
        observeRpcEffect(WS_METHODS.personalBotsListRemoved, personalLeadBots.listRemoved(), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalBotsRestore]: (input) =>
        observeRpcEffect(WS_METHODS.personalBotsRestore, personalLeadBots.restore(input), {
          "rpc.aggregate": "server",
        }),
      // Voice calls with a bot. Owner-only: the mint spends the saved Gemini
      // key, and `send` posts into a chat as the owner himself.
      [WS_METHODS.personalVoiceCallsStart]: (input) =>
        observeRpcEffect(WS_METHODS.personalVoiceCallsStart, personalVoiceCalls.start(input), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalVoiceCallsCheckKey]: (_input) =>
        observeRpcEffect(WS_METHODS.personalVoiceCallsCheckKey, personalVoiceCalls.checkKey(), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalVoiceCallsSend]: (input) =>
        observeRpcEffect(WS_METHODS.personalVoiceCallsSend, personalVoiceCalls.send(input), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalVoiceCallsFinish]: (input) =>
        observeRpcEffect(WS_METHODS.personalVoiceCallsFinish, personalVoiceCalls.finish(input), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalVoiceCallsList]: (input) =>
        observeRpcEffect(WS_METHODS.personalVoiceCallsList, personalVoiceCalls.list(input), {
          "rpc.aggregate": "server",
        }),
      // The voice's own fast facts: the same memory search the bot's
      // search_memory tool runs, so nothing new reaches Google.
      [WS_METHODS.personalVoiceCallsLookupMemory]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalVoiceCallsLookupMemory,
          personalVoiceCalls.lookupMemory(input),
          { "rpc.aggregate": "server" },
        ),
      // A fresh pass without Google Search when Search is out of quota, and
      // the voice's own keyless web search that stands in for it.
      [WS_METHODS.personalVoiceCallsRenewPass]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalVoiceCallsRenewPass,
          personalVoiceCalls.renewPass(input),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.personalVoiceCallsSearchWeb]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalVoiceCallsSearchWeb,
          personalVoiceCalls.searchWeb(input),
          { "rpc.aggregate": "server" },
        ),
      // The call's own chat state, keyed by the call's thread, and one card's
      // transcript on demand. Read-only, so a phone that navigated away
      // mid-call still gets the truth about the call's chat.
      [WS_METHODS.personalVoiceCallsSnapshot]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalVoiceCallsSnapshot,
          personalVoiceCalls.snapshot(input),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.personalVoiceCallsTranscript]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalVoiceCallsTranscript,
          personalVoiceCalls.transcript(input),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.personalVoiceCallsSample]: (input) =>
        observeRpcEffect(WS_METHODS.personalVoiceCallsSample, personalVoiceSamples.sample(input), {
          "rpc.aggregate": "server",
        }),
      // A team lead's request to remove or rewrite a bot it did not create. `decide` is the
      // tap on the card and the only way to approve one.
      [WS_METHODS.personalLeadBotChangesList]: (_input) =>
        observeRpcEffect(WS_METHODS.personalLeadBotChangesList, personalLeadBots.listChanges(), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalLeadBotChangesDecide]: (input) =>
        observeRpcEffect(WS_METHODS.personalLeadBotChangesDecide, personalLeadBots.decide(input), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalBotsRecheckProvider]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalBotsRecheckProvider,
          personalProviderUpdates.recheck(input).pipe(Effect.as({})),
          {
            "rpc.aggregate": "server",
          },
        ),
      [WS_METHODS.providerCatalogList]: (input) =>
        observeRpcEffect(WS_METHODS.providerCatalogList, providerCatalog.list(input), {
          "rpc.aggregate": "provider",
        }),
      [WS_METHODS.providerCatalogInstallFacts]: (input) =>
        observeRpcEffect(
          WS_METHODS.providerCatalogInstallFacts,
          providerCatalog.installFacts(input),
          { "rpc.aggregate": "provider" },
        ),
      [WS_METHODS.providerCatalogAdd]: (input) =>
        observeRpcEffect(WS_METHODS.providerCatalogAdd, providerCatalog.add(input), {
          "rpc.aggregate": "provider",
        }),
      [WS_METHODS.providerTestRun]: (input) =>
        observeRpcEffect(WS_METHODS.providerTestRun, providerCatalog.testRun(input), {
          "rpc.aggregate": "provider",
        }),
      [WS_METHODS.serverGetSettings]: (_input) =>
        observeRpcEffect(WS_METHODS.serverGetSettings, providerCatalog.getSettings, {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalBotsListFiles]: (_input) =>
        observeRpcEffect(
          WS_METHODS.personalBotsListFiles,
          personalBots.listFiles().pipe(Effect.flatMap(signPersonalFiles)),
          {
            "rpc.aggregate": "server",
          },
        ),
      [WS_METHODS.personalFilesDelete]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalFilesDelete,
          personalBots.deleteFile(input).pipe(Effect.as({})),
          {
            "rpc.aggregate": "server",
          },
        ),
      [WS_METHODS.personalFilesDeleteMany]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalFilesDeleteMany,
          deletePersonalFiles(personalBots, input.fileIds),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.personalTasksList]: (input) =>
        observeRpcEffect(WS_METHODS.personalTasksList, personalTasks.list(input), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalTasksGet]: (input) =>
        observeRpcEffect(WS_METHODS.personalTasksGet, personalTasks.get(input), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalTasksCreate]: (input) =>
        observeRpcEffect(WS_METHODS.personalTasksCreate, personalTasks.createTask(input), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalTasksCancel]: (input) =>
        observeRpcEffect(WS_METHODS.personalTasksCancel, personalTasks.cancel(input), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalTasksRetry]: (input) =>
        observeRpcEffect(WS_METHODS.personalTasksRetry, personalTasks.retry(input), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalTasksHistory]: (input) =>
        observeRpcEffect(WS_METHODS.personalTasksHistory, personalTasks.history(input), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalTasksRelated]: (input) =>
        observeRpcEffect(WS_METHODS.personalTasksRelated, personalTasks.related(input), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalTasksSubscribe]: (_input) =>
        observeRpcStream(WS_METHODS.personalTasksSubscribe, personalTasks.subscribe, {
          "rpc.aggregate": "server",
        }),
      // Group chats. `subscribe` carries STATE ONLY: the transcript arrives
      // on the group thread's ordinary thread-detail subscription, so the
      // phone holds one subscription for a group conversation, not two.
      [WS_METHODS.personalGroupsList]: (_input) =>
        observeRpcEffect(WS_METHODS.personalGroupsList, personalGroups.list(), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalGroupsCreate]: (input) =>
        observeRpcEffect(WS_METHODS.personalGroupsCreate, personalGroups.create(input), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalGroupsUpdate]: (input) =>
        observeRpcEffect(WS_METHODS.personalGroupsUpdate, personalGroups.update(input), {
          "rpc.aggregate": "server",
        }),
      // Deleting a group can take the member bots the owner ticked with it.
      // The composition lives in `deletePersonalGroup` (validate, stop the
      // round, purge, then delete) so it is testable without a socket.
      [WS_METHODS.personalGroupsDelete]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalGroupsDelete,
          deletePersonalGroup(
            {
              bots: personalBots,
              tasks: personalTasks,
              groups: personalGroups,
              routines: personalRoutines,
              memory: personalMemory,
              secrets: personalSecrets,
              engine: personalEngine,
            },
            input,
          ).pipe(Effect.as({})),
          {
            "rpc.aggregate": "server",
          },
        ),
      [WS_METHODS.personalGroupsAddMember]: (input) =>
        observeRpcEffect(WS_METHODS.personalGroupsAddMember, personalGroups.addMember(input), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalGroupsRemoveMember]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalGroupsRemoveMember,
          personalGroups.removeMember(input),
          {
            "rpc.aggregate": "server",
          },
        ),
      [WS_METHODS.personalGroupsSendMessage]: (input) =>
        observeRpcEffect(WS_METHODS.personalGroupsSendMessage, personalGroups.sendMessage(input), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalGroupsContinueRound]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalGroupsContinueRound,
          personalGroups.continueRound(input),
          {
            "rpc.aggregate": "server",
          },
        ),
      [WS_METHODS.personalGroupsStop]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalGroupsStop,
          personalGroups.stop(input).pipe(Effect.as({})),
          {
            "rpc.aggregate": "server",
          },
        ),
      [WS_METHODS.personalGroupsSubscribe]: (_input) =>
        observeRpcStream(WS_METHODS.personalGroupsSubscribe, personalGroups.subscribe, {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalSecretsListPending]: (_input) =>
        observeRpcEffect(WS_METHODS.personalSecretsListPending, personalSecrets.listPending(), {
          "rpc.aggregate": "server",
        }),
      // The payload value is Redacted once decoded and is written only to
      // the secret store; the response is the request row, never the value.
      [WS_METHODS.personalSecretsFulfill]: (input) =>
        observeRpcEffect(WS_METHODS.personalSecretsFulfill, personalSecrets.fulfill(input), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalSecretsCancel]: (input) =>
        observeRpcEffect(WS_METHODS.personalSecretsCancel, personalSecrets.cancel(input), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalSecretsList]: (_input) =>
        observeRpcEffect(WS_METHODS.personalSecretsList, personalSecrets.list(), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalSecretsSetSharing]: (input) =>
        observeRpcEffect(WS_METHODS.personalSecretsSetSharing, personalSecrets.setSharing(input), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalSecretsSetMode]: (input) =>
        observeRpcEffect(WS_METHODS.personalSecretsSetMode, personalSecrets.setMode(input), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalSecretsCreate]: (input) =>
        observeRpcEffect(WS_METHODS.personalSecretsCreate, personalSecrets.create(input), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalSecretsDelete]: (input) =>
        observeRpcEffect(WS_METHODS.personalSecretsDelete, personalSecrets.remove(input), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalConnectionsList]: (_input) =>
        observeRpcEffect(WS_METHODS.personalConnectionsList, personalConnections.list(), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalConnectionsConnect]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalConnectionsConnect,
          personalConnections.connect(input),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.personalConnectionsValidate]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalConnectionsValidate,
          personalConnections.validate(input),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.personalConnectionsDisable]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalConnectionsDisable,
          personalConnections.disable(input),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.personalConnectionsReconnect]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalConnectionsReconnect,
          personalConnections.reconnect(input),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.personalConnectionsDisconnect]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalConnectionsDisconnect,
          personalConnections.disconnect(input),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.personalConnectionsRotate]: (input) =>
        observeRpcEffect(WS_METHODS.personalConnectionsRotate, personalConnections.rotate(input), {
          "rpc.aggregate": "server",
        }),
      // Control is bound to this connection's auth session, like the
      // browser's own take-control RPC: the owner scans the code on the
      // device they are holding.
      [WS_METHODS.personalConnectionsBrowserConnect]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalConnectionsBrowserConnect,
          personalConnections.browserConnect(input, currentSessionId),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.personalConnectionsSetSettings]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalConnectionsSetSettings,
          personalConnections.setSettings(input),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.personalConnectionsImportProbe]: (_input) =>
        observeRpcEffect(
          WS_METHODS.personalConnectionsImportProbe,
          personalConnections.importProbe(),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.personalConnectionsImportAdopt]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalConnectionsImportAdopt,
          personalConnections.importAdopt(input),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.personalConnectionApprovalsList]: (_input) =>
        observeRpcEffect(
          WS_METHODS.personalConnectionApprovalsList,
          personalConnectionApprovals.listPending(),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.personalConnectionApprovalsDecide]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalConnectionApprovalsDecide,
          personalConnectionApprovals.decide(input),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.personalConnectionApprovalsCancel]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalConnectionApprovalsCancel,
          personalConnectionApprovals.cancel(input),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.personalLoginsList]: (_input) =>
        observeRpcEffect(WS_METHODS.personalLoginsList, personalLogins.list(), {
          "rpc.aggregate": "server",
        }),
      // Password is Redacted by RPC decoding and every response omits it.
      [WS_METHODS.personalLoginRequestsList]: (input) =>
        observeRpcEffect(WS_METHODS.personalLoginRequestsList, loginRequests.list(input), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalLoginRequestsSubmit]: (input) =>
        observeRpcEffect(WS_METHODS.personalLoginRequestsSubmit, loginRequests.submit(input), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalLoginRequestsCancel]: (input) =>
        observeRpcEffect(WS_METHODS.personalLoginRequestsCancel, loginRequests.cancel(input), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalLoginsCreate]: (input) =>
        observeRpcEffect(WS_METHODS.personalLoginsCreate, personalLogins.create(input), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalLoginsUpdate]: (input) =>
        observeRpcEffect(WS_METHODS.personalLoginsUpdate, personalLogins.update(input), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalLoginsDelete]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalLoginsDelete,
          personalLogins.remove(input).pipe(Effect.as({})),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.personalLoginsDeleteMany]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalLoginsDeleteMany,
          deletePersonalLogins(personalLogins, input.loginIds),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.personalLoginsSetSensitive]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalLoginsSetSensitive,
          personalLogins.setSensitive(input),
          { "rpc.aggregate": "server" },
        ),
      // personal browser (control is bound to this connection's auth session)
      [WS_METHODS.personalBrowserStatus]: (_input) =>
        observeRpcEffect(
          WS_METHODS.personalBrowserStatus,
          personalBrowser.status(currentSessionId),
          { "rpc.aggregate": "personal-browser" },
        ),
      [WS_METHODS.personalBrowserTakeControl]: (_input) =>
        observeRpcEffect(
          WS_METHODS.personalBrowserTakeControl,
          personalBrowser.takeControl(currentSessionId),
          { "rpc.aggregate": "personal-browser" },
        ),
      [WS_METHODS.personalBrowserReturnToAgent]: (_input) =>
        observeRpcEffect(
          WS_METHODS.personalBrowserReturnToAgent,
          personalBrowser.returnToAgent(currentSessionId),
          { "rpc.aggregate": "personal-browser" },
        ),
      // The user closing the browser from a client: no thread to attribute it
      // to, so the activity line reads "Browser closed by you".
      [WS_METHODS.personalBrowserClose]: (_input) =>
        observeRpcEffect(
          WS_METHODS.personalBrowserClose,
          // The user's own close is never refused by the browser's own
          // human-control check; a failure can only be a teardown error, and
          // the current status is the useful answer either way.
          personalBrowser
            .closeBrowser({ sessionId: currentSessionId, byThreadId: null })
            .pipe(Effect.catch(() => personalBrowser.status(currentSessionId))),
          { "rpc.aggregate": "personal-browser" },
        ),
      [WS_METHODS.personalBrowserListFiles]: (_input) =>
        observeRpcEffect(WS_METHODS.personalBrowserListFiles, personalBrowser.listFiles, {
          "rpc.aggregate": "personal-browser",
        }),
      [WS_METHODS.personalBrowserActivity]: (_input) =>
        observeRpcStream(
          WS_METHODS.personalBrowserActivity,
          personalBrowser.activity(currentSessionId),
          { "rpc.aggregate": "personal-browser" },
        ),
      // Owner decisions on one paused sensitive-site step. The paused thread
      // comes from the card; the acting session is this connection's.
      [WS_METHODS.personalBrowserApproveEgress]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalBrowserApproveEgress,
          personalBrowser.approveEgress({
            threadId: input.threadId,
            sessionId: currentSessionId,
          }),
          { "rpc.aggregate": "personal-browser" },
        ),
      [WS_METHODS.personalBrowserRefuseEgress]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalBrowserRefuseEgress,
          personalBrowser.refuseEgress({
            threadId: input.threadId,
            sessionId: currentSessionId,
          }),
          { "rpc.aggregate": "personal-browser" },
        ),
      // The user's real PC: who holds it, who waits, and the app's Stop.
      [WS_METHODS.personalDesktopStatus]: (_input) =>
        observeRpcStream(
          WS_METHODS.personalDesktopStatus,
          Stream.concat(Stream.fromEffect(personalDesktop.status), personalDesktop.changes),
          { "rpc.aggregate": "personal-desktop" },
        ),
      [WS_METHODS.personalDesktopStop]: (_input) =>
        observeRpcEffect(WS_METHODS.personalDesktopStop, personalDesktop.stop("app"), {
          "rpc.aggregate": "personal-desktop",
        }),
      [WS_METHODS.personalDesktopActivity]: (_input) =>
        observeRpcStream(WS_METHODS.personalDesktopActivity, personalDesktop.activity, {
          "rpc.aggregate": "personal-desktop",
        }),
      [WS_METHODS.personalRoutinesList]: (_input) =>
        observeRpcEffect(WS_METHODS.personalRoutinesList, personalRoutines.list(), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalRoutinesCreate]: (input) =>
        observeRpcEffect(WS_METHODS.personalRoutinesCreate, personalRoutines.create(input), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalRoutinesUpdate]: (input) =>
        observeRpcEffect(WS_METHODS.personalRoutinesUpdate, personalRoutines.update(input), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalRoutinesDelete]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalRoutinesDelete,
          personalRoutines.remove(input).pipe(Effect.as({})),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.personalRoutinesPause]: (input) =>
        observeRpcEffect(WS_METHODS.personalRoutinesPause, personalRoutines.pause(input), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalRoutinesResume]: (input) =>
        observeRpcEffect(WS_METHODS.personalRoutinesResume, personalRoutines.resume(input), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalRoutinesDeleteMany]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalRoutinesDeleteMany,
          deletePersonalRoutines(personalRoutines, input.routineIds),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.personalRoutinesSetEnabledMany]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalRoutinesSetEnabledMany,
          setPersonalRoutinesEnabled(personalRoutines, input.routineIds, input.enabled),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.personalRoutinesRunNow]: (input) =>
        observeRpcEffect(WS_METHODS.personalRoutinesRunNow, personalRoutines.runNow(input), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalRoutinesRegenerateHook]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalRoutinesRegenerateHook,
          personalRoutines.regenerateHook(input),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.personalMemoryList]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalMemoryList,
          personalMemory
            .listPage(input)
            .pipe(Effect.map((page) => ({ entries: [...page.entries], total: page.total }))),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.personalMemorySearch]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalMemorySearch,
          personalMemory.search(input).pipe(Effect.map((entries) => ({ entries: [...entries] }))),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.personalMemoryUpdate]: (input) =>
        observeRpcEffect(WS_METHODS.personalMemoryUpdate, personalMemory.update(input), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalMemoryDelete]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalMemoryDelete,
          personalMemory.remove(input).pipe(Effect.as({})),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.personalMemoryDeleteMany]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalMemoryDeleteMany,
          deletePersonalMemories(personalMemory, input.memoryIds),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.personalMemoryRestore]: (input) =>
        observeRpcEffect(WS_METHODS.personalMemoryRestore, personalMemory.restore(input), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalMemoryGet]: (input) =>
        observeRpcEffect(WS_METHODS.personalMemoryGet, personalMemory.get(input.memoryId), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalMemoryUndoNote]: (input) =>
        observeRpcEffect(WS_METHODS.personalMemoryUndoNote, personalMemory.undoNote(input), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalMemoryTurnContext]: (input) =>
        observeRpcEffect(WS_METHODS.personalMemoryTurnContext, personalMemory.turnContext(input), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalMemoryFeedback]: (input) =>
        observeRpcEffect(WS_METHODS.personalMemoryFeedback, personalMemory.setFeedback(input), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalMemoryRulesUsage]: () =>
        observeRpcEffect(WS_METHODS.personalMemoryRulesUsage, personalMemory.rulesUsage(), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalMemoryTidyLog]: (input) =>
        observeRpcEffect(WS_METHODS.personalMemoryTidyLog, personalMemoryTidy.log(input), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalMemoryTidySetMode]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalMemoryTidySetMode,
          personalMemoryTidy.setMode(input.mode),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.personalMemoryCards]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalMemoryCards,
          personalMemoryTidy.cardsForThread(input.threadId),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.personalMemoryTidyDecide]: (input) =>
        observeRpcEffect(WS_METHODS.personalMemoryTidyDecide, personalMemoryTidy.decide(input), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalMemoryTidyUndo]: (input) =>
        observeRpcEffect(WS_METHODS.personalMemoryTidyUndo, personalMemoryTidy.undo(input), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalMemoryTidyRun]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalMemoryTidyRun,
          personalMemoryTidy.run({ dryRun: input.dryRun ?? true }),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.personalPushPublicKey]: (_input) =>
        observeRpcEffect(
          WS_METHODS.personalPushPublicKey,
          personalPush.publicKey().pipe(Effect.map((publicKey) => ({ publicKey }))),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.personalPushGetSettings]: (_input) =>
        observeRpcEffect(WS_METHODS.personalPushGetSettings, personalPush.getSettings(), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalPushSubscribe]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalPushSubscribe,
          personalPush.subscribe(input).pipe(Effect.map((subscriptionId) => ({ subscriptionId }))),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.personalPushUnsubscribe]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalPushUnsubscribe,
          personalPush.unsubscribe(input).pipe(Effect.as({})),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.personalPushTest]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalPushTest,
          personalPush.test(input).pipe(Effect.map((queued) => ({ queued }))),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.personalPushSetPreferences]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalPushSetPreferences,
          personalPush.setPreferences(input),
          {
            "rpc.aggregate": "server",
          },
        ),
      [WS_METHODS.personalPushReportViewing]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalPushReportViewing,
          Effect.suspend(() => {
            viewing.reported = true;
            return personalPush.reportViewing({
              connectionId: viewing.connectionId,
              threadId: input.threadId,
            });
          }).pipe(Effect.as({})),
          { "rpc.aggregate": "server" },
        ),
      // Foreground presence + in-app notifications: while this connection
      // is in front and listening, notifications arrive here as banners
      // instead of web push (iOS gives a foreground home-screen app no
      // usable notification tap). Unacknowledged ones fall back to push.
      [WS_METHODS.personalPushReportForeground]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalPushReportForeground,
          Effect.suspend(() => {
            viewing.reported = true;
            return personalPush.reportForeground({
              connectionId: viewing.connectionId,
              foreground: input.foreground,
            });
          }).pipe(Effect.as({})),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.personalPushInApp]: (_input) =>
        observeRpcStream(WS_METHODS.personalPushInApp, personalPush.inApp(viewing.connectionId), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.personalPushAckInApp]: (input) =>
        observeRpcEffect(
          WS_METHODS.personalPushAckInApp,
          personalPush.ackInApp({ id: input.id }).pipe(Effect.as({})),
          { "rpc.aggregate": "server" },
        ),
    });
  });
