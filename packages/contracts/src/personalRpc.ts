import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { ThreadId } from "./baseSchemas.ts";
import { EnvironmentAuthorizationError } from "./auth.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  PersonalBotsError,
  PersonalBot,
  PersonalBotArchiveThreadInput,
  PersonalBotArchiveThreadsInput,
  PersonalBotUpdateThreadsInput,
  PersonalBotSearchMessagesInput,
  PersonalBotSearchMessagesResult,
  PersonalBotWorkingProgressInput,
  PersonalBotWorkingProgressResult,
  PersonalBotTokenUsageInput,
  PersonalBotTokenUsageResult,
  PersonalBotPrewarmThreadInput,
  PersonalBotCreateInput,
  PersonalBotCreateThreadInput,
  PersonalBotDeleteInput,
  PersonalBotDeleteThreadInput,
  PersonalBotDeleteThreadsInput,
  PersonalBotsListResult,
  PersonalBotThreadShellsInput,
  PersonalBotThreadShellsResult,
  PersonalThreadFullTextInput,
  PersonalThreadFullTextResult,
  PersonalBotThread,
  PersonalBotThreadsBatchResult,
  PersonalFileDeleteInput,
  PersonalFilesBatchResult,
  PersonalFilesDeleteManyInput,
  PersonalFilesListResult,
  PersonalBotUpdateInput,
  PersonalProfile,
  PersonalProfileSetInput,
} from "./personalBots.ts";
import {
  PersonalVoiceCallsError,
  VoiceCallFinishInput,
  VoiceCallFinishResult,
  VoiceCallKeyCheckInput,
  VoiceCallKeyCheckResult,
  VoiceCallListInput,
  VoiceCallListResult,
  VoiceCallLookupMemoryInput,
  VoiceCallLookupMemoryResult,
  VoiceCallRenewPassInput,
  VoiceCallRenewPassResult,
  VoiceCallSearchWebInput,
  VoiceCallSearchWebResult,
  VoiceCallSendInput,
  VoiceCallSendResult,
  VoiceCallSnapshotInput,
  VoiceCallSnapshotResult,
  VoiceCallStartInput,
  VoiceCallStartResult,
  VoiceCallSampleInput,
  VoiceCallSampleResult,
  VoiceCallTranscriptInput,
  VoiceCallTranscriptResult,
} from "./personalVoiceCalls.ts";
import {
  PersonalTasksError,
  PersonalTask,
  PersonalTaskCreateInput,
  PersonalTaskDetail,
  PersonalTaskHistoryInput,
  PersonalTaskHistoryResult,
  PersonalTaskRelatedInput,
  PersonalTaskIdInput,
  PersonalTaskListInput,
  PersonalTaskListResult,
  PersonalTaskStreamEvent,
} from "./personalTasks.ts";
import {
  PersonalGroupsError,
  PersonalGroup,
  PersonalGroupCreateInput,
  PersonalGroupContinueRoundInput,
  PersonalGroupDeleteInput,
  PersonalGroupIdInput,
  PersonalGroupListResult,
  PersonalGroupMemberInput,
  PersonalGroupRound,
  PersonalGroupSendMessageInput,
  PersonalGroupStreamEvent,
  PersonalGroupUpdateInput,
} from "./personalGroups.ts";
import {
  PersonalSecretsError,
  PersonalSecretFulfillInput,
  PersonalSecretNameInput,
  PersonalSecretSharingInput,
  PersonalSecretModeInput,
  PersonalSecretRequest,
  PersonalSecretRequestIdInput,
  PersonalSecretsListPendingResult,
  PersonalSecretsListResult,
  PersonalSecretCreateInput,
} from "./personalSecrets.ts";
import {
  PersonalLeadBotChangesError,
  PersonalBotRestoreInput,
  PersonalBotRestoreResult,
  PersonalLeadBotChange,
  PersonalLeadBotChangeDecideInput,
  PersonalLeadBotChangeListResult,
  PersonalRemovedBotsListResult,
} from "./personalLeadBots.ts";
import {
  PersonalConnectionsError,
  PersonalConnection,
  PersonalConnectionApproval,
  PersonalConnectionApprovalDecideInput,
  PersonalConnectionApprovalIdInput,
  PersonalConnectionApprovalListResult,
  PersonalConnectionConnectInput,
  PersonalConnectionDisconnectResult,
  PersonalConnectionIdInput,
  PersonalConnectionListResult,
  PersonalConnectionRotateInput,
  PersonalConnectionImportAdoptInput,
  PersonalConnectionImportResult,
  PersonalConnectionValidateInput,
  PersonalConnectionValidationResult,
  PersonalConnectionBrowserConnectInput,
  PersonalConnectionBrowserConnectResult,
  PersonalConnectionSettingsInput,
} from "./personalConnections.ts";
import {
  PersonalLoginsError,
  PersonalLogin,
  PersonalLoginCreateInput,
  PersonalLoginDeleteInput,
  PersonalLoginsBatchResult,
  PersonalLoginsDeleteManyInput,
  PersonalLoginsListResult,
  PersonalLoginUpdateInput,
  PersonalLoginSetSensitiveInput,
} from "./personalLogins.ts";
import {
  PersonalDesktopError,
  PersonalDesktopStatus,
  PersonalDesktopStreamItem,
} from "./personalDesktop.ts";
import {
  PersonalBrowserError,
  PersonalBrowserFilesResult,
  PersonalBrowserStatus,
  PersonalBrowserStreamItem,
} from "./personalBrowser.ts";
import {
  PersonalRoutinesError,
  PersonalRoutine,
  PersonalRoutineCreateInput,
  PersonalRoutineIdInput,
  PersonalRoutinesBatchResult,
  PersonalRoutinesDeleteManyInput,
  PersonalRoutinesSetEnabledManyInput,
  PersonalRoutineListResult,
  PersonalRoutineRunNowInput,
  PersonalRoutineRunNowResult,
  PersonalRoutineUpdateInput,
} from "./personalRoutines.ts";
import {
  PersonalMemoryError,
  PersonalMemoryDeleteInput,
  PersonalMemoryBatchResult,
  PersonalMemoryDeleteManyInput,
  PersonalMemoryEntry,
  PersonalMemoryListInput,
  PersonalMemoryListResult,
  PersonalMemoryRestoreInput,
  PersonalMemoryUndoNoteInput,
  PersonalMemoryGetInput,
  PersonalMemorySearchInput,
  PersonalMemoryFeedbackInput,
  PersonalMemoryFeedbackResult,
  PersonalMemoryRulesUsage,
  PersonalMemoryTurnContext,
  PersonalMemoryTurnContextInput,
  PersonalMemoryTidyLogInput,
  PersonalMemoryTidyLogResult,
  PersonalMemoryTidyRun,
  PersonalMemoryTidyDecideInput,
  PersonalMemoryTidyUndoInput,
  PersonalMemoryCardsInput,
  PersonalMemoryCardsResult,
  PersonalMemoryTidyRunInput,
  PersonalMemoryTidySetModeInput,
  PersonalMemoryUpdateInput,
} from "./personalMemory.ts";
import {
  PersonalPushError,
  PersonalPushEndpointInput,
  PersonalPushPreferences,
  PersonalPushPublicKeyResult,
  PersonalPushSettings,
  PersonalPushSubscribeInput,
  PersonalPushSubscribeResult,
  PersonalPushTestInput,
  PersonalPushTestResult,
  PersonalPushViewingInput,
  PersonalPushForegroundInput,
  PersonalPushInAppAckInput,
  PersonalPushInAppNotification,
} from "./personalPush.ts";
import { WS_METHODS } from "./wsMethods.ts";
import {
  PersonalLoginRequest,
  PersonalLoginRequestsListInput,
  PersonalLoginRequestsListResult,
  PersonalLoginRequestsSubmitInput,
  PersonalLoginRequestsCancelInput,
} from "./personalLoginRequests.ts";

