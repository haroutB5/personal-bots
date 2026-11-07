import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { forkParked } from "../serverActivation.ts";
import { layer as PersonalPrewarmSessionLayer } from "./engine/PersonalPrewarmSession.ts";
import { layer as PersonalProviderSessionsLayer } from "./engine/PersonalProviderSessions.ts";
import { PersonalProvidersV2Live } from "./engine/PersonalProvidersV2Live.ts";
import * as PersonalBotRepository from "./PersonalBotRepository.ts";
import * as PersonalBotService from "./PersonalBotService.ts";
import * as PersonalBotShellStream from "./PersonalBotShellStream.ts";
import * as PersonalBotTokenUsage from "./PersonalBotTokenUsageService.ts";
import * as PersonalChatResume from "./PersonalChatResumeService.ts";
import * as PersonalClaudeCodeReview from "./claudeCodeReview/PersonalClaudeCodeReview.ts";
import * as PersonalConnectionApprovalService from "./connections/approvalService.ts";
import * as PersonalConnectionService from "./connections/service.ts";
import * as WhatsAppSendLog from "./connections/whatsapp/sendLog.ts";
import * as WhatsAppSession from "./connections/whatsapp/session.ts";
import * as PersonalDesktop from "./desktop/PersonalDesktop.ts";
import * as PersonalBrowser from "./browser/PersonalBrowser.ts";
import * as PersonalBrowserLease from "./browser/BrowserLease.ts";
import * as PersonalBrowserLeaseRepository from "./browser/PersonalBrowserLeaseRepository.ts";
import * as PersonalBrowserProtectionRepository from "./browser/PersonalBrowserProtectionRepository.ts";
import * as PersonalLeadBots from "./leadBots/PersonalLeadBotService.ts";
import * as PersonalMemoryService from "./memory/PersonalMemoryService.ts";
import * as PersonalMemoryTidy from "./memory/PersonalMemoryTidyService.ts";
import * as PersonalModelFallback from "./PersonalModelFallbackService.ts";
import * as PersonalProviderUpdates from "./providerUpdates/PersonalProviderUpdates.ts";
import * as PersonalPushService from "./push/PersonalPushService.ts";
import * as PersonalReleaseNotices from "./releaseNotices/PersonalReleaseNoticeService.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as PersonalRoutineService from "./routines/PersonalRoutineService.ts";
import { logPersonalSchedulersAtBoot } from "./schedulersSwitch.ts";
import * as PersonalLoginRepository from "./secrets/PersonalLoginRepository.ts";
import * as PersonalLoginRequestService from "./secrets/PersonalLoginRequestService.ts";
import * as PersonalLoginService from "./secrets/PersonalLoginService.ts";
import * as PersonalSecretService from "./secrets/PersonalSecretService.ts";
import * as PersonalTaskChatArchive from "./PersonalTaskChatArchiveService.ts";
import * as PersonalTaskTitleBackfill from "./taskTitleBackfill.ts";
import * as PersonalThreadLinkRepair from "./personalThreadLinkRepair.ts";
import * as PersonalTurnRetry from "./PersonalTurnRetryService.ts";
import * as PersonalTaskService from "./tasks/PersonalTaskService.ts";
import * as PersonalGroupService from "./groups/PersonalGroupService.ts";
import * as PersonalVoiceCallService from "./voiceCalls/PersonalVoiceCallService.ts";
import * as PersonalVoiceCallSummaryService from "./voiceCalls/PersonalVoiceCallSummaryService.ts";
import * as PersonalVoiceSampleService from "./voiceCalls/PersonalVoiceSampleService.ts";
const PersonalBotsSeedLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const personalBots = yield* PersonalBotService.PersonalBotService;
    const seeded = yield* personalBots.seedDefaultsIfNeeded;
    if (seeded.length > 0) {
      yield* Effect.logInfo("Personal bots seeded default bots.", { count: seeded.length });
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Personal bots startup seeding failed; list calls retry lazily.", {
        cause,
      }),
    ),
  ),
);

