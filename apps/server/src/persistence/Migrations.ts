/**
 * Migration runner with an inline loader.
 *
 * Uses Migrator.make with fromRecord to define migrations inline.
 * All migrations are statically imported - no dynamic file system loading.
 *
 * `runMigrations` is called by the SQLite persistence layer at startup, so the
 * schema is always up to date before the application starts.
 */

import * as Migrator from "effect/sql/Migrator";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Import all migrations statically
import Migration0001 from "./Migrations/001_OrchestrationEvents.ts";
import Migration0002 from "./Migrations/002_OrchestrationCommandReceipts.ts";
import Migration0003 from "./Migrations/003_CheckpointDiffBlobs.ts";
import Migration0004 from "./Migrations/004_ProviderSessionRuntime.ts";
import Migration0005 from "./Migrations/005_Projections.ts";
import Migration0006 from "./Migrations/006_ProjectionThreadSessionRuntimeModeColumns.ts";
import Migration0007 from "./Migrations/007_ProjectionThreadMessageAttachments.ts";
import Migration0008 from "./Migrations/008_ProjectionThreadActivitySequence.ts";
import Migration0009 from "./Migrations/009_ProviderSessionRuntimeMode.ts";
import Migration0010 from "./Migrations/010_ProjectionThreadsRuntimeMode.ts";
import Migration0011 from "./Migrations/011_OrchestrationThreadCreatedRuntimeMode.ts";
import Migration0012 from "./Migrations/012_ProjectionThreadsInteractionMode.ts";
import Migration0013 from "./Migrations/013_ProjectionThreadProposedPlans.ts";
import Migration0014 from "./Migrations/014_ProjectionThreadProposedPlanImplementation.ts";
import Migration0015 from "./Migrations/015_ProjectionTurnsSourceProposedPlan.ts";
import Migration0016 from "./Migrations/016_CanonicalizeModelSelections.ts";
import Migration0017 from "./Migrations/017_ProjectionThreadsArchivedAt.ts";
import Migration0018 from "./Migrations/018_ProjectionThreadsArchivedAtIndex.ts";
import Migration0019 from "./Migrations/019_ProjectionSnapshotLookupIndexes.ts";
import Migration0020 from "./Migrations/020_AuthAccessManagement.ts";
import Migration0021 from "./Migrations/021_AuthSessionClientMetadata.ts";
import Migration0022 from "./Migrations/022_AuthSessionLastConnectedAt.ts";
import Migration0023 from "./Migrations/023_ProjectionThreadShellSummary.ts";
import Migration0024 from "./Migrations/024_BackfillProjectionThreadShellSummary.ts";
import Migration0025 from "./Migrations/025_CleanupInvalidProjectionPendingApprovals.ts";
import Migration0026 from "./Migrations/026_CanonicalizeModelSelectionOptions.ts";
import Migration0027 from "./Migrations/027_ProviderSessionRuntimeInstanceId.ts";
import Migration0028 from "./Migrations/028_ProjectionThreadSessionInstanceId.ts";
import Migration0029 from "./Migrations/029_ProjectionThreadDetailOrderingIndexes.ts";
import Migration0030 from "./Migrations/030_ProjectionThreadShellArchiveIndexes.ts";
import Migration0031 from "./Migrations/031_AuthAuthorizationScopes.ts";
import Migration0032 from "./Migrations/032_AuthPairingProofKeyThumbprint.ts";
import Migration0033 from "./Migrations/033_ProjectionThreadsSettled.ts";
import Migration0034 from "./Migrations/034_ProjectionThreadsSnoozed.ts";
import Migration0035 from "./Migrations/035_ProjectionThreadTitleRegeneration.ts";
import Migration0036 from "./Migrations/036_ProjectionThreadsPinned.ts";
import Migration0037 from "./Migrations/037_ProjectionTurnsKeysetIndex.ts";
import Migration0038 from "./Migrations/038_ProjectionThreadsPinOrderKey.ts";
import Migration0039 from "./Migrations/039_ProjectionProjectsDefaultThreadEnvMode.ts";
import Migration0040 from "./Migrations/040_ProjectionProjectFaviconPath.ts";
import Migration0041 from "./Migrations/041_AuthSessionClientConnection.ts";
import Migration0042 from "./Migrations/042_ProjectionThreadLinkedPullRequest.ts";
import Migration0043 from "./Migrations/043_ProjectionThreadsUnsettledAt.ts";
import Migration0044 from "./Migrations/044_ClearAutomaticProjectModelDefaults.ts";
import Migration0045 from "./Migrations/045_ProjectionProjectsAutoPull.ts";
import Migration0046 from "./Migrations/046_RepairAutomaticSettlementTimestamps.ts";
import Migration0047 from "./Migrations/047_ProjectionProjectIcon.ts";
import Migration0048 from "./Migrations/048_ProjectionThreadBranchPullRequest.ts";
import Migration0049 from "./Migrations/049_ProjectionThreadsActiveOrderKey.ts";
import Migration0050 from "./Migrations/050_ProjectionThreadPullRequests.ts";
import Migration0051 from "./Migrations/051_ProjectionThreadMessageContext.ts";
import Migration0052 from "./Migrations/052_PersonalBots.ts";
import Migration0053 from "./Migrations/053_PersonalTasks.ts";
import Migration0054 from "./Migrations/054_PersonalSecretRequests.ts";
import Migration0055 from "./Migrations/055_PersonalBotTitle.ts";
import Migration0056 from "./Migrations/056_PersonalBrowserLeases.ts";
import Migration0057 from "./Migrations/057_PersonalRoutines.ts";
import Migration0058 from "./Migrations/058_PersonalMemory.ts";
import Migration0059 from "./Migrations/059_PersonalNotifications.ts";
import Migration0060 from "./Migrations/060_ProjectionThreadSessionProviderRetry.ts";
import Migration0061 from "./Migrations/061_PersonalHotPathIndexes.ts";
import Migration0062 from "./Migrations/062_PersonalBrowserRestoreUrl.ts";
import Migration0063 from "./Migrations/063_PersonalLogins.ts";
import Migration0064 from "./Migrations/064_PersonalRoutineEventTriggers.ts";
import Migration0065 from "./Migrations/065_PersonalBrowserProtection.ts";
import Migration0066 from "./Migrations/066_DropPersonalLoginGrants.ts";
// Upstream T3 Code migrations, appended at our next free id. The id map lives in
// ./upstreamMigrationIds.ts; the file keeps upstream's name so later merges stay clean.
import MigrationUpstream0052 from "./Migrations/052_ProjectionThreadTitleState.ts";
import Migration0068 from "./Migrations/068_PersonalLoginSensitive.ts";
import Migration0069 from "./Migrations/069_PersonalBotTeams.ts";
import Migration0070 from "./Migrations/070_PersonalGroups.ts";
import Migration0071 from "./Migrations/071_PersonalGroupVerdict.ts";
import Migration0072 from "./Migrations/072_PersonalConnections.ts";
import Migration0073 from "./Migrations/073_PersonalConnectionApprovals.ts";
import Migration0074 from "./Migrations/074_PersonalCreateAppRuns.ts";
import Migration0075 from "./Migrations/075_PersonalWhatsApp.ts";
import Migration0076 from "./Migrations/076_PersonalConnectionApprovalsWhatsApp.ts";
import Migration0077 from "./Migrations/077_PersonalSensitiveExposures.ts";
import Migration0078 from "./Migrations/078_PersonalBotMemoryAutoSave.ts";
import Migration0079 from "./Migrations/079_PersonalRoutineDelivery.ts";
import Migration0080 from "./Migrations/080_PersonalBotNotificationMute.ts";
import Migration0081 from "./Migrations/081_PersonalRoutineThread.ts";
import Migration0084 from "./Migrations/084_PersonalChatResumes.ts";
import Migration0085 from "./Migrations/085_PersonalTaskChatAutoArchive.ts";
import Migration0086 from "./Migrations/086_PersonalGroupLimitResumes.ts";
import Migration0087 from "./Migrations/087_PersonalLeadBotActions.ts";
import Migration0088 from "./Migrations/088_PersonalLeadBotConfirmations.ts";
import Migration0089 from "./Migrations/089_PersonalLoginRequests.ts";
import Migration0090 from "./Migrations/090_PersonalBrowserLoginOrigins.ts";
import Migration0091 from "./Migrations/091_PersonalMemorySupersede.ts";
import Migration0092 from "./Migrations/092_PersonalMemoryTidySnapshots.ts";
import Migration0093 from "./Migrations/093_PersonalMemoryApps.ts";
import Migration0094 from "./Migrations/094_PersonalMemoryContextAndWorkRecords.ts";
import Migration0095 from "./Migrations/095_PersonalMemoryFeedbackCleanup.ts";
import Migration0096 from "./Migrations/096_PersonalMemoryTidyUndo.ts";
import Migration0097 from "./Migrations/097_ProjectionThreadActivityKindIndex.ts";
import Migration0098 from "./Migrations/098_PersonalRoutineNotifyMode.ts";
import Migration0099 from "./Migrations/099_PersonalBotHidePreviews.ts";
import Migration0100 from "./Migrations/100_PersonalChatPinSnoozeUnread.ts";
import Migration0101 from "./Migrations/101_PersonalModelFallback.ts";
import Migration0102 from "./Migrations/102_PersonalSecretBrokering.ts";
import Migration0103 from "./Migrations/103_PersonalSecretPlacement.ts";
import Migration0104 from "./Migrations/104_PersonalMemoryEvidence.ts";
import Migration0105 from "./Migrations/105_ProjectionThreadMessagesRoleIndex.ts";
import Migration0106 from "./Migrations/106_StalePendingTurnStartCleanup.ts";
import Migration0107 from "./Migrations/107_FreezeLookupIndexes.ts";
import Migration0108 from "./Migrations/108_PersonalBotModelSchedule.ts";
import Migration0109 from "./Migrations/109_PersonalVoiceCalls.ts";
import Migration0110 from "./Migrations/110_PersonalVoiceCallLeases.ts";
import Migration0111 from "./Migrations/111_PersonalVoiceCallSummary.ts";
import Migration0112 from "./Migrations/112_ProviderSessionHistory.ts";
import Migration0113 from "./Migrations/113_LinuxPathRewrite.ts";
import Migration0114 from "./Migrations/114_LinuxInstructionPaths.ts";
import Migration0140 from "./Migrations/140_PersonalThreadRetry.ts";
import Migration0141 from "./Migrations/141_PersonalNoticeChunks.ts";
import Migration0142 from "./Migrations/142_PersonalThreadTitleState.ts";
import Migration0143 from "./Migrations/143_PersonalFcmTokens.ts";
import Migration0144 from "./Migrations/144_PersonalPhoneCommands.ts";
import Migration0145 from "./Migrations/145_PersonalPushSubscriptionSession.ts";
import Migration0146 from "./Migrations/146_PersonalSensitiveSites.ts";
import MigrationUpstream0053 from "./Migrations/053_PullRequestFilesViewed.ts";
import MigrationUpstream0054 from "./Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts";
import MigrationUpstream0055 from "./Migrations/055_OrchestrationV2.ts";
import MigrationUpstream0056 from "./Migrations/056_RemoveRedundantProjectionIndexes.ts";
import MigrationUpstream0057 from "./Migrations/057_ScheduledTaskWebhooks.ts";
import MigrationUpstream0058 from "./Migrations/058_WebhookRelayDeliveries.ts";
import MigrationUpstream0059 from "./Migrations/059_McpAppModelContext.ts";
import MigrationUpstream0060 from "./Migrations/060_ThreadSnapshotWindowIndexes.ts";
import MigrationUpstream0061 from "./Migrations/061_PullRequestReviewGuides.ts";
import MigrationUpstream0062 from "./Migrations/062_ThreadFailureLookupIndex.ts";
import MigrationUpstream0064 from "./Migrations/064_CanonicalizeThreadPullRequestLinks.ts";
import MigrationUpstream0065 from "./Migrations/065_CodexUsageNativeTurnIndex.ts";
import MigrationUpstream0066 from "./Migrations/066_RepairClientSettlementTimestamps.ts";
import MigrationUpstream0067 from "./Migrations/067_WebhookDedupe.ts";
import MigrationUpstream0068 from "./Migrations/068_ShellStopRequestIndex.ts";
import MigrationUpstream0069 from "./Migrations/069_ThreadMessageSearch.ts";
import MigrationUpstream0070 from "./Migrations/070_PeerLinks.ts";
import MigrationUpstream0071 from "./Migrations/071_PeerLinkFence.ts";
import MigrationUpstream0072 from "./Migrations/072_WaitingLinkRequestIndex.ts";
import MigrationUpstream0073 from "./Migrations/073_ActiveTurnItemIndexes.ts";
import MigrationUpstream0074 from "./Migrations/074_ExcludeAttachmentPlaceholdersFromSearch.ts";
import MigrationUpstream0075 from "./Migrations/075_SubagentDeliveryState.ts";
import MigrationUpstream0076 from "./Migrations/076_ProjectionProjectsPinArchive.ts";
import MigrationUpstream0077 from "./Migrations/077_RepairBooleanSettledOverride.ts";
import MigrationUpstream0078 from "./Migrations/078_DropOrchestrationEventCorrelationIndex.ts";
import MigrationUpstream0079 from "./Migrations/079_DelegatedRecoveryIndexes.ts";
import MigrationUpstream0080 from "./Migrations/080_ScheduledTaskThreadMode.ts";

