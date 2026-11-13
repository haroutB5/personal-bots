/**
 * Upstream T3 Code migrations re-registered at our ids.
 *
 * This fork added 052-066 before upstream added its own 052. The migrator only
 * runs ids above the latest applied one, so an upstream migration keeps its
 * file name (clean future merges) but is registered in Migrations.ts at our
 * next free id. Key: upstream file name without ".ts". Value: our id.
 *
 * scripts/personal/sync/resolve-migrations.ts appends to this map during the
 * weekly upstream sync; Migrations.registry.test.ts enforces it.
 */
export const UPSTREAM_MIGRATION_IDS: Readonly<Record<string, number>> = {
  "052_ProjectionThreadTitleState": 67,
  "053_PullRequestFilesViewed": 82,
  "054_ProjectionThreadsAutoSettleDisabledAt": 83,
  "055_OrchestrationV2": 115,
  "056_RemoveRedundantProjectionIndexes": 116,
  "057_ScheduledTaskWebhooks": 117,
  "058_WebhookRelayDeliveries": 118,
  "059_McpAppModelContext": 119,
  "060_ThreadSnapshotWindowIndexes": 120,
  "061_PullRequestReviewGuides": 121,
  "062_ThreadFailureLookupIndex": 122,
  "064_CanonicalizeThreadPullRequestLinks": 123,
  "065_CodexUsageNativeTurnIndex": 124,
  "066_RepairClientSettlementTimestamps": 125,
  "067_WebhookDedupe": 126,
  "068_ShellStopRequestIndex": 127,
  "069_ThreadMessageSearch": 128,
  "070_PeerLinks": 129,
  "071_PeerLinkFence": 130,
  "072_WaitingLinkRequestIndex": 131,
  "073_ActiveTurnItemIndexes": 132,
  "074_ExcludeAttachmentPlaceholdersFromSearch": 133,
  "075_SubagentDeliveryState": 134,
  "076_ProjectionProjectsPinArchive": 135,
  "077_RepairBooleanSettledOverride": 136,
  "078_DropOrchestrationEventCorrelationIndex": 137,
  "079_DelegatedRecoveryIndexes": 138,
  "080_ScheduledTaskThreadMode": 139,
  "081_ProjectionMessageSearchText": 149,
  "082_TurnItemConversationIndex": 150,
  "083_CommandReadIndexes": 151,
  "084_LastExecutedRunIndex": 152,
  "085_TurnItemCounts": 153,
  "086_QueuedTurnInputIndex": 154,
  "087_ProjectionProjectsCustomTitle": 155,
  "088_TurnItemTypeStatusIndex": 156,
  "089_ShellThreadReadIndexes": 157,
};

/**
 * Upstream migrations that stay out of the registry on purpose. 063 drops the
 * V1 projection tables, so it ships one release after the V2 importer has run
 * on live data. The file stays in the tree; the sync resolver adds it with
 * --hold 063 until then.
 */
export const HELD_UPSTREAM_MIGRATIONS: ReadonlyArray<string> = ["063_DropUnusedV1Projections"];