// Starts the personal task dispatcher. The domain-event subscription is taken
// now, while its consumer and the lease/backoff sweep park on ServerActivation
// (provided above this layer), so no turn starts before the provider reactors.
const PersonalTasksDispatcherLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const personalTasks = yield* PersonalTaskService.PersonalTaskService;
    // One WARN at boot when T3CODE_PERSONAL_SCHEDULERS=off (restored test copies only).
    yield* logPersonalSchedulersAtBoot();
    yield* personalTasks.start();
  }),
);

// The group round loop. Same shape as the task dispatcher and the same
// reason for the shape: the domain-event subscription is taken now so no
// relay is missed, while its consumer and the 30s sweep park on
// ServerActivation so no member turn starts before the provider reactors.
const PersonalGroupsDispatcherLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const personalGroups = yield* PersonalGroupService.PersonalGroupService;
    yield* personalGroups.start();
  }),
);

// Routine catch-up (startup + every 30s), task-summary memory and the push
// sender. All park on ServerActivation like the task dispatcher.
const PersonalReactorsLive = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* (yield* PersonalRoutineService.PersonalRoutineService).start();
    yield* (yield* PersonalMemoryService.PersonalMemoryService).start();
    yield* (yield* PersonalMemoryTidy.PersonalMemoryTidy).start();
    yield* (yield* PersonalPushService.PersonalPushService).start();
    yield* (yield* PersonalProviderUpdates.PersonalProviderUpdates).start();
    // Sets up the Updates bot and its nightly 04:00 update run (the routine service runs it).
    yield* (yield* PersonalClaudeCodeReview.PersonalClaudeCodeReview).start();
    // Re-runs a bot reply that died on a transient provider fault. Subscribes
    // here so it never misses the turn-start it has to track.
    yield* (yield* PersonalTurnRetry.PersonalTurnRetry).start();
    // Continues a bot chat stopped by a usage limit once it resets.
    yield* (yield* PersonalChatResume.PersonalChatResume).start();
    // Moves a bot that hit its provider's usage limit to its fallback model, and
    // back once the limit has reset and the bot is idle (PERSONAL_MODEL_FALLBACK=off disables).
    yield* (yield* PersonalModelFallback.PersonalModelFallback).start();
    // Cancels lead-bot confirm cards nobody answered in 15 minutes and tells their lead.
    yield* (yield* PersonalLeadBots.PersonalLeadBotService).start();
    // Archives finished delegated-task chats after 48 idle hours (startup + every 5 min).
    yield* (yield* PersonalTaskChatArchive.PersonalTaskChatArchive).start();
    // Posts the release waiter's "landed / rolled back" notice into the chat
    // that asked for the release (startup + every 5s; notify-release.ps1).
    yield* (yield* PersonalReleaseNotices.PersonalReleaseNotices).start();
    // Writes the one-line summary onto finished call cards: the boot sweep
    // doubles as the backfill, then it looks every 30 s (Harout, 16 Oct).
    yield* (yield* PersonalVoiceCallSummaryService.PersonalVoiceCallSummaryService).start();
    // One-off: names old task/routine chats still on "New chat" after their
    // task, once the server is up. Marker in personal_meta; never blocks start.
    yield* forkParked(PersonalTaskTitleBackfill.runTaskTitleBackfillSafely);
    // A chat creation interrupted between its thread and its bot link (a worker
    // statement is an interruption point) leaves an intent row behind; link it
    // now instead of leaving a chat no bot lists (QA 1.66.70).
    yield* forkParked(PersonalThreadLinkRepair.repairPersonalThreadLinksSafely);
  }),
);