/**
 * Migration loader with all migrations defined inline.
 *
 * Key format: "{id}_{name}" where:
 * - id: numeric migration ID (determines execution order)
 * - name: descriptive name for the migration
 *
 * Uses Migrator.fromRecord which parses the key format and
 * returns migrations sorted by ID.
 */
const migrationEntries = [
  [1, "OrchestrationEvents", Migration0001],
  [2, "OrchestrationCommandReceipts", Migration0002],
  [3, "CheckpointDiffBlobs", Migration0003],
  [4, "ProviderSessionRuntime", Migration0004],
  [5, "Projections", Migration0005],
  [6, "ProjectionThreadSessionRuntimeModeColumns", Migration0006],
  [7, "ProjectionThreadMessageAttachments", Migration0007],
  [8, "ProjectionThreadActivitySequence", Migration0008],
  [9, "ProviderSessionRuntimeMode", Migration0009],
  [10, "ProjectionThreadsRuntimeMode", Migration0010],
  [11, "OrchestrationThreadCreatedRuntimeMode", Migration0011],
  [12, "ProjectionThreadsInteractionMode", Migration0012],
  [13, "ProjectionThreadProposedPlans", Migration0013],
  [14, "ProjectionThreadProposedPlanImplementation", Migration0014],
  [15, "ProjectionTurnsSourceProposedPlan", Migration0015],
  [16, "CanonicalizeModelSelections", Migration0016],
  [17, "ProjectionThreadsArchivedAt", Migration0017],
  [18, "ProjectionThreadsArchivedAtIndex", Migration0018],
  [19, "ProjectionSnapshotLookupIndexes", Migration0019],
  [20, "AuthAccessManagement", Migration0020],
  [21, "AuthSessionClientMetadata", Migration0021],
  [22, "AuthSessionLastConnectedAt", Migration0022],
  [23, "ProjectionThreadShellSummary", Migration0023],
  [24, "BackfillProjectionThreadShellSummary", Migration0024],
  [25, "CleanupInvalidProjectionPendingApprovals", Migration0025],
  [26, "CanonicalizeModelSelectionOptions", Migration0026],
  [27, "ProviderSessionRuntimeInstanceId", Migration0027],
  [28, "ProjectionThreadSessionInstanceId", Migration0028],
  [29, "ProjectionThreadDetailOrderingIndexes", Migration0029],
  [30, "ProjectionThreadShellArchiveIndexes", Migration0030],
  [31, "AuthAuthorizationScopes", Migration0031],
  [32, "AuthPairingProofKeyThumbprint", Migration0032],
  [33, "ProjectionThreadsSettled", Migration0033],
  [34, "ProjectionThreadsSnoozed", Migration0034],
  [35, "ProjectionThreadTitleRegeneration", Migration0035],
  [36, "ProjectionThreadsPinned", Migration0036],
  [37, "ProjectionTurnsKeysetIndex", Migration0037],
  [38, "ProjectionThreadsPinOrderKey", Migration0038],
  [39, "ProjectionProjectsDefaultThreadEnvMode", Migration0039],
  [40, "ProjectionProjectFaviconPath", Migration0040],
  [41, "AuthSessionClientConnection", Migration0041],
  [42, "ProjectionThreadLinkedPullRequest", Migration0042],
  [43, "ProjectionThreadsUnsettledAt", Migration0043],
  [44, "ClearAutomaticProjectModelDefaults", Migration0044],
  [45, "ProjectionProjectsAutoPull", Migration0045],
  [46, "RepairAutomaticSettlementTimestamps", Migration0046],
  [47, "ProjectionProjectIcon", Migration0047],
  [48, "ProjectionThreadBranchPullRequest", Migration0048],
  [49, "ProjectionThreadsActiveOrderKey", Migration0049],
  [50, "ProjectionThreadPullRequests", Migration0050],
  [51, "ProjectionThreadMessageContext", Migration0051],
  [52, "PersonalBots", Migration0052],
  [53, "PersonalTasks", Migration0053],
  [54, "PersonalSecretRequests", Migration0054],
  [55, "PersonalBotTitle", Migration0055],
  [56, "PersonalBrowserLeases", Migration0056],
  [57, "PersonalRoutines", Migration0057],
  [58, "PersonalMemory", Migration0058],
  [59, "PersonalNotifications", Migration0059],
  [60, "ProjectionThreadSessionProviderRetry", Migration0060],
  [61, "PersonalHotPathIndexes", Migration0061],
  [62, "PersonalBrowserRestoreUrl", Migration0062],
  [63, "PersonalLogins", Migration0063],
  [64, "PersonalRoutineEventTriggers", Migration0064],
  [65, "PersonalBrowserProtection", Migration0065],
  [66, "DropPersonalLoginGrants", Migration0066],
  // Upstream 052_ProjectionThreadTitleState, renumbered (see upstreamMigrationIds.ts).
  [67, "ProjectionThreadTitleState", MigrationUpstream0052],
  [68, "PersonalLoginSensitive", Migration0068],
  [69, "PersonalBotTeams", Migration0069],
  [70, "PersonalGroups", Migration0070],
  [71, "PersonalGroupVerdict", Migration0071],
  [72, "PersonalConnections", Migration0072],
  [73, "PersonalConnectionApprovals", Migration0073],
  [74, "PersonalCreateAppRuns", Migration0074],
  [75, "PersonalWhatsApp", Migration0075],
  [76, "PersonalConnectionApprovalsWhatsApp", Migration0076],
  [77, "PersonalSensitiveExposures", Migration0077],
  [78, "PersonalBotMemoryAutoSave", Migration0078],
  [79, "PersonalRoutineDelivery", Migration0079],
  [80, "PersonalBotNotificationMute", Migration0080],
  [81, "PersonalRoutineThread", Migration0081],
  // Upstream 053_PullRequestFilesViewed, renumbered (see upstreamMigrationIds.ts).
  [82, "PullRequestFilesViewed", MigrationUpstream0053],
  // Upstream 054_ProjectionThreadsAutoSettleDisabledAt, renumbered (see upstreamMigrationIds.ts).
  [83, "ProjectionThreadsAutoSettleDisabledAt", MigrationUpstream0054],
  [84, "PersonalChatResumes", Migration0084],
  [85, "PersonalTaskChatAutoArchive", Migration0085],
  [86, "PersonalGroupLimitResumes", Migration0086],
  [87, "PersonalLeadBotActions", Migration0087],
  [88, "PersonalLeadBotConfirmations", Migration0088],
  [89, "PersonalLoginRequests", Migration0089],
  [90, "PersonalBrowserLoginOrigins", Migration0090],
  [91, "PersonalMemorySupersede", Migration0091],
  [92, "PersonalMemoryTidySnapshots", Migration0092],
  [93, "PersonalMemoryApps", Migration0093],
  [94, "PersonalMemoryContextAndWorkRecords", Migration0094],
  [95, "PersonalMemoryFeedbackCleanup", Migration0095],
  [96, "PersonalMemoryTidyUndo", Migration0096],
  [97, "ProjectionThreadActivityKindIndex", Migration0097],
  [98, "PersonalRoutineNotifyMode", Migration0098],
  [99, "PersonalBotHidePreviews", Migration0099],
  [100, "PersonalChatPinSnoozeUnread", Migration0100],
  [101, "PersonalModelFallback", Migration0101],
  [102, "PersonalSecretBrokering", Migration0102],
  [103, "PersonalSecretPlacement", Migration0103],
  [104, "PersonalMemoryEvidence", Migration0104],
  [105, "ProjectionThreadMessagesRoleIndex", Migration0105],
  [106, "StalePendingTurnStartCleanup", Migration0106],
  [107, "FreezeLookupIndexes", Migration0107],
  [108, "PersonalBotModelSchedule", Migration0108],
  [109, "PersonalVoiceCalls", Migration0109],
  [110, "PersonalVoiceCallLeases", Migration0110],
  [111, "PersonalVoiceCallSummary", Migration0111],
  [112, "ProviderSessionHistory", Migration0112],
  [113, "LinuxPathRewrite", Migration0113],
  [114, "LinuxInstructionPaths", Migration0114],
  // Upstream 055_OrchestrationV2, renumbered (see upstreamMigrationIds.ts).
  [115, "OrchestrationV2", MigrationUpstream0055],
  // Upstream 056_RemoveRedundantProjectionIndexes, renumbered (see upstreamMigrationIds.ts).
  [116, "RemoveRedundantProjectionIndexes", MigrationUpstream0056],
  // Upstream 057_ScheduledTaskWebhooks, renumbered (see upstreamMigrationIds.ts).
  [117, "ScheduledTaskWebhooks", MigrationUpstream0057],
  // Upstream 058_WebhookRelayDeliveries, renumbered (see upstreamMigrationIds.ts).
  [118, "WebhookRelayDeliveries", MigrationUpstream0058],
  // Upstream 059_McpAppModelContext, renumbered (see upstreamMigrationIds.ts).
  [119, "McpAppModelContext", MigrationUpstream0059],
  // Upstream 060_ThreadSnapshotWindowIndexes, renumbered (see upstreamMigrationIds.ts).
  [120, "ThreadSnapshotWindowIndexes", MigrationUpstream0060],
  // Upstream 061_PullRequestReviewGuides, renumbered (see upstreamMigrationIds.ts).
  [121, "PullRequestReviewGuides", MigrationUpstream0061],
  // Upstream 062_ThreadFailureLookupIndex, renumbered (see upstreamMigrationIds.ts).
  [122, "ThreadFailureLookupIndex", MigrationUpstream0062],
  // Upstream 064_CanonicalizeThreadPullRequestLinks, renumbered (see upstreamMigrationIds.ts).
  [123, "CanonicalizeThreadPullRequestLinks", MigrationUpstream0064],
  // Upstream 065_CodexUsageNativeTurnIndex, renumbered (see upstreamMigrationIds.ts).
  [124, "CodexUsageNativeTurnIndex", MigrationUpstream0065],
  // Upstream 066_RepairClientSettlementTimestamps, renumbered (see upstreamMigrationIds.ts).
  [125, "RepairClientSettlementTimestamps", MigrationUpstream0066],
  // Upstream 067_WebhookDedupe, renumbered (see upstreamMigrationIds.ts).
  [126, "WebhookDedupe", MigrationUpstream0067],
  // Upstream 068_ShellStopRequestIndex, renumbered (see upstreamMigrationIds.ts).
  [127, "ShellStopRequestIndex", MigrationUpstream0068],
  // Upstream 069_ThreadMessageSearch, renumbered (see upstreamMigrationIds.ts).
  [128, "ThreadMessageSearch", MigrationUpstream0069],
  // Upstream 070_PeerLinks, renumbered (see upstreamMigrationIds.ts).
  [129, "PeerLinks", MigrationUpstream0070],
  // Upstream 071_PeerLinkFence, renumbered (see upstreamMigrationIds.ts).
  [130, "PeerLinkFence", MigrationUpstream0071],
  // Upstream 072_WaitingLinkRequestIndex, renumbered (see upstreamMigrationIds.ts).
  [131, "WaitingLinkRequestIndex", MigrationUpstream0072],
  // Upstream 073_ActiveTurnItemIndexes, renumbered (see upstreamMigrationIds.ts).
  [132, "ActiveTurnItemIndexes", MigrationUpstream0073],
  // Upstream 074_ExcludeAttachmentPlaceholdersFromSearch, renumbered (see upstreamMigrationIds.ts).
  [133, "ExcludeAttachmentPlaceholdersFromSearch", MigrationUpstream0074],
  // Upstream 075_SubagentDeliveryState, renumbered (see upstreamMigrationIds.ts).
  [134, "SubagentDeliveryState", MigrationUpstream0075],
  // Upstream 076_ProjectionProjectsPinArchive, renumbered (see upstreamMigrationIds.ts).
  [135, "ProjectionProjectsPinArchive", MigrationUpstream0076],
  // Upstream 077_RepairBooleanSettledOverride, renumbered (see upstreamMigrationIds.ts).
  [136, "RepairBooleanSettledOverride", MigrationUpstream0077],
  // Upstream 078_DropOrchestrationEventCorrelationIndex, renumbered (see upstreamMigrationIds.ts).
  [137, "DropOrchestrationEventCorrelationIndex", MigrationUpstream0078],
  // Upstream 079_DelegatedRecoveryIndexes, renumbered (see upstreamMigrationIds.ts).
  [138, "DelegatedRecoveryIndexes", MigrationUpstream0079],
  // Upstream 080_ScheduledTaskThreadMode, renumbered (see upstreamMigrationIds.ts).
  [139, "ScheduledTaskThreadMode", MigrationUpstream0080],
  [140, "PersonalThreadRetry", Migration0140],
  [141, "PersonalNoticeChunks", Migration0141],
  [142, "PersonalThreadTitleState", Migration0142],
  [143, "PersonalFcmTokens", Migration0143],
  [144, "PersonalPhoneCommands", Migration0144],
  [145, "PersonalPushSubscriptionSession", Migration0145],
  [146, "PersonalSensitiveSites", Migration0146],
  // Ids are contiguous. The migrator runs only ids above the latest applied
  // one, so every new migration (ours or upstream's) takes the next free id;
  // never deploy a gap. Upstream migrations keep their file name and are
  // recorded in upstreamMigrationIds.ts. Migrations.registry.test.ts enforces this.
] as const;