const PersonalBotsRpcError = Schema.Union([PersonalBotsError, EnvironmentAuthorizationError]);
// A team lead's remove or rewrite of a bot it did not create, waiting on the
// owner's tap. `decide` is the only way to approve one.
const PersonalLeadBotChangesRpcError = Schema.Union([
  PersonalLeadBotChangesError,
  EnvironmentAuthorizationError,
]);
// Voice calls: owner-only, like everything that can spend the saved Gemini key
// or post into a chat. No MCP tool reaches any of them.
const PersonalVoiceCallsRpcError = Schema.Union([
  PersonalVoiceCallsError,
  EnvironmentAuthorizationError,
]);
const PersonalTasksRpcError = Schema.Union([PersonalTasksError, EnvironmentAuthorizationError]);
const PersonalGroupsRpcError = Schema.Union([PersonalGroupsError, EnvironmentAuthorizationError]);
const PersonalSecretsRpcError = Schema.Union([PersonalSecretsError, EnvironmentAuthorizationError]);
const PersonalConnectionsRpcError = Schema.Union([
  PersonalConnectionsError,
  EnvironmentAuthorizationError,
]);
const PersonalLoginsRpcError = Schema.Union([PersonalLoginsError, EnvironmentAuthorizationError]);
// personal browser
const PersonalBrowserRpcError = Schema.Union([PersonalBrowserError, EnvironmentAuthorizationError]);
const PersonalDesktopRpcError = Schema.Union([PersonalDesktopError, EnvironmentAuthorizationError]);
const PersonalRoutinesRpcError = Schema.Union([
  PersonalRoutinesError,
  EnvironmentAuthorizationError,
]);
const PersonalMemoryRpcError = Schema.Union([PersonalMemoryError, EnvironmentAuthorizationError]);
const PersonalPushRpcError = Schema.Union([PersonalPushError, EnvironmentAuthorizationError]);
const WsPersonalBotsListRpc = Rpc.make(WS_METHODS.personalBotsList, {
  payload: Schema.Struct({
    omitArchived: Schema.optional(Schema.Boolean),
    archivedBotId: Schema.optional(Schema.String),
    archivedThreadId: Schema.optional(Schema.String),
  }),
  success: PersonalBotsListResult,
  error: PersonalBotsRpcError,
});
const WsPersonalBotsCreateRpc = Rpc.make(WS_METHODS.personalBotsCreate, {
  payload: PersonalBotCreateInput,
  success: PersonalBot,
  error: PersonalBotsRpcError,
});
const WsPersonalBotsUpdateRpc = Rpc.make(WS_METHODS.personalBotsUpdate, {
  payload: PersonalBotUpdateInput,
  success: PersonalBot,
  error: PersonalBotsRpcError,
});
const WsPersonalBotsDeleteRpc = Rpc.make(WS_METHODS.personalBotsDelete, {
  payload: PersonalBotDeleteInput,
  success: Schema.Struct({}),
  error: PersonalBotsRpcError,
});
const WsPersonalBotsCreateThreadRpc = Rpc.make(WS_METHODS.personalBotsCreateThread, {
  payload: PersonalBotCreateThreadInput,
  success: PersonalBotThread,
  error: PersonalBotsRpcError,
});
const WsPersonalBotsArchiveThreadRpc = Rpc.make(WS_METHODS.personalBotsArchiveThread, {
  payload: PersonalBotArchiveThreadInput,
  success: PersonalBotThread,
  error: PersonalBotsRpcError,
});
const WsPersonalBotsPrewarmThreadRpc = Rpc.make(WS_METHODS.personalBotsPrewarmThread, {
  payload: PersonalBotPrewarmThreadInput,
  success: Schema.Struct({}),
  error: PersonalBotsRpcError,
});
const WsPersonalBotsDeleteThreadRpc = Rpc.make(WS_METHODS.personalBotsDeleteThread, {
  payload: PersonalBotDeleteThreadInput,
  success: Schema.Struct({}),
  error: PersonalBotsRpcError,
});
const WsPersonalBotsThreadShellsRpc = Rpc.make(WS_METHODS.personalBotsThreadShells, {
  payload: PersonalBotThreadShellsInput,
  success: PersonalBotThreadShellsResult,
  error: PersonalBotsRpcError,
});
const WsPersonalBotsThreadFullTextRpc = Rpc.make(WS_METHODS.personalBotsThreadFullText, {
  payload: PersonalThreadFullTextInput,
  success: PersonalThreadFullTextResult,
  error: PersonalBotsRpcError,
});
const WsPersonalBotsArchiveThreadsRpc = Rpc.make(WS_METHODS.personalBotsArchiveThreads, {
  payload: PersonalBotArchiveThreadsInput,
  success: PersonalBotThreadsBatchResult,
  error: PersonalBotsRpcError,
});
const WsPersonalBotsUpdateThreadsRpc = Rpc.make(WS_METHODS.personalBotsUpdateThreads, {
  payload: PersonalBotUpdateThreadsInput,
  success: PersonalBotThreadsBatchResult,
  error: PersonalBotsRpcError,
});
const WsPersonalBotsSearchMessagesRpc = Rpc.make(WS_METHODS.personalBotsSearchMessages, {
  payload: PersonalBotSearchMessagesInput,
  success: PersonalBotSearchMessagesResult,
  error: PersonalBotsRpcError,
});
const WsPersonalBotsWorkingProgressRpc = Rpc.make(WS_METHODS.personalBotsWorkingProgress, {
  payload: PersonalBotWorkingProgressInput,
  success: PersonalBotWorkingProgressResult,
  error: PersonalBotsRpcError,
});
const WsPersonalBotsTokenUsageRpc = Rpc.make(WS_METHODS.personalBotsTokenUsage, {
  payload: PersonalBotTokenUsageInput,
  success: PersonalBotTokenUsageResult,
  error: PersonalBotsRpcError,
});
const WsPersonalBotsDeleteThreadsRpc = Rpc.make(WS_METHODS.personalBotsDeleteThreads, {
  payload: PersonalBotDeleteThreadsInput,
  success: PersonalBotThreadsBatchResult,
  error: PersonalBotsRpcError,
});
const WsPersonalBotsGetProfileRpc = Rpc.make(WS_METHODS.personalBotsGetProfile, {
  payload: Schema.Struct({}),
  success: PersonalProfile,
  error: PersonalBotsRpcError,
});
const WsPersonalBotsSetProfileRpc = Rpc.make(WS_METHODS.personalBotsSetProfile, {
  payload: PersonalProfileSetInput,
  success: PersonalProfile,
  error: PersonalBotsRpcError,
});
// "Check again" on a provider row: refresh it and re-run the bots' test message.
const WsPersonalBotsRecheckProviderRpc = Rpc.make(WS_METHODS.personalBotsRecheckProvider, {
  payload: Schema.Struct({ instanceId: ProviderInstanceId }),
  success: Schema.Struct({}),
  error: PersonalBotsRpcError,
});
const WsPersonalBotsListFilesRpc = Rpc.make(WS_METHODS.personalBotsListFiles, {
  payload: Schema.Struct({}),
  success: PersonalFilesListResult,
  error: PersonalBotsRpcError,
});
// Bots a team lead removed (soft delete), and bringing one back. Owner only:
// no MCP tool reaches either.
const WsPersonalBotsListRemovedRpc = Rpc.make(WS_METHODS.personalBotsListRemoved, {
  payload: Schema.Struct({}),
  success: PersonalRemovedBotsListResult,
  error: PersonalBotsRpcError,
});
const WsPersonalBotsRestoreRpc = Rpc.make(WS_METHODS.personalBotsRestore, {
  payload: PersonalBotRestoreInput,
  success: PersonalBotRestoreResult,
  error: PersonalBotsRpcError,
});
const WsPersonalLeadBotChangesListRpc = Rpc.make(WS_METHODS.personalLeadBotChangesList, {
  payload: Schema.Struct({}),
  success: PersonalLeadBotChangeListResult,
  error: PersonalLeadBotChangesRpcError,
});
const WsPersonalLeadBotChangesDecideRpc = Rpc.make(WS_METHODS.personalLeadBotChangesDecide, {
  payload: PersonalLeadBotChangeDecideInput,
  success: PersonalLeadBotChange,
  error: PersonalLeadBotChangesRpcError,
});
const WsPersonalFilesDeleteRpc = Rpc.make(WS_METHODS.personalFilesDelete, {
  payload: PersonalFileDeleteInput,
  success: Schema.Struct({}),
  error: PersonalBotsRpcError,
});
const WsPersonalFilesDeleteManyRpc = Rpc.make(WS_METHODS.personalFilesDeleteMany, {
  payload: PersonalFilesDeleteManyInput,
  success: PersonalFilesBatchResult,
  error: PersonalBotsRpcError,
});
const WsPersonalVoiceCallsStartRpc = Rpc.make(WS_METHODS.personalVoiceCallsStart, {
  payload: VoiceCallStartInput,
  success: VoiceCallStartResult,
  error: PersonalVoiceCallsRpcError,
});
const WsPersonalVoiceCallsCheckKeyRpc = Rpc.make(WS_METHODS.personalVoiceCallsCheckKey, {
  payload: VoiceCallKeyCheckInput,
  success: VoiceCallKeyCheckResult,
  error: PersonalVoiceCallsRpcError,
});
const WsPersonalVoiceCallsSendRpc = Rpc.make(WS_METHODS.personalVoiceCallsSend, {
  payload: VoiceCallSendInput,
  success: VoiceCallSendResult,
  error: PersonalVoiceCallsRpcError,
});
const WsPersonalVoiceCallsFinishRpc = Rpc.make(WS_METHODS.personalVoiceCallsFinish, {
  payload: VoiceCallFinishInput,
  success: VoiceCallFinishResult,
  error: PersonalVoiceCallsRpcError,
});
const WsPersonalVoiceCallsListRpc = Rpc.make(WS_METHODS.personalVoiceCallsList, {
  payload: VoiceCallListInput,
  success: VoiceCallListResult,
  error: PersonalVoiceCallsRpcError,
});
const WsPersonalVoiceCallsLookupMemoryRpc = Rpc.make(WS_METHODS.personalVoiceCallsLookupMemory, {
  payload: VoiceCallLookupMemoryInput,
  success: VoiceCallLookupMemoryResult,
  error: PersonalVoiceCallsRpcError,
});
// A fresh pass for a call already open, without Google Search (quota), and the
// voice's own web search that replaces it.
const WsPersonalVoiceCallsRenewPassRpc = Rpc.make(WS_METHODS.personalVoiceCallsRenewPass, {
  payload: VoiceCallRenewPassInput,
  success: VoiceCallRenewPassResult,
  error: PersonalVoiceCallsRpcError,
});
const WsPersonalVoiceCallsSearchWebRpc = Rpc.make(WS_METHODS.personalVoiceCallsSearchWeb, {
  payload: VoiceCallSearchWebInput,
  success: VoiceCallSearchWebResult,
  error: PersonalVoiceCallsRpcError,
});
// The call's own chat state, bound to the call's thread rather than whatever
// chat the phone is showing, and the one card's transcript on demand.
const WsPersonalVoiceCallsSnapshotRpc = Rpc.make(WS_METHODS.personalVoiceCallsSnapshot, {
  payload: VoiceCallSnapshotInput,
  success: VoiceCallSnapshotResult,
  error: PersonalVoiceCallsRpcError,
});
const WsPersonalVoiceCallsTranscriptRpc = Rpc.make(WS_METHODS.personalVoiceCallsTranscript, {
  payload: VoiceCallTranscriptInput,
  success: VoiceCallTranscriptResult,
  error: PersonalVoiceCallsRpcError,
});
// One voice's sample clip, made once with the saved key and cached after that.
const WsPersonalVoiceCallsSampleRpc = Rpc.make(WS_METHODS.personalVoiceCallsSample, {
  payload: VoiceCallSampleInput,
  success: VoiceCallSampleResult,
  error: PersonalVoiceCallsRpcError,
});
const WsPersonalTasksListRpc = Rpc.make(WS_METHODS.personalTasksList, {
  payload: PersonalTaskListInput,
  success: PersonalTaskListResult,
  error: PersonalTasksRpcError,
});
const WsPersonalTasksGetRpc = Rpc.make(WS_METHODS.personalTasksGet, {
  payload: PersonalTaskIdInput,
  success: PersonalTaskDetail,
  error: PersonalTasksRpcError,
});
const WsPersonalTasksCreateRpc = Rpc.make(WS_METHODS.personalTasksCreate, {
  payload: PersonalTaskCreateInput,
  success: PersonalTask,
  error: PersonalTasksRpcError,
});
const WsPersonalTasksCancelRpc = Rpc.make(WS_METHODS.personalTasksCancel, {
  payload: PersonalTaskIdInput,
  success: PersonalTask,
  error: PersonalTasksRpcError,
});
const WsPersonalTasksRetryRpc = Rpc.make(WS_METHODS.personalTasksRetry, {
  payload: PersonalTaskIdInput,
  success: PersonalTask,
  error: PersonalTasksRpcError,
});
const WsPersonalTasksHistoryRpc = Rpc.make(WS_METHODS.personalTasksHistory, {
  payload: PersonalTaskHistoryInput,
  success: PersonalTaskHistoryResult,
  error: PersonalTasksRpcError,
});
const WsPersonalTasksRelatedRpc = Rpc.make(WS_METHODS.personalTasksRelated, {
  payload: PersonalTaskRelatedInput,
  success: PersonalTaskListResult,
  error: PersonalTasksRpcError,
});
const WsPersonalTasksSubscribeRpc = Rpc.make(WS_METHODS.personalTasksSubscribe, {
  payload: Schema.Struct({}),
  success: PersonalTaskStreamEvent,
  error: PersonalTasksRpcError,
  stream: true,
});
const WsPersonalGroupsListRpc = Rpc.make(WS_METHODS.personalGroupsList, {
  payload: Schema.Struct({}),
  success: PersonalGroupListResult,
  error: PersonalGroupsRpcError,
});
// The client mints both ids, so a create replayed over a flaky connection
// returns the first group instead of making a second one.
const WsPersonalGroupsCreateRpc = Rpc.make(WS_METHODS.personalGroupsCreate, {
  payload: PersonalGroupCreateInput,
  success: PersonalGroup,
  error: PersonalGroupsRpcError,
});
const WsPersonalGroupsUpdateRpc = Rpc.make(WS_METHODS.personalGroupsUpdate, {
  payload: PersonalGroupUpdateInput,
  success: PersonalGroup,
  error: PersonalGroupsRpcError,
});
// Deleting a group, plus the member bots the owner ticked. One method, not a
// second RPC: it is one user act with one confirmation and one destructive
// door, so the two halves can never be issued apart - no "bots purged but the
// group survived", and no second auth scope guarding the same destruction.
const WsPersonalGroupsDeleteRpc = Rpc.make(WS_METHODS.personalGroupsDelete, {
  payload: PersonalGroupDeleteInput,
  success: Schema.Struct({}),
  error: PersonalGroupsRpcError,
});
const WsPersonalGroupsAddMemberRpc = Rpc.make(WS_METHODS.personalGroupsAddMember, {
  payload: PersonalGroupMemberInput,
  success: PersonalGroup,
  error: PersonalGroupsRpcError,
});
const WsPersonalGroupsRemoveMemberRpc = Rpc.make(WS_METHODS.personalGroupsRemoveMember, {
  payload: PersonalGroupMemberInput,
  success: PersonalGroup,
  error: PersonalGroupsRpcError,
});
// Opens a round. The message itself lands on the group thread, so the reply
// here is the round, not the message.
const WsPersonalGroupsSendMessageRpc = Rpc.make(WS_METHODS.personalGroupsSendMessage, {
  payload: PersonalGroupSendMessageInput,
  success: PersonalGroupRound,
  error: PersonalGroupsRpcError,
});
// The owner answering a parked round. Bare, it is Continue: a fresh budget
// for a round that spent its bot turns. With `vote`, it is the approval gate
// of §V.3 - approve relays the winning option into a member's thread as its
// next instruction, reject records the refusal and lets the discussion run on.
// One method because it is one act: the round is parked and only the owner can
// unpark it, which is exactly why nothing a vote decides ever runs on its own.
const WsPersonalGroupsContinueRoundRpc = Rpc.make(WS_METHODS.personalGroupsContinueRound, {
  payload: PersonalGroupContinueRoundInput,
  success: PersonalGroupRound,
  error: PersonalGroupsRpcError,
});
const WsPersonalGroupsStopRpc = Rpc.make(WS_METHODS.personalGroupsStop, {
  payload: PersonalGroupIdInput,
  success: Schema.Struct({}),
  error: PersonalGroupsRpcError,
});
const WsPersonalGroupsSubscribeRpc = Rpc.make(WS_METHODS.personalGroupsSubscribe, {
  payload: Schema.Struct({}),
  success: PersonalGroupStreamEvent,
  error: PersonalGroupsRpcError,
  stream: true,
});
const WsPersonalSecretsListPendingRpc = Rpc.make(WS_METHODS.personalSecretsListPending, {
  payload: Schema.Struct({}),
  success: PersonalSecretsListPendingResult,
  error: PersonalSecretsRpcError,
});
const WsPersonalSecretsFulfillRpc = Rpc.make(WS_METHODS.personalSecretsFulfill, {
  payload: PersonalSecretFulfillInput,
  // The request row, never the value.
  success: PersonalSecretRequest,
  error: PersonalSecretsRpcError,
});
const WsPersonalSecretsCancelRpc = Rpc.make(WS_METHODS.personalSecretsCancel, {
  payload: PersonalSecretRequestIdInput,
  success: PersonalSecretRequest,
  error: PersonalSecretsRpcError,
});
const WsPersonalSecretsListRpc = Rpc.make(WS_METHODS.personalSecretsList, {
  payload: Schema.Struct({}),
  success: PersonalSecretsListResult,
  error: PersonalSecretsRpcError,
});
const WsPersonalSecretsCreateRpc = Rpc.make(WS_METHODS.personalSecretsCreate, {
  payload: PersonalSecretCreateInput,
  success: PersonalSecretRequest,
  error: PersonalSecretsRpcError,
});
const WsPersonalSecretsDeleteRpc = Rpc.make(WS_METHODS.personalSecretsDelete, {
  payload: PersonalSecretNameInput,
  success: Schema.Struct({ deleted: Schema.Boolean }),
  error: PersonalSecretsRpcError,
});
const WsPersonalSecretsSetSharingRpc = Rpc.make(WS_METHODS.personalSecretsSetSharing, {
  payload: PersonalSecretSharingInput,
  success: PersonalSecretsListResult,
  error: PersonalSecretsRpcError,
});
const WsPersonalSecretsSetModeRpc = Rpc.make(WS_METHODS.personalSecretsSetMode, {
  payload: PersonalSecretModeInput,
  success: PersonalSecretsListResult,
  error: PersonalSecretsRpcError,
});
const WsPersonalConnectionsListRpc = Rpc.make(WS_METHODS.personalConnectionsList, {
  payload: Schema.Struct({}),
  success: PersonalConnectionListResult,
  error: PersonalConnectionsRpcError,
});
const WsPersonalConnectionsConnectRpc = Rpc.make(WS_METHODS.personalConnectionsConnect, {
  payload: PersonalConnectionConnectInput,
  success: PersonalConnection,
  error: PersonalConnectionsRpcError,
});
const WsPersonalConnectionsValidateRpc = Rpc.make(WS_METHODS.personalConnectionsValidate, {
  payload: PersonalConnectionValidateInput,
  success: PersonalConnectionValidationResult,
  error: PersonalConnectionsRpcError,
});
const WsPersonalConnectionsDisableRpc = Rpc.make(WS_METHODS.personalConnectionsDisable, {
  payload: PersonalConnectionIdInput,
  success: PersonalConnection,
  error: PersonalConnectionsRpcError,
});
const WsPersonalConnectionsReconnectRpc = Rpc.make(WS_METHODS.personalConnectionsReconnect, {
  payload: PersonalConnectionIdInput,
  success: PersonalConnection,
  error: PersonalConnectionsRpcError,
});
const WsPersonalConnectionsDisconnectRpc = Rpc.make(WS_METHODS.personalConnectionsDisconnect, {
  payload: PersonalConnectionIdInput,
  success: PersonalConnectionDisconnectResult,
  error: PersonalConnectionsRpcError,
});
const WsPersonalConnectionsRotateRpc = Rpc.make(WS_METHODS.personalConnectionsRotate, {
  payload: PersonalConnectionRotateInput,
  success: PersonalConnection,
  error: PersonalConnectionsRpcError,
});
/**
 * Signing in to a browser-session vendor. No credential crosses the wire in
 * either direction: the server opens the site and hands the owner control.
 */