// Every personal service, consumers first (each step feeds requirements
// opened by earlier steps). SqlClient, orchestration and providers come from
// the runtime layers the whole group is merged above.
const PersonalLayerLive = PersonalReactorsLive.pipe(
  // Consumes the push service below and the provider/orchestration runtime.
  Layer.provideMerge(PersonalProviderUpdates.layer),
  // Consumes the routine service and the bot service/repository below.
  Layer.provideMerge(PersonalClaudeCodeReview.layer),
  Layer.provideMerge(PersonalTurnRetry.layer),
  Layer.provideMerge(PersonalChatResume.layer),
  Layer.provideMerge(PersonalTaskChatArchive.layer),
  // Per-bot token totals for the Team screen; reads the usage scan and the chat tables.
  Layer.provideMerge(PersonalBotTokenUsage.layer),
  Layer.provideMerge(PersonalReleaseNotices.layer),
  // Team leads create, edit and remove bots on their own team; consumes the
  // bot, task and routine services below and the push service just below.
  Layer.provideMerge(PersonalLeadBots.layer),
  Layer.provideMerge(
    PersonalPushService.layer.pipe(
      Layer.provide(PersonalPushService.transportLive),
      Layer.provide(ServerSecretStore.layer),
    ),
  ),
  Layer.provideMerge(PersonalMemoryService.layer),
  Layer.provideMerge(PersonalMemoryTidy.layer.pipe(Layer.provide(PersonalMemoryTidy.judgeLayer))),
  Layer.provideMerge(PersonalRoutineService.layer),
  Layer.provideMerge(PersonalTasksDispatcherLive),
  Layer.provideMerge(PersonalTaskService.layerLive),
  // The task service and the chat resume ask it what to do about a usage limit.
  Layer.provideMerge(PersonalModelFallback.layer),
  // Groups consume the bot service and repository below them, exactly as the
  // task service does, so they sit above both and below the seed.
  Layer.provideMerge(PersonalGroupsDispatcherLive),
  Layer.provideMerge(PersonalGroupService.layerLive),
  // The phone's live shell stream consumes the bot service and its engine.
  Layer.provideMerge(Layer.mergeAll(PersonalBotShellStream.layer, PersonalBotsSeedLive)),
  Layer.provideMerge(PersonalBotService.layer),
  Layer.provideMerge(PersonalBotRepository.layer),
);

// The personal group with the voice-call workers provided to it, as ONE step:
// the reactors in the group start the summary worker at boot (Harout, 16 Oct),
// and the chain below is at its 20-step limit. The sample service rides along:
// it is reached only from Settings, but it is built from the same broker path.
const PersonalLayerWithCallSummaryLive = PersonalLayerLive.pipe(
  Layer.provideMerge(PersonalVoiceCallSummaryService.layerLive),
  Layer.provideMerge(PersonalVoiceSampleService.layerLive),
);

/**
 * Every personal service the running server provides, as one step. Consumers
 * sit before their dependencies because a later provideMerge step feeds the
 * requirements opened by an earlier one. The shared server supplies the
 * non-personal layers below this step.
 */
export const PersonalRuntimeLayerLive = Layer.empty.pipe(
  Layer.provideMerge(PersonalLoginRequestService.layerLive),
  Layer.provideMerge(PersonalConnectionApprovalService.layerLive),
  Layer.provideMerge(PersonalConnectionService.layerLive),
  Layer.provideMerge(Layer.mergeAll(WhatsAppSession.layer, WhatsAppSendLog.layer)),
  Layer.provideMerge(
    Layer.mergeAll(PersonalLoginService.layerLive, PersonalVoiceCallService.layerLive),
  ),
  Layer.provideMerge(Layer.mergeAll(PersonalBrowser.layer, PersonalDesktop.layer)),
  Layer.provideMerge(PersonalBrowserLease.layer),
  Layer.provideMerge(PersonalBrowserLeaseRepository.layer),
  Layer.provideMerge(PersonalBrowserProtectionRepository.layer),
  Layer.provideMerge(PersonalLoginRepository.layer),
  Layer.provideMerge(PersonalTasksDispatcherLive),
  Layer.provideMerge(PersonalGroupsDispatcherLive),
  Layer.provideMerge(PersonalSecretService.layerLive),
  Layer.provideMerge(PersonalTaskService.layerLive),
  Layer.provideMerge(PersonalGroupService.layerLive),
  Layer.provideMerge(PersonalBotsSeedLive),
  Layer.provideMerge(PersonalBotService.layer),
  Layer.provideMerge(PersonalBotRepository.layer),
  Layer.provideMerge(PersonalLayerWithCallSummaryLive),
  // The provider port sits below every personal consumer.
  Layer.provideMerge(
    PersonalProvidersV2Live.pipe(
      Layer.provideMerge(Layer.merge(PersonalPrewarmSessionLayer, PersonalProviderSessionsLayer)),
    ),
  ),
);