export const migrationManifest = migrationEntries.map(([id, name]) => [id, name] as const);

const makeMigrationLoader = (throughId?: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      migrationEntries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

// The first id that is not in a v1 database's history; v1 divergences below it
// are expected and are logged, but skipping a V2 migration is refused.
const FIRST_V2_MIGRATION_ID = 115;

// Migrators skip ids up to the highest recorded; reject collisions that would skip V2 schema.
const assertV2MigrationsCanRun = Effect.fn("assertV2MigrationsCanRun")(function* (
  throughId?: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (tables.length === 0) return;
  const recorded = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`SELECT migration_id, name FROM effect_sql_migrations`;
  const latestRecordedId = Math.max(0, ...recorded.map((row) => row.migration_id));
  const recordedNames = new Map(recorded.map((row) => [row.migration_id, row.name]));
  const skipped = migrationEntries.flatMap(([id, name]) => {
    if (
      id < FIRST_V2_MIGRATION_ID ||
      id > latestRecordedId ||
      (throughId !== undefined && id > throughId)
    )
      return [];
    const recordedName = recordedNames.get(id);
    if (recordedName === name) return [];
    return [`${id}_${name} (recorded: ${recordedName ?? "nothing"})`];
  });
  if (skipped.length === 0) return;
  return yield* new Migrator.MigrationError({
    kind: "BadState",
    message: `This database's migration history would skip required schema migrations: ${skipped.join(", ")}. The migrator skips every id up to the highest recorded id (${latestRecordedId}), regardless of name. It was probably written by a different build. Start the build that wrote it, or report this migration history so an upgrade path can be added.`,
  });
});

/**
 * Migrator run function - no schema dumping needed
 * Uses the base Migrator.make without platform dependencies
 */
const run = Migrator.make({});

export interface RunMigrationsOptions {
  readonly toMigrationInclusive?: number | undefined;
}

/**
 * Run all pending migrations.
 *
 * Creates the migrations tracking table (effect_sql_migrations) if it doesn't exist,
 * then runs any migrations with ID greater than the latest recorded migration.
 *
 * Returns array of [id, name] tuples for migrations that were run.
 *
 * @returns Effect containing array of executed migrations
 */
export const runMigrations = Effect.fn("runMigrations")(function* ({
  toMigrationInclusive,
}: RunMigrationsOptions = {}) {
  const includesV2 =
    toMigrationInclusive === undefined || toMigrationInclusive >= FIRST_V2_MIGRATION_ID;
  if (includesV2) {
    yield* assertV2MigrationsCanRun(toMigrationInclusive);
  }
  const executedMigrations = yield* run({ loader: makeMigrationLoader(toMigrationInclusive) });
  const migrations = executedMigrations.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Database schema is current")
    : Effect.log("Migrations ran successfully").pipe(Effect.annotateLogs({ migrations }));

  const sql = yield* SqlClient.SqlClient;
  const recorded = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`SELECT migration_id, name FROM effect_sql_migrations`;
  const manifestNames = new Map<number, string>(migrationEntries.map(([id, name]) => [id, name]));
  const divergent = recorded.flatMap((row) => {
    const expected = manifestNames.get(row.migration_id);
    if (expected === undefined) {
      return [`${row.migration_id}:${row.name} (unknown to this build)`];
    }
    return expected === row.name
      ? []
      : [`${row.migration_id}:${row.name} (this build: ${expected})`];
  });
  if (divergent.length > 0) {
    yield* Effect.logWarning(
      "Database migration history diverges from this build; recorded migration ids are skipped, not reconciled by name.",
    ).pipe(Effect.annotateLogs({ divergent }));
  }
  return executedMigrations;
});