const WsPersonalConnectionsBrowserConnectRpc = Rpc.make(
  WS_METHODS.personalConnectionsBrowserConnect,
  {
    payload: PersonalConnectionBrowserConnectInput,
    success: PersonalConnectionBrowserConnectResult,
    error: PersonalConnectionsRpcError,
  },
);
/** Owner-only. No bot-facing tool may change what the owner set here. */
const WsPersonalConnectionsSetSettingsRpc = Rpc.make(WS_METHODS.personalConnectionsSetSettings, {
  payload: PersonalConnectionSettingsInput,
  success: PersonalConnection,
  error: PersonalConnectionsRpcError,
});
/** Owner-triggered only, and never from a bot: reading the machine is not a tool. */
const WsPersonalConnectionsImportProbeRpc = Rpc.make(WS_METHODS.personalConnectionsImportProbe, {
  payload: Schema.Struct({}),
  success: PersonalConnectionImportResult,
  error: PersonalConnectionsRpcError,
});
const WsPersonalConnectionsImportAdoptRpc = Rpc.make(WS_METHODS.personalConnectionsImportAdopt, {
  payload: PersonalConnectionImportAdoptInput,
  success: PersonalConnection,
  error: PersonalConnectionsRpcError,
});
const WsPersonalConnectionApprovalsListRpc = Rpc.make(WS_METHODS.personalConnectionApprovalsList, {
  payload: Schema.Struct({}),
  success: PersonalConnectionApprovalListResult,
  error: PersonalConnectionsRpcError,
});
const WsPersonalConnectionApprovalsDecideRpc = Rpc.make(
  WS_METHODS.personalConnectionApprovalsDecide,
  {
    payload: PersonalConnectionApprovalDecideInput,
    success: PersonalConnectionApproval,
    error: PersonalConnectionsRpcError,
  },
);
const WsPersonalConnectionApprovalsCancelRpc = Rpc.make(
  WS_METHODS.personalConnectionApprovalsCancel,
  {
    payload: PersonalConnectionApprovalIdInput,
    success: PersonalConnectionApproval,
    error: PersonalConnectionsRpcError,
  },
);
const WsPersonalLoginsListRpc = Rpc.make(WS_METHODS.personalLoginsList, {
  payload: Schema.Struct({}),
  success: PersonalLoginsListResult,
  error: PersonalLoginsRpcError,
});
const WsPersonalLoginsCreateRpc = Rpc.make(WS_METHODS.personalLoginsCreate, {
  payload: PersonalLoginCreateInput,
  success: PersonalLogin,
  error: PersonalLoginsRpcError,
});
const WsPersonalLoginRequestsListRpc = Rpc.make(WS_METHODS.personalLoginRequestsList, {
  payload: PersonalLoginRequestsListInput,
  success: PersonalLoginRequestsListResult,
  error: PersonalLoginsRpcError,
});
const WsPersonalLoginRequestsSubmitRpc = Rpc.make(WS_METHODS.personalLoginRequestsSubmit, {
  payload: PersonalLoginRequestsSubmitInput,
  success: PersonalLoginRequest,
  error: PersonalLoginsRpcError,
});
const WsPersonalLoginRequestsCancelRpc = Rpc.make(WS_METHODS.personalLoginRequestsCancel, {
  payload: PersonalLoginRequestsCancelInput,
  success: PersonalLoginRequest,
  error: PersonalLoginsRpcError,
});
const WsPersonalLoginsUpdateRpc = Rpc.make(WS_METHODS.personalLoginsUpdate, {
  payload: PersonalLoginUpdateInput,
  success: PersonalLogin,
  error: PersonalLoginsRpcError,
});
const WsPersonalLoginsDeleteRpc = Rpc.make(WS_METHODS.personalLoginsDelete, {
  payload: PersonalLoginDeleteInput,
  success: Schema.Struct({}),
  error: PersonalLoginsRpcError,
});
const WsPersonalLoginsDeleteManyRpc = Rpc.make(WS_METHODS.personalLoginsDeleteMany, {
  payload: PersonalLoginsDeleteManyInput,
  success: PersonalLoginsBatchResult,
  error: PersonalLoginsRpcError,
});
const WsPersonalLoginsSetSensitiveRpc = Rpc.make(WS_METHODS.personalLoginsSetSensitive, {
  payload: PersonalLoginSetSensitiveInput,
  success: PersonalLogin,
  error: PersonalLoginsRpcError,
});
const WsPersonalBrowserStatusRpc = Rpc.make(WS_METHODS.personalBrowserStatus, {
  payload: Schema.Struct({}),
  success: PersonalBrowserStatus,
  error: PersonalBrowserRpcError,
});
const WsPersonalBrowserTakeControlRpc = Rpc.make(WS_METHODS.personalBrowserTakeControl, {
  payload: Schema.Struct({}),
  success: PersonalBrowserStatus,
  error: PersonalBrowserRpcError,
});
const WsPersonalBrowserReturnToAgentRpc = Rpc.make(WS_METHODS.personalBrowserReturnToAgent, {
  payload: Schema.Struct({}),
  success: PersonalBrowserStatus,
  error: PersonalBrowserRpcError,
});
/** Lets the paused step through once; the next identical step asks again. */
const WsPersonalBrowserApproveEgressRpc = Rpc.make(WS_METHODS.personalBrowserApproveEgress, {
  payload: Schema.Struct({ threadId: ThreadId }),
  success: PersonalBrowserStatus,
  error: PersonalBrowserRpcError,
});
/** Refuses that one step; the browser, the page and other bots stay as they are. */
const WsPersonalBrowserRefuseEgressRpc = Rpc.make(WS_METHODS.personalBrowserRefuseEgress, {
  payload: Schema.Struct({ threadId: ThreadId }),
  success: PersonalBrowserStatus,
  error: PersonalBrowserRpcError,
});
/** Ends the shared browser session: tabs closed, Chrome stopped, lease released. */
const WsPersonalBrowserCloseRpc = Rpc.make(WS_METHODS.personalBrowserClose, {
  payload: Schema.Struct({}),
  success: PersonalBrowserStatus,
  error: PersonalBrowserRpcError,
});
const WsPersonalBrowserListFilesRpc = Rpc.make(WS_METHODS.personalBrowserListFiles, {
  payload: Schema.Struct({}),
  success: PersonalBrowserFilesResult,
  error: PersonalBrowserRpcError,
});
const WsPersonalBrowserActivityRpc = Rpc.make(WS_METHODS.personalBrowserActivity, {
  payload: Schema.Struct({}),
  success: PersonalBrowserStreamItem,
  error: PersonalBrowserRpcError,
  stream: true,
});
/** Current desktop status, then every change. */
const WsPersonalDesktopStatusRpc = Rpc.make(WS_METHODS.personalDesktopStatus, {
  payload: Schema.Struct({}),
  success: PersonalDesktopStatus,
  error: PersonalDesktopRpcError,
  stream: true,
});
/** The app's own stop button: same as the hotkey. */
const WsPersonalDesktopStopRpc = Rpc.make(WS_METHODS.personalDesktopStop, {
  payload: Schema.Struct({}),
  success: PersonalDesktopStatus,
  error: PersonalDesktopRpcError,
});
/** The desktop's activity timeline: recent history, then live events. */
const WsPersonalDesktopActivityRpc = Rpc.make(WS_METHODS.personalDesktopActivity, {
  payload: Schema.Struct({}),
  success: PersonalDesktopStreamItem,
  error: PersonalDesktopRpcError,
  stream: true,
});
const WsPersonalRoutinesListRpc = Rpc.make(WS_METHODS.personalRoutinesList, {
  payload: Schema.Struct({}),
  success: PersonalRoutineListResult,
  error: PersonalRoutinesRpcError,
});
const WsPersonalRoutinesCreateRpc = Rpc.make(WS_METHODS.personalRoutinesCreate, {
  payload: PersonalRoutineCreateInput,
  success: PersonalRoutine,
  error: PersonalRoutinesRpcError,
});
const WsPersonalRoutinesUpdateRpc = Rpc.make(WS_METHODS.personalRoutinesUpdate, {
  payload: PersonalRoutineUpdateInput,
  success: PersonalRoutine,
  error: PersonalRoutinesRpcError,
});
const WsPersonalRoutinesDeleteRpc = Rpc.make(WS_METHODS.personalRoutinesDelete, {
  payload: PersonalRoutineIdInput,
  success: Schema.Struct({}),
  error: PersonalRoutinesRpcError,
});
const WsPersonalRoutinesPauseRpc = Rpc.make(WS_METHODS.personalRoutinesPause, {
  payload: PersonalRoutineIdInput,
  success: PersonalRoutine,
  error: PersonalRoutinesRpcError,
});
const WsPersonalRoutinesResumeRpc = Rpc.make(WS_METHODS.personalRoutinesResume, {
  payload: PersonalRoutineIdInput,
  success: PersonalRoutine,
  error: PersonalRoutinesRpcError,
});
const WsPersonalRoutinesDeleteManyRpc = Rpc.make(WS_METHODS.personalRoutinesDeleteMany, {
  payload: PersonalRoutinesDeleteManyInput,
  success: PersonalRoutinesBatchResult,
  error: PersonalRoutinesRpcError,
});
const WsPersonalRoutinesSetEnabledManyRpc = Rpc.make(WS_METHODS.personalRoutinesSetEnabledMany, {
  payload: PersonalRoutinesSetEnabledManyInput,
  success: PersonalRoutinesBatchResult,
  error: PersonalRoutinesRpcError,
});
const WsPersonalRoutinesRunNowRpc = Rpc.make(WS_METHODS.personalRoutinesRunNow, {
  payload: PersonalRoutineRunNowInput,
  success: PersonalRoutineRunNowResult,
  error: PersonalRoutinesRpcError,
});
/** Mints a fresh hook token; the old webhook URL stops working immediately. */
const WsPersonalRoutinesRegenerateHookRpc = Rpc.make(WS_METHODS.personalRoutinesRegenerateHook, {
  payload: PersonalRoutineIdInput,
  success: PersonalRoutine,
  error: PersonalRoutinesRpcError,
});
const WsPersonalMemoryListRpc = Rpc.make(WS_METHODS.personalMemoryList, {
  payload: PersonalMemoryListInput,
  success: PersonalMemoryListResult,
  error: PersonalMemoryRpcError,
});
const WsPersonalMemorySearchRpc = Rpc.make(WS_METHODS.personalMemorySearch, {
  payload: PersonalMemorySearchInput,
  success: PersonalMemoryListResult,
  error: PersonalMemoryRpcError,
});
const WsPersonalMemoryUpdateRpc = Rpc.make(WS_METHODS.personalMemoryUpdate, {
  payload: PersonalMemoryUpdateInput,
  success: PersonalMemoryEntry,
  error: PersonalMemoryRpcError,
});
const WsPersonalMemoryDeleteRpc = Rpc.make(WS_METHODS.personalMemoryDelete, {
  payload: PersonalMemoryDeleteInput,
  success: Schema.Struct({}),
  error: PersonalMemoryRpcError,
});
const WsPersonalMemoryDeleteManyRpc = Rpc.make(WS_METHODS.personalMemoryDeleteMany, {
  payload: PersonalMemoryDeleteManyInput,
  success: PersonalMemoryBatchResult,
  error: PersonalMemoryRpcError,
});
const WsPersonalMemoryRestoreRpc = Rpc.make(WS_METHODS.personalMemoryRestore, {
  payload: PersonalMemoryRestoreInput,
  success: PersonalMemoryEntry,
  error: PersonalMemoryRpcError,
});
const WsPersonalMemoryUndoNoteRpc = Rpc.make(WS_METHODS.personalMemoryUndoNote, {
  payload: PersonalMemoryUndoNoteInput,
  success: PersonalMemoryEntry,
  error: PersonalMemoryRpcError,
});
const WsPersonalMemoryGetRpc = Rpc.make(WS_METHODS.personalMemoryGet, {
  payload: PersonalMemoryGetInput,
  success: PersonalMemoryEntry,
  error: PersonalMemoryRpcError,
});
const WsPersonalMemoryTurnContextRpc = Rpc.make(WS_METHODS.personalMemoryTurnContext, {
  payload: PersonalMemoryTurnContextInput,
  success: Schema.NullOr(PersonalMemoryTurnContext),
  error: PersonalMemoryRpcError,
});
const WsPersonalMemoryFeedbackRpc = Rpc.make(WS_METHODS.personalMemoryFeedback, {
  payload: PersonalMemoryFeedbackInput,
  success: PersonalMemoryFeedbackResult,
  error: PersonalMemoryRpcError,
});
const WsPersonalMemoryRulesUsageRpc = Rpc.make(WS_METHODS.personalMemoryRulesUsage, {
  payload: Schema.Struct({}),
  success: PersonalMemoryRulesUsage,
  error: PersonalMemoryRpcError,
});
const WsPersonalMemoryTidyLogRpc = Rpc.make(WS_METHODS.personalMemoryTidyLog, {
  payload: PersonalMemoryTidyLogInput,
  success: PersonalMemoryTidyLogResult,
  error: PersonalMemoryRpcError,
});
const WsPersonalMemoryTidySetModeRpc = Rpc.make(WS_METHODS.personalMemoryTidySetMode, {
  payload: PersonalMemoryTidySetModeInput,
  success: PersonalMemoryTidyLogResult,
  error: PersonalMemoryRpcError,
});
const WsPersonalMemoryTidyRunRpc = Rpc.make(WS_METHODS.personalMemoryTidyRun, {
  payload: PersonalMemoryTidyRunInput,
  success: PersonalMemoryTidyRun,
  error: PersonalMemoryRpcError,
});
const WsPersonalMemoryCardsRpc = Rpc.make(WS_METHODS.personalMemoryCards, {
  payload: PersonalMemoryCardsInput,
  success: PersonalMemoryCardsResult,
  error: PersonalMemoryRpcError,
});
const WsPersonalMemoryTidyDecideRpc = Rpc.make(WS_METHODS.personalMemoryTidyDecide, {
  payload: PersonalMemoryTidyDecideInput,
  success: PersonalMemoryTidyLogResult,
  error: PersonalMemoryRpcError,
});
const WsPersonalMemoryTidyUndoRpc = Rpc.make(WS_METHODS.personalMemoryTidyUndo, {
  payload: PersonalMemoryTidyUndoInput,
  success: PersonalMemoryTidyLogResult,
  error: PersonalMemoryRpcError,
});
const WsPersonalPushPublicKeyRpc = Rpc.make(WS_METHODS.personalPushPublicKey, {
  payload: Schema.Struct({}),
  success: PersonalPushPublicKeyResult,
  error: PersonalPushRpcError,
});
const WsPersonalPushGetSettingsRpc = Rpc.make(WS_METHODS.personalPushGetSettings, {
  payload: Schema.Struct({}),
  success: PersonalPushSettings,
  error: PersonalPushRpcError,
});
const WsPersonalPushSubscribeRpc = Rpc.make(WS_METHODS.personalPushSubscribe, {
  payload: PersonalPushSubscribeInput,
  success: PersonalPushSubscribeResult,
  error: PersonalPushRpcError,
});
const WsPersonalPushUnsubscribeRpc = Rpc.make(WS_METHODS.personalPushUnsubscribe, {
  payload: PersonalPushEndpointInput,
  success: Schema.Struct({}),
  error: PersonalPushRpcError,
});
const WsPersonalPushTestRpc = Rpc.make(WS_METHODS.personalPushTest, {
  payload: PersonalPushTestInput,
  success: PersonalPushTestResult,
  error: PersonalPushRpcError,
});
const WsPersonalPushSetPreferencesRpc = Rpc.make(WS_METHODS.personalPushSetPreferences, {
  payload: PersonalPushPreferences,
  success: PersonalPushPreferences,
  error: PersonalPushRpcError,
});
const WsPersonalPushReportViewingRpc = Rpc.make(WS_METHODS.personalPushReportViewing, {
  payload: PersonalPushViewingInput,
  success: Schema.Struct({}),
  error: EnvironmentAuthorizationError,
});
const WsPersonalPushReportForegroundRpc = Rpc.make(WS_METHODS.personalPushReportForeground, {
  payload: PersonalPushForegroundInput,
  success: Schema.Struct({}),
  error: EnvironmentAuthorizationError,
});
/** In-app notifications for this connection while it is in front (see PersonalPushForegroundInput). */
const WsPersonalPushInAppRpc = Rpc.make(WS_METHODS.personalPushInApp, {
  payload: Schema.Struct({}),
  success: PersonalPushInAppNotification,
  error: EnvironmentAuthorizationError,
  stream: true,
});
const WsPersonalPushAckInAppRpc = Rpc.make(WS_METHODS.personalPushAckInApp, {
  payload: PersonalPushInAppAckInput,
  success: Schema.Struct({}),
  error: EnvironmentAuthorizationError,
});
/**
 * The personal side of the app: bots and their threads, files, tasks, groups,
 * secrets, logins, the browser, routines, memory and push.
 */
export const WsPersonalRpcGroup = RpcGroup.make(
  WsPersonalBotsListRpc,
  WsPersonalBotsThreadShellsRpc,
  WsPersonalBotsThreadFullTextRpc,
  WsPersonalBotsCreateRpc,
  WsPersonalBotsUpdateRpc,
  WsPersonalBotsDeleteRpc,
  WsPersonalBotsCreateThreadRpc,
  WsPersonalBotsArchiveThreadRpc,
  WsPersonalBotsDeleteThreadRpc,
  WsPersonalBotsArchiveThreadsRpc,
  WsPersonalBotsUpdateThreadsRpc,
  WsPersonalBotsSearchMessagesRpc,
  WsPersonalBotsWorkingProgressRpc,
  WsPersonalBotsTokenUsageRpc,
  WsPersonalBotsDeleteThreadsRpc,
  WsPersonalBotsPrewarmThreadRpc,
  WsPersonalBotsGetProfileRpc,
  WsPersonalBotsSetProfileRpc,
  WsPersonalBotsListFilesRpc,
  WsPersonalBotsRecheckProviderRpc,
  WsPersonalBotsListRemovedRpc,
  WsPersonalBotsRestoreRpc,
  WsPersonalVoiceCallsStartRpc,
  WsPersonalVoiceCallsCheckKeyRpc,
  WsPersonalVoiceCallsSendRpc,
  WsPersonalVoiceCallsFinishRpc,
  WsPersonalVoiceCallsListRpc,
  WsPersonalVoiceCallsLookupMemoryRpc,
  WsPersonalVoiceCallsRenewPassRpc,
  WsPersonalVoiceCallsSearchWebRpc,
  WsPersonalVoiceCallsSnapshotRpc,
  WsPersonalVoiceCallsTranscriptRpc,
  WsPersonalVoiceCallsSampleRpc,
  WsPersonalLeadBotChangesListRpc,
  WsPersonalLeadBotChangesDecideRpc,
  WsPersonalFilesDeleteRpc,
  WsPersonalFilesDeleteManyRpc,
  WsPersonalTasksListRpc,
  WsPersonalTasksGetRpc,
  WsPersonalTasksCreateRpc,
  WsPersonalTasksCancelRpc,
  WsPersonalTasksRetryRpc,
  WsPersonalTasksSubscribeRpc,
  WsPersonalTasksHistoryRpc,
  WsPersonalTasksRelatedRpc,
  WsPersonalGroupsListRpc,
  WsPersonalGroupsCreateRpc,
  WsPersonalGroupsUpdateRpc,
  WsPersonalGroupsDeleteRpc,
  WsPersonalGroupsAddMemberRpc,
  WsPersonalGroupsRemoveMemberRpc,
  WsPersonalGroupsSendMessageRpc,
  WsPersonalGroupsContinueRoundRpc,
  WsPersonalGroupsStopRpc,
  WsPersonalGroupsSubscribeRpc,
  WsPersonalSecretsListPendingRpc,
  WsPersonalSecretsFulfillRpc,
  WsPersonalSecretsCancelRpc,
  WsPersonalSecretsListRpc,
  WsPersonalSecretsCreateRpc,
  WsPersonalSecretsDeleteRpc,
  WsPersonalSecretsSetSharingRpc,
  WsPersonalSecretsSetModeRpc,
  WsPersonalConnectionsListRpc,
  WsPersonalConnectionsConnectRpc,
  WsPersonalConnectionsValidateRpc,
  WsPersonalConnectionsDisableRpc,
  WsPersonalConnectionsReconnectRpc,
  WsPersonalConnectionsDisconnectRpc,
  WsPersonalConnectionsRotateRpc,
  WsPersonalConnectionsBrowserConnectRpc,
  WsPersonalConnectionsSetSettingsRpc,
  WsPersonalConnectionsImportProbeRpc,
  WsPersonalConnectionsImportAdoptRpc,
  WsPersonalConnectionApprovalsListRpc,
  WsPersonalConnectionApprovalsDecideRpc,
  WsPersonalConnectionApprovalsCancelRpc,
  WsPersonalLoginsListRpc,
  WsPersonalLoginRequestsListRpc,
  WsPersonalLoginRequestsSubmitRpc,
  WsPersonalLoginRequestsCancelRpc,
  WsPersonalLoginsCreateRpc,
  WsPersonalLoginsUpdateRpc,
  WsPersonalLoginsDeleteRpc,
  WsPersonalLoginsSetSensitiveRpc,
  WsPersonalLoginsDeleteManyRpc,
  // personal browser
  WsPersonalBrowserStatusRpc,
  WsPersonalBrowserTakeControlRpc,
  WsPersonalBrowserReturnToAgentRpc,
  WsPersonalBrowserCloseRpc,
  WsPersonalBrowserListFilesRpc,
  WsPersonalBrowserActivityRpc,
  WsPersonalBrowserApproveEgressRpc,
  WsPersonalBrowserRefuseEgressRpc,
  WsPersonalDesktopStatusRpc,
  WsPersonalDesktopStopRpc,
  WsPersonalDesktopActivityRpc,
  WsPersonalRoutinesListRpc,
  WsPersonalRoutinesCreateRpc,
  WsPersonalRoutinesUpdateRpc,
  WsPersonalRoutinesDeleteRpc,
  WsPersonalRoutinesPauseRpc,
  WsPersonalRoutinesResumeRpc,
  WsPersonalRoutinesDeleteManyRpc,
  WsPersonalRoutinesSetEnabledManyRpc,
  WsPersonalRoutinesRunNowRpc,
  WsPersonalRoutinesRegenerateHookRpc,
  WsPersonalMemoryListRpc,
  WsPersonalMemorySearchRpc,
  WsPersonalMemoryUpdateRpc,
  WsPersonalMemoryDeleteRpc,
  WsPersonalMemoryDeleteManyRpc,
  WsPersonalMemoryRestoreRpc,
  WsPersonalMemoryUndoNoteRpc,
  WsPersonalMemoryGetRpc,
  WsPersonalMemoryRulesUsageRpc,
  WsPersonalMemoryTurnContextRpc,
  WsPersonalMemoryFeedbackRpc,
  WsPersonalMemoryTidyLogRpc,
  WsPersonalMemoryTidySetModeRpc,
  WsPersonalMemoryTidyRunRpc,
  WsPersonalMemoryTidyDecideRpc,
  WsPersonalMemoryTidyUndoRpc,
  WsPersonalMemoryCardsRpc,
  WsPersonalPushPublicKeyRpc,
  WsPersonalPushGetSettingsRpc,
  WsPersonalPushSubscribeRpc,
  WsPersonalPushUnsubscribeRpc,
  WsPersonalPushTestRpc,
  WsPersonalPushSetPreferencesRpc,
  WsPersonalPushReportViewingRpc,
  WsPersonalPushReportForegroundRpc,
  WsPersonalPushInAppRpc,
  WsPersonalPushAckInAppRpc,
);
