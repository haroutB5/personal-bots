import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ProviderAuthCancelInput,
  ProviderAuthCompleteInput,
  ProviderAuthState,
  ProviderAuthStartInput,
  ProviderAuthRespondInput,
  ProviderInstallCancelInput,
  ProviderInstallState,
  ProviderSetupError,
  ProviderSetupInput,
} from "./providerSetup.ts";

import { ExternalLauncherError, LaunchEditorInput } from "./editor.ts";
import {
  AuthAccessStreamError,
  AuthAccessStreamEvent,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import {
  BackgroundPolicySnapshot,
  ClientActivityReportInput,
  HostPowerSnapshot,
} from "./background.ts";
import {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  FilesystemBrowseError,
} from "./filesystem.ts";
import {
  AgentSessionImportInput,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionImportResult,
  AgentSessionScanInput,
  AgentSessionScanResult,
  AgentSessionScanError,
} from "./agentSessions.ts";
import {
  AssetAccessError,
  AssetCreateUrlInput,
  AssetCreateUrlResult,
  AttachmentCreateUploadUrlInput,
  AttachmentCreateUploadUrlResult,
  AttachmentDeleteInput,
  AttachmentUploadSigningKeyError,
} from "./assets.ts";
import {
  WorktreeSetupCancelInput,
  WorktreeSetupCancelResult,
  WorktreeSetupStreamEvent,
  WorktreeSetupSubscribeInput,
} from "./worktreeSetup.ts";
import {
  GitActionProgressEvent,
  VcsSwitchRefInput,
  VcsSwitchRefResult,
  GitCommandError,
  VcsCreateRefInput,
  VcsCreateRefResult,
  VcsCreateWorktreeInput,
  VcsCreateWorktreeResult,
  VcsInitInput,
  VcsListRefsInput,
  VcsListRefsResult,
  GitManagerServiceError,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  VcsPullInput,
  GitPullRequestRefInput,
  VcsPullResult,
  VcsRemoveWorktreeInput,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  VcsStatusInput,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "./git.ts";
import {
  ReviewDiffFileContentsInput,
  ReviewDiffFileContentsResult,
  ReviewDiffPreviewError,
  ReviewDiffPreviewInput,
  ReviewDiffPreviewResult,
} from "./review.ts";
import { KeybindingsConfigError } from "./keybindings.ts";
import {
  ClientOrchestrationCommand,
  ORCHESTRATION_WS_METHODS,
  OrchestrationDispatchCommandError,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetSnapshotError,
  OrchestrationSearchThreadsError,
  OrchestrationSearchThreadsInput,
  OrchestrationGetTurnDiffError,
  OrchestrationGetTurnDiffInput,
  OrchestrationRpcSchemas,
  OrchestrationGetWorkflowScriptError,
} from "./orchestration.ts";
import {
  ProviderUploadFeedbackError,
  ProviderUploadFeedbackInput,
  ProviderUploadFeedbackResult,
} from "./provider.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  PullRequestActionInput,
  PullRequestActivity,
  PullRequestCommentInput,
  PullRequestCommentUpdateInput,
  PullRequestDetail,
  PullRequestPreview,
  PullRequestDiffFileContentsInput,
  PullRequestDiffFileContentsResult,
  PullRequestFilesViewedResult,
  PullRequestInvalidateInput,
  PullRequestListInput,
  PullRequestListResult,
  PullRequestListStatsInput,
  PullRequestListStatsResult,
  PullRequestOperationError,
  PullRequestReactionInput,
  PullRequestRef,
  PullRequestRoutingResult,
  PullRequestRoutingIdentityInput,
  PullRequestRoutingIdentityResult,
  PullRequestStack,
  PullRequestLinkedThreadsResult,
  PullRequestSummary,
  PullRequestReviewerCandidateList,
  PullRequestReviewerRequestInput,
  PullRequestLabelCandidateList,
  PullRequestLabelChangeInput,
  PullRequestSetFilesViewedInput,
  PullRequestSubmitReviewInput,
  PullRequestThreadCommentsInput,
  PullRequestThreadCommentsResult,
  PullRequestThreadReplyInput,
  PullRequestThreadResolutionInput,
  PullRequestUnavailableError,
  PullRequestUpdateInput,
} from "./pullRequest.ts";
import {
  RelayClientInstallFailedError,
  RelayClientInstallProgressEventSchema,
  RelayClientStatusSchema,
} from "./relayClient.ts";
import {
  ProjectListEntriesError,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectReadFileError,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectSearchContentsError,
  ProjectSearchContentsInput,
  ProjectSearchContentsResult,
  ProjectSearchEntriesError,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileError,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project.ts";
import {
  TerminalAttachInput,
  TerminalAttachStreamEvent,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalError,
  TerminalEvent,
  TerminalMetadataStreamEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal.ts";
import {
  DiscoveredLocalServerList,
  ConfiguredLocalServerUrls,
  PreviewCloseInput,
  PreviewError,
  PreviewEvent,
  PreviewListInput,
  PreviewListResult,
  PreviewNavigateInput,
  PreviewOpenInput,
  PreviewRefreshInput,
  PreviewReportStatusInput,
  PreviewResizeInput,
  PreviewSessionSnapshot,
} from "./preview.ts";
import {
  DeviceActionInput,
  DeviceCloseInput,
  DeviceConfigureInput,
  DeviceDetail,
  DeviceDetailInput,
  DeviceError,
  DeviceListInput,
  SshDeviceHostConfig,
  DeviceHostSummary,
  DeviceOpenInput,
  DeviceServiceState,
  DeviceSession,
  DeviceShutdownInput,
} from "./device.ts";
import {
  PreviewAutomationError,
  PreviewAutomationHost,
  PreviewAutomationHostFocus,
  PreviewAutomationResponse,
  PreviewAutomationStreamEvent,
} from "./previewAutomation.ts";
import {
  ServerConfigStreamEvent,
  DesktopUpdateCommitInput,
  ServerConfig,
  ServerProviderUpdateError,
  ServerProviderUpdateInput,
  ServerLifecycleStreamEvent,
  ServerRemoveKeybindingInput,
  ServerRemoveKeybindingResult,
  ServerProviderUpdatedPayload,
  ServerSelfUpdateError,
  ServerSelfUpdateInput,
  ServerSelfUpdateProgressEvent,
  ServerSelfUpdateResult,
  ServerTraceDiagnosticsResult,
  ServerProcessDiagnosticsResult,
  ServerProcessResourceHistoryInput,
  ServerProcessResourceHistoryResult,
  ServerSignalProcessInput,
  ServerSignalProcessResult,
  ServerUpsertKeybindingInput,
  ServerUpsertKeybindingResult,
} from "./server.ts";
import {
  HostResourcesSnapshot,
  ResourceTelemetryHistory,
  ResourceTelemetryHistoryInput,
  ResourceTelemetryRetryResult,
  ResourceTelemetrySnapshot,
} from "./resourceTelemetry.ts";
import {
  UsageLimitSourceError,
  ProviderConsumeResetCreditInput,
  ProviderConsumeResetCreditResult,
} from "./providerUsageLimits.ts";
import { UsagePricing, UsageReadError, UsageSummary, UsageSummaryInput } from "./usage.ts";
import { ServerSettings, ServerSettingsError, ServerSettingsPatch } from "./settings.ts";
import {
  ProjectCloneActionInput,
  ProjectCloneActionResult,
  ProjectCloneListEvent,
  ProjectCloneStartInput,
  ProjectCloneStartResult,
  ProjectCloneSubscribeInput,
} from "./projectClone.ts";
import {
  SourceControlCloneRepositoryInput,
  SourceControlCloneRepositoryResult,
  SourceControlDiscoveryResult,
  SourceControlPublishRepositoryInput,
  SourceControlPublishRepositoryResult,
  SourceControlRepositoryError,
  SourceControlRepositoryInfo,
  SourceControlRepositoryLookupInput,
} from "./sourceControl.ts";
import {
  PersonalBot,
  PersonalBotArchiveThreadInput,
  PersonalBotPrewarmThreadInput,
  PersonalBotCreateInput,
  PersonalBotCreateThreadInput,
  PersonalBotDeleteInput,
  PersonalBotDeleteThreadInput,
  PersonalBotsError,
  PersonalBotsListResult,
  PersonalBotThread,
  PersonalFileDeleteInput,
  PersonalFilesListResult,
  PersonalBotUpdateInput,
  PersonalProfile,
  PersonalProfileSetInput,
} from "./personalBots.ts";
import {
  PersonalTask,
  PersonalTaskCreateInput,
  PersonalTaskDetail,
  PersonalTaskHistoryInput,
  PersonalTaskHistoryResult,
  PersonalTaskRelatedInput,
  PersonalTaskIdInput,
  PersonalTaskListInput,
  PersonalTaskListResult,
  PersonalTasksError,
  PersonalTaskStreamEvent,
} from "./personalTasks.ts";
import {
  PersonalGroup,
  PersonalGroupCreateInput,
  PersonalGroupContinueRoundInput,
  PersonalGroupDeleteInput,
  PersonalGroupIdInput,
  PersonalGroupListResult,
  PersonalGroupMemberInput,
  PersonalGroupRound,
  PersonalGroupSendMessageInput,
  PersonalGroupsError,
  PersonalGroupStreamEvent,
  PersonalGroupUpdateInput,
} from "./personalGroups.ts";
import {
  PersonalSecretFulfillInput,
  PersonalSecretNameInput,
  PersonalSecretSharingInput,
  PersonalSecretRequest,
  PersonalSecretRequestIdInput,
  PersonalSecretsError,
  PersonalSecretsListPendingResult,
  PersonalSecretsListResult,
  PersonalSecretCreateInput,
} from "./personalSecrets.ts";
import {
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
  PersonalConnectionsError,
  PersonalConnectionValidateInput,
  PersonalConnectionValidationResult,
  PersonalConnectionBrowserConnectInput,
  PersonalConnectionBrowserConnectResult,
  PersonalConnectionSettingsInput,
} from "./personalConnections.ts";
import {
  PersonalLogin,
  PersonalLoginCreateInput,
  PersonalLoginDeleteInput,
  PersonalLoginsError,
  PersonalLoginsListResult,
  PersonalLoginUpdateInput,
  PersonalLoginSetSensitiveInput,
} from "./personalLogins.ts";
import { PersonalDesktopError, PersonalDesktopStatus } from "./personalDesktop.ts";
// personal browser
import {
  PersonalBrowserError,
  PersonalBrowserFilesResult,
  PersonalBrowserStatus,
  PersonalBrowserStreamItem,
} from "./personalBrowser.ts";
import {
  PersonalRoutine,
  PersonalRoutineCreateInput,
  PersonalRoutineIdInput,
  PersonalRoutineListResult,
  PersonalRoutineRunNowInput,
  PersonalRoutineRunNowResult,
  PersonalRoutinesError,
  PersonalRoutineUpdateInput,
} from "./personalRoutines.ts";
import {
  PersonalMemoryDeleteInput,
  PersonalMemoryEntry,
  PersonalMemoryError,
  PersonalMemoryListInput,
  PersonalMemoryListResult,
  PersonalMemorySearchInput,
  PersonalMemoryUpdateInput,
} from "./personalMemory.ts";
import {
  PersonalPushEndpointInput,
  PersonalPushError,
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
import { VcsError } from "./vcs.ts";

export const WS_METHODS = {
  // Project registry methods
  projectsList: "projects.list",
  projectsAdd: "projects.add",
  projectsRemove: "projects.remove",
  projectsListEntries: "projects.listEntries",
  projectsReadFile: "projects.readFile",
  projectsSearchContents: "projects.searchContents",
  projectsSearchEntries: "projects.searchEntries",
  projectsWriteFile: "projects.writeFile",

  // Shell methods
  shellOpenInEditor: "shell.openInEditor",

  // Filesystem methods
  filesystemBrowse: "filesystem.browse",
  agentSessionsScan: "agentSessions.scan",
  agentSessionsImport: "agentSessions.import",
  assetsCreateUrl: "assets.createUrl",
  attachmentsCreateUploadUrl: "attachments.createUploadUrl",
  attachmentsDelete: "attachments.delete",

  // Provider methods
  providerUploadFeedback: "provider.uploadFeedback",
  providerAuthStart: "provider.auth.start",
  providerConsumeResetCredit: "provider.consumeResetCredit",
  providerAuthComplete: "provider.auth.complete",
  providerAuthRespond: "provider.auth.respond",
  providerAuthCancel: "provider.auth.cancel",
  providerAuthLogout: "provider.auth.logout",
  providerAuthSubscribe: "provider.auth.subscribe",
  providerInstallStart: "provider.install.start",
  providerInstallCancel: "provider.install.cancel",
  providerInstallSubscribe: "provider.install.subscribe",
  providerInstallRemove: "provider.install.remove",

  // VCS methods
  vcsPull: "vcs.pull",
  vcsRefreshStatus: "vcs.refreshStatus",
  vcsListRefs: "vcs.listRefs",
  vcsCreateWorktree: "vcs.createWorktree",
  vcsRemoveWorktree: "vcs.removeWorktree",
  vcsCreateRef: "vcs.createRef",
  vcsSwitchRef: "vcs.switchRef",
  vcsInit: "vcs.init",

  // Git workflow methods
  gitRunStackedAction: "git.runStackedAction",
  gitResolvePullRequest: "git.resolvePullRequest",
  gitPreparePullRequestThread: "git.preparePullRequestThread",

  // Review methods
  reviewGetDiffPreview: "review.getDiffPreview",
  reviewGetDiffFileContents: "review.getDiffFileContents",

  // Terminal methods
  terminalOpen: "terminal.open",
  terminalAttach: "terminal.attach",
  terminalWrite: "terminal.write",
  terminalResize: "terminal.resize",
  terminalClear: "terminal.clear",
  terminalRestart: "terminal.restart",
  terminalClose: "terminal.close",

  // Preview methods
  previewOpen: "preview.open",
  previewNavigate: "preview.navigate",
  previewResize: "preview.resize",
  previewRefresh: "preview.refresh",
  previewClose: "preview.close",
  previewList: "preview.list",
  previewReportStatus: "preview.reportStatus",
  previewAutomationConnect: "previewAutomation.connect",
  previewAutomationRespond: "previewAutomation.respond",
  previewAutomationFocusHost: "previewAutomation.focusHost",

  // Device methods
  deviceConfigure: "device.configure",
  deviceList: "device.list",
  deviceTestHost: "device.testHost",
  deviceOpen: "device.open",
  deviceClose: "device.close",
  deviceShutdown: "device.shutdown",
  deviceDetail: "device.detail",
  deviceAction: "device.action",

  // Server meta
  serverProbe: "server.probe",
  serverGetConfig: "server.getConfig",
  serverRefreshProviders: "server.refreshProviders",
  serverUpdateProvider: "server.updateProvider",
  serverUpdateServer: "server.updateServer",
  serverUpdateServerWithProgress: "server.updateServerWithProgress",
  serverCommitDesktopUpdate: "server.commitDesktopUpdate",
  serverUpsertKeybinding: "server.upsertKeybinding",
  serverRemoveKeybinding: "server.removeKeybinding",
  serverGetSettings: "server.getSettings",
  serverUpdateSettings: "server.updateSettings",
  serverDiscoverSourceControl: "server.discoverSourceControl",
  serverGetTraceDiagnostics: "server.getTraceDiagnostics",
  serverGetProcessDiagnostics: "server.getProcessDiagnostics",
  serverGetHostResources: "server.getHostResources",
  serverGetProcessResourceHistory: "server.getProcessResourceHistory",
  serverGetResourceTelemetryHistory: "server.getResourceTelemetryHistory",
  serverRetryResourceTelemetry: "server.retryResourceTelemetry",
  serverSignalProcess: "server.signalProcess",
  serverReportClientActivity: "server.reportClientActivity",
  serverReportHostPowerState: "server.reportHostPowerState",
  serverGetBackgroundPolicy: "server.getBackgroundPolicy",
  serverGetUsageSummary: "server.getUsageSummary",
  serverRefreshUsageRates: "server.refreshUsageRates",

  // Cloud environment methods
  cloudGetRelayClientStatus: "cloud.getRelayClientStatus",
  cloudInstallRelayClient: "cloud.installRelayClient",

  // Pull request methods
  pullRequestsList: "pullRequests.list",
  pullRequestsListStats: "pullRequests.listStats",
  pullRequestsSummary: "pullRequests.summary",
  pullRequestsRouting: "pullRequests.routing",
  pullRequestsRoutingIdentity: "pullRequests.routingIdentity",
  pullRequestsStack: "pullRequests.stack",
  pullRequestsLinkedThreads: "pullRequests.linkedThreads",
  pullRequestsDetail: "pullRequests.detail",
  pullRequestsPreview: "pullRequests.preview",
  pullRequestsActivity: "pullRequests.activity",
  pullRequestsThreadComments: "pullRequests.threadComments",
  pullRequestsDiffFileContents: "pullRequests.diffFileContents",
  pullRequestsFilesViewed: "pullRequests.filesViewed",
  pullRequestsSetFilesViewed: "pullRequests.setFilesViewed",
  pullRequestsRunAction: "pullRequests.runAction",
  pullRequestsUpdate: "pullRequests.update",
  pullRequestsComment: "pullRequests.comment",
  pullRequestsUpdateComment: "pullRequests.updateComment",
  pullRequestsSubmitReview: "pullRequests.submitReview",
  pullRequestsReplyToThread: "pullRequests.replyToThread",
  pullRequestsSetThreadResolution: "pullRequests.setThreadResolution",
  pullRequestsSetReaction: "pullRequests.setReaction",
  pullRequestsInvalidate: "pullRequests.invalidate",
  pullRequestsSubscribeRefreshes: "pullRequests.subscribeRefreshes",
  pullRequestsReviewerCandidates: "pullRequests.reviewerCandidates",
  pullRequestsRequestReviewers: "pullRequests.requestReviewers",
  pullRequestsLabelCandidates: "pullRequests.labelCandidates",
  pullRequestsSetLabels: "pullRequests.setLabels",

  // Source control methods
  sourceControlLookupRepository: "sourceControl.lookupRepository",
  sourceControlCloneRepository: "sourceControl.cloneRepository",
  sourceControlPublishRepository: "sourceControl.publishRepository",
  projectCloneStart: "projectClone.start",
  projectCloneCancel: "projectClone.cancel",
  projectCloneRetry: "projectClone.retry",
  subscribeProjectClones: "subscribeProjectClones",

  // Personal bots methods
  personalBotsList: "personalBots.list",
  personalBotsCreate: "personalBots.create",
  personalBotsUpdate: "personalBots.update",
  personalBotsDelete: "personalBots.delete",
  personalBotsCreateThread: "personalBots.createThread",
  personalBotsArchiveThread: "personalBots.archiveThread",
  personalBotsDeleteThread: "personalBots.deleteThread",
  personalBotsPrewarmThread: "personalBots.prewarmThread",
  personalBotsGetProfile: "personalBots.getProfile",
  personalBotsSetProfile: "personalBots.setProfile",
  personalBotsListFiles: "personalBots.listFiles",
  personalBotsRecheckProvider: "personalBots.recheckProvider",
  personalFilesDelete: "personalFiles.delete",

  // Personal tasks methods
  personalTasksList: "personalTasks.list",
  personalTasksGet: "personalTasks.get",
  personalTasksCreate: "personalTasks.create",
  personalTasksCancel: "personalTasks.cancel",
  personalTasksRetry: "personalTasks.retry",
  personalTasksSubscribe: "personalTasks.subscribe",
  personalTasksHistory: "personalTasks.history",
  personalTasksRelated: "personalTasks.related",

  // Personal group chats. `subscribe` streams group and round STATE only; the
  // transcript arrives on the group thread's ordinary thread-detail
  // subscription, so a phone holds one subscription for the conversation.
  personalGroupsList: "personalGroups.list",
  personalGroupsCreate: "personalGroups.create",
  personalGroupsUpdate: "personalGroups.update",
  personalGroupsDelete: "personalGroups.delete",
  personalGroupsAddMember: "personalGroups.addMember",
  personalGroupsRemoveMember: "personalGroups.removeMember",
  personalGroupsSendMessage: "personalGroups.sendMessage",
  personalGroupsContinueRound: "personalGroups.continueRound",
  personalGroupsStop: "personalGroups.stop",
  personalGroupsSubscribe: "personalGroups.subscribe",

  // Personal secrets methods (values are write-only: no method returns one)
  personalSecretsListPending: "personalSecrets.listPending",
  personalSecretsFulfill: "personalSecrets.fulfill",
  personalSecretsCancel: "personalSecrets.cancel",
  personalSecretsList: "personalSecrets.list",
  personalSecretsCreate: "personalSecrets.create",
  personalSecretsDelete: "personalSecrets.delete",
  personalSecretsSetSharing: "personalSecrets.setSharing",

  // Owner-managed service connections. Credential fields are write-only.
  personalConnectionsList: "personalConnections.list",
  personalConnectionsConnect: "personalConnections.connect",
  personalConnectionsValidate: "personalConnections.validate",
  personalConnectionsDisable: "personalConnections.disable",
  personalConnectionsReconnect: "personalConnections.reconnect",
  personalConnectionsDisconnect: "personalConnections.disconnect",
  personalConnectionsRotate: "personalConnections.rotate",
  personalConnectionsBrowserConnect: "personalConnections.browserConnect",
  personalConnectionsSetSettings: "personalConnections.setSettings",
  personalConnectionsImportProbe: "personalConnections.importProbe",
  personalConnectionsImportAdopt: "personalConnections.importAdopt",

  // Owner decisions about what a bot asked a connection to do.
  personalConnectionApprovalsList: "personalConnectionApprovals.list",
  personalConnectionApprovalsDecide: "personalConnectionApprovals.decide",
  personalConnectionApprovalsCancel: "personalConnectionApprovals.cancel",

  // Personal saved logins (passwords are write-only and never appear in results)
  personalLoginsList: "personalLogins.list",
  personalLoginsCreate: "personalLogins.create",
  personalLoginsUpdate: "personalLogins.update",
  personalLoginsDelete: "personalLogins.delete",
  personalLoginsSetSensitive: "personalLogins.setSensitive",

  // personal browser
  personalBrowserStatus: "personalBrowser.status",
  personalBrowserTakeControl: "personalBrowser.takeControl",
  personalBrowserReturnToAgent: "personalBrowser.returnToAgent",
  personalBrowserClose: "personalBrowser.close",
  personalBrowserListFiles: "personalBrowser.listFiles",
  personalBrowserActivity: "personalBrowser.activity",
  // personal desktop (the user's real PC)
  personalDesktopStatus: "personalDesktop.status",
  personalDesktopStop: "personalDesktop.stop",
  // Personal routines methods
  personalRoutinesList: "personalRoutines.list",
  personalRoutinesCreate: "personalRoutines.create",
  personalRoutinesUpdate: "personalRoutines.update",
  personalRoutinesDelete: "personalRoutines.delete",
  personalRoutinesPause: "personalRoutines.pause",
  personalRoutinesResume: "personalRoutines.resume",
  personalRoutinesRunNow: "personalRoutines.runNow",
  personalRoutinesRegenerateHook: "personalRoutines.regenerateHook",

  // Personal memory methods
  personalMemoryList: "personalMemory.list",
  personalMemorySearch: "personalMemory.search",
  personalMemoryUpdate: "personalMemory.update",
  personalMemoryDelete: "personalMemory.delete",

  // Personal Web Push methods
  personalPushPublicKey: "personalPush.publicKey",
  personalPushGetSettings: "personalPush.getSettings",
  personalPushSubscribe: "personalPush.subscribe",
  personalPushUnsubscribe: "personalPush.unsubscribe",
  personalPushTest: "personalPush.test",
  personalPushSetPreferences: "personalPush.setPreferences",
  personalPushReportViewing: "personalPush.reportViewing",
  personalPushReportForeground: "personalPush.reportForeground",
  personalPushInApp: "personalPush.inApp",
  personalPushAckInApp: "personalPush.ackInApp",

  // Streaming subscriptions
  subscribeVcsStatus: "subscribeVcsStatus",
  subscribeWorktreeSetup: "subscribeWorktreeSetup",
  worktreeSetupCancel: "worktreeSetup.cancel",
  subscribeTerminalEvents: "subscribeTerminalEvents",
  subscribeTerminalMetadata: "subscribeTerminalMetadata",
  subscribePreviewEvents: "subscribePreviewEvents",
  subscribeDiscoveredLocalServers: "subscribeDiscoveredLocalServers",
  subscribeDeviceState: "subscribeDeviceState",
  subscribeServerConfig: "subscribeServerConfig",
  subscribeServerLifecycle: "subscribeServerLifecycle",
  subscribeAuthAccess: "subscribeAuthAccess",
  subscribeBackgroundPolicy: "subscribeBackgroundPolicy",
  subscribeResourceTelemetry: "subscribeResourceTelemetry",
} as const;

const WsServerUpsertKeybindingRpc = Rpc.make(WS_METHODS.serverUpsertKeybinding, {
  payload: ServerUpsertKeybindingInput,
  success: ServerUpsertKeybindingResult,
  error: Schema.Union([KeybindingsConfigError, EnvironmentAuthorizationError]),
});

const WsServerRemoveKeybindingRpc = Rpc.make(WS_METHODS.serverRemoveKeybinding, {
  payload: ServerRemoveKeybindingInput,
  success: ServerRemoveKeybindingResult,
  error: Schema.Union([KeybindingsConfigError, EnvironmentAuthorizationError]),
});

const WsServerProbeRpc = Rpc.make(WS_METHODS.serverProbe, {
  payload: Schema.Struct({}),
  success: Schema.Struct({}),
  error: EnvironmentAuthorizationError,
});

const WsServerGetConfigRpc = Rpc.make(WS_METHODS.serverGetConfig, {
  payload: Schema.Struct({}),
  success: ServerConfig,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError, EnvironmentAuthorizationError]),
});

const WsServerRefreshProvidersRpc = Rpc.make(WS_METHODS.serverRefreshProviders, {
  payload: Schema.Struct({
    /**
     * When supplied, only refresh this specific provider instance. When
     * omitted, refresh all configured instances — the legacy `refresh()`
     * behaviour retained for transports that still dispatch untargeted
     * refreshes.
     */
    instanceId: Schema.optional(ProviderInstanceId),
    cwd: Schema.optional(TrimmedNonEmptyString),
    /** Explicit user request: bypass T3-owned caches and rediscover models.
     * Background status refreshes must not open agent sessions. */
    refreshModels: Schema.optional(Schema.Boolean),
    /** Explicit user request from a usage view: re-read subscription limits
     * instead of reusing a cached probe. Cheaper than `refreshModels`. */
    refreshUsage: Schema.optional(Schema.Boolean),
  }),
  success: ServerProviderUpdatedPayload,
  error: Schema.Union([EnvironmentAuthorizationError, ProviderSetupError]),
});

const WsServerUpdateProviderRpc = Rpc.make(WS_METHODS.serverUpdateProvider, {
  payload: ServerProviderUpdateInput,
  success: ServerProviderUpdatedPayload,
  error: Schema.Union([ServerProviderUpdateError, EnvironmentAuthorizationError]),
});

const ProviderSetupRpcError = Schema.Union([ProviderSetupError, EnvironmentAuthorizationError]);

const WsProviderConsumeResetCreditRpc = Rpc.make(WS_METHODS.providerConsumeResetCredit, {
  payload: ProviderConsumeResetCreditInput,
  success: ProviderConsumeResetCreditResult,
  error: Schema.Union([ProviderSetupError, UsageLimitSourceError, EnvironmentAuthorizationError]),
});

const WsProviderAuthStartRpc = Rpc.make(WS_METHODS.providerAuthStart, {
  payload: ProviderAuthStartInput,
  success: ProviderAuthState,
  error: ProviderSetupRpcError,
});

const WsProviderAuthRespondRpc = Rpc.make(WS_METHODS.providerAuthRespond, {
  payload: ProviderAuthRespondInput,
  success: ProviderAuthState,
  error: ProviderSetupRpcError,
});

const WsProviderAuthCompleteRpc = Rpc.make(WS_METHODS.providerAuthComplete, {
  payload: ProviderAuthCompleteInput,
  success: ProviderAuthState,
  error: ProviderSetupRpcError,
});

const WsProviderAuthCancelRpc = Rpc.make(WS_METHODS.providerAuthCancel, {
  payload: ProviderAuthCancelInput,
  success: ProviderAuthState,
  error: ProviderSetupRpcError,
});

const WsProviderAuthLogoutRpc = Rpc.make(WS_METHODS.providerAuthLogout, {
  payload: ProviderSetupInput,
  success: ProviderAuthState,
  error: ProviderSetupRpcError,
});

const WsProviderAuthSubscribeRpc = Rpc.make(WS_METHODS.providerAuthSubscribe, {
  payload: ProviderSetupInput,
  success: ProviderAuthState,
  error: ProviderSetupRpcError,
  stream: true,
});

const WsProviderInstallStartRpc = Rpc.make(WS_METHODS.providerInstallStart, {
  payload: ProviderSetupInput,
  success: ProviderInstallState,
  error: ProviderSetupRpcError,
});

const WsProviderInstallCancelRpc = Rpc.make(WS_METHODS.providerInstallCancel, {
  payload: ProviderInstallCancelInput,
  success: ProviderInstallState,
  error: ProviderSetupRpcError,
});

const WsProviderInstallSubscribeRpc = Rpc.make(WS_METHODS.providerInstallSubscribe, {
  payload: ProviderSetupInput,
  success: ProviderInstallState,
  error: ProviderSetupRpcError,
  stream: true,
});

const WsProviderInstallRemoveRpc = Rpc.make(WS_METHODS.providerInstallRemove, {
  payload: ProviderSetupInput,
  success: ProviderInstallState,
  error: ProviderSetupRpcError,
});

const WsServerUpdateServerRpc = Rpc.make(WS_METHODS.serverUpdateServer, {
  payload: ServerSelfUpdateInput,
  success: ServerSelfUpdateResult,
  error: Schema.Union([ServerSelfUpdateError, EnvironmentAuthorizationError]),
});

const WsServerUpdateServerWithProgressRpc = Rpc.make(WS_METHODS.serverUpdateServerWithProgress, {
  payload: ServerSelfUpdateInput,
  success: ServerSelfUpdateProgressEvent,
  error: Schema.Union([ServerSelfUpdateError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsServerCommitDesktopUpdateRpc = Rpc.make(WS_METHODS.serverCommitDesktopUpdate, {
  payload: DesktopUpdateCommitInput,
  success: ServerSelfUpdateResult,
  error: Schema.Union([ServerSelfUpdateError, EnvironmentAuthorizationError]),
});

const WsServerGetSettingsRpc = Rpc.make(WS_METHODS.serverGetSettings, {
  payload: Schema.Struct({}),
  success: ServerSettings,
  error: Schema.Union([ServerSettingsError, EnvironmentAuthorizationError]),
});

const WsServerUpdateSettingsRpc = Rpc.make(WS_METHODS.serverUpdateSettings, {
  payload: Schema.Struct({ patch: ServerSettingsPatch }),
  success: ServerSettings,
  error: Schema.Union([ServerSettingsError, EnvironmentAuthorizationError]),
});

const WsServerDiscoverSourceControlRpc = Rpc.make(WS_METHODS.serverDiscoverSourceControl, {
  payload: Schema.Struct({}),
  success: SourceControlDiscoveryResult,
  error: EnvironmentAuthorizationError,
});

const WsServerGetTraceDiagnosticsRpc = Rpc.make(WS_METHODS.serverGetTraceDiagnostics, {
  payload: Schema.Struct({}),
  success: ServerTraceDiagnosticsResult,
  error: EnvironmentAuthorizationError,
});

const WsServerGetProcessDiagnosticsRpc = Rpc.make(WS_METHODS.serverGetProcessDiagnostics, {
  payload: Schema.Struct({}),
  success: ServerProcessDiagnosticsResult,
  error: EnvironmentAuthorizationError,
});

const WsServerGetHostResourcesRpc = Rpc.make(WS_METHODS.serverGetHostResources, {
  payload: Schema.Struct({}),
  success: HostResourcesSnapshot,
  error: EnvironmentAuthorizationError,
});

const WsServerGetProcessResourceHistoryRpc = Rpc.make(WS_METHODS.serverGetProcessResourceHistory, {
  payload: ServerProcessResourceHistoryInput,
  success: ServerProcessResourceHistoryResult,
  error: EnvironmentAuthorizationError,
});

const WsServerGetResourceTelemetryHistoryRpc = Rpc.make(
  WS_METHODS.serverGetResourceTelemetryHistory,
  {
    payload: ResourceTelemetryHistoryInput,
    success: ResourceTelemetryHistory,
    error: EnvironmentAuthorizationError,
  },
);

const WsServerRetryResourceTelemetryRpc = Rpc.make(WS_METHODS.serverRetryResourceTelemetry, {
  payload: Schema.Struct({}),
  success: ResourceTelemetryRetryResult,
  error: EnvironmentAuthorizationError,
});

const WsServerGetUsageSummaryRpc = Rpc.make(WS_METHODS.serverGetUsageSummary, {
  payload: UsageSummaryInput,
  success: UsageSummary,
  error: Schema.Union([EnvironmentAuthorizationError, UsageReadError]),
});

/**
 * Refetches the model rate table ahead of its daily TTL, so a model released
 * since the last fetch gets priced. The next usage summary uses the new table.
 */
const WsServerRefreshUsageRatesRpc = Rpc.make(WS_METHODS.serverRefreshUsageRates, {
  payload: Schema.Struct({}),
  success: UsagePricing,
  error: EnvironmentAuthorizationError,
});

const WsServerSignalProcessRpc = Rpc.make(WS_METHODS.serverSignalProcess, {
  payload: ServerSignalProcessInput,
  success: ServerSignalProcessResult,
  error: EnvironmentAuthorizationError,
});

const WsCloudGetRelayClientStatusRpc = Rpc.make(WS_METHODS.cloudGetRelayClientStatus, {
  payload: Schema.Struct({}),
  success: RelayClientStatusSchema,
  error: EnvironmentAuthorizationError,
});

const WsCloudInstallRelayClientRpc = Rpc.make(WS_METHODS.cloudInstallRelayClient, {
  payload: Schema.Struct({}),
  success: RelayClientInstallProgressEventSchema,
  error: Schema.Union([RelayClientInstallFailedError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsServerReportClientActivityRpc = Rpc.make(WS_METHODS.serverReportClientActivity, {
  payload: ClientActivityReportInput,
  error: EnvironmentAuthorizationError,
});

const WsServerReportHostPowerStateRpc = Rpc.make(WS_METHODS.serverReportHostPowerState, {
  payload: HostPowerSnapshot,
  error: EnvironmentAuthorizationError,
});

const WsServerGetBackgroundPolicyRpc = Rpc.make(WS_METHODS.serverGetBackgroundPolicy, {
  payload: Schema.Struct({}),
  success: BackgroundPolicySnapshot,
  error: EnvironmentAuthorizationError,
});

const PullRequestRpcError = Schema.Union([
  PullRequestUnavailableError,
  PullRequestOperationError,
  EnvironmentAuthorizationError,
]);

const WsPullRequestsListRpc = Rpc.make(WS_METHODS.pullRequestsList, {
  payload: PullRequestListInput,
  success: PullRequestListResult,
  error: PullRequestRpcError,
});

/**
 * The line counts for rows already on the page. Its own call because on GitHub the pair costs
 * 40-60% of the listing read that answers everything else on the row, so the rows arrive first
 * and their stats a moment later.
 */
const WsPullRequestsListStatsRpc = Rpc.make(WS_METHODS.pullRequestsListStats, {
  payload: PullRequestListStatsInput,
  success: PullRequestListStatsResult,
  error: PullRequestRpcError,
});

const WsPullRequestsRoutingRpc = Rpc.make(WS_METHODS.pullRequestsRouting, {
  payload: PullRequestRef,
  success: PullRequestRoutingResult,
  error: PullRequestRpcError,
});

const WsPullRequestsRoutingIdentityRpc = Rpc.make(WS_METHODS.pullRequestsRoutingIdentity, {
  payload: PullRequestRoutingIdentityInput,
  success: PullRequestRoutingIdentityResult,
  error: PullRequestRpcError,
});

const WsPullRequestsSummaryRpc = Rpc.make(WS_METHODS.pullRequestsSummary, {
  payload: PullRequestRef,
  success: PullRequestSummary,
  error: PullRequestRpcError,
});

const WsPullRequestsStackRpc = Rpc.make(WS_METHODS.pullRequestsStack, {
  payload: PullRequestRef,
  success: Schema.NullOr(PullRequestStack),
  error: PullRequestRpcError,
});

const WsPullRequestsLinkedThreadsRpc = Rpc.make(WS_METHODS.pullRequestsLinkedThreads, {
  payload: PullRequestRef,
  success: PullRequestLinkedThreadsResult,
  error: PullRequestRpcError,
});

const WsPullRequestsDetailRpc = Rpc.make(WS_METHODS.pullRequestsDetail, {
  payload: PullRequestRef,
  success: PullRequestDetail,
  error: PullRequestRpcError,
});

const WsPullRequestsPreviewRpc = Rpc.make(WS_METHODS.pullRequestsPreview, {
  payload: PullRequestRef,
  success: PullRequestPreview,
  error: PullRequestRpcError,
});

const WsPullRequestsActivityRpc = Rpc.make(WS_METHODS.pullRequestsActivity, {
  payload: PullRequestRef,
  success: PullRequestActivity,
  error: PullRequestRpcError,
});

const WsPullRequestsThreadCommentsRpc = Rpc.make(WS_METHODS.pullRequestsThreadComments, {
  payload: PullRequestThreadCommentsInput,
  success: PullRequestThreadCommentsResult,
  error: PullRequestRpcError,
});

const WsPullRequestsDiffFileContentsRpc = Rpc.make(WS_METHODS.pullRequestsDiffFileContents, {
  payload: PullRequestDiffFileContentsInput,
  success: PullRequestDiffFileContentsResult,
  error: PullRequestRpcError,
});

const WsPullRequestsFilesViewedRpc = Rpc.make(WS_METHODS.pullRequestsFilesViewed, {
  payload: PullRequestRef,
  success: PullRequestFilesViewedResult,
  error: PullRequestRpcError,
});

const WsPullRequestsSetFilesViewedRpc = Rpc.make(WS_METHODS.pullRequestsSetFilesViewed, {
  payload: PullRequestSetFilesViewedInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsRunActionRpc = Rpc.make(WS_METHODS.pullRequestsRunAction, {
  payload: PullRequestActionInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsUpdateRpc = Rpc.make(WS_METHODS.pullRequestsUpdate, {
  payload: PullRequestUpdateInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsCommentRpc = Rpc.make(WS_METHODS.pullRequestsComment, {
  payload: PullRequestCommentInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsUpdateCommentRpc = Rpc.make(WS_METHODS.pullRequestsUpdateComment, {
  payload: PullRequestCommentUpdateInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsSubmitReviewRpc = Rpc.make(WS_METHODS.pullRequestsSubmitReview, {
  payload: PullRequestSubmitReviewInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsReplyToThreadRpc = Rpc.make(WS_METHODS.pullRequestsReplyToThread, {
  payload: PullRequestThreadReplyInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsSetThreadResolutionRpc = Rpc.make(WS_METHODS.pullRequestsSetThreadResolution, {
  payload: PullRequestThreadResolutionInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsSetReactionRpc = Rpc.make(WS_METHODS.pullRequestsSetReaction, {
  payload: PullRequestReactionInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsInvalidateRpc = Rpc.make(WS_METHODS.pullRequestsInvalidate, {
  payload: PullRequestInvalidateInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsSubscribeRefreshesRpc = Rpc.make(WS_METHODS.pullRequestsSubscribeRefreshes, {
  payload: Schema.Struct({}),
  success: NonNegativeInt,
  error: EnvironmentAuthorizationError,
  stream: true,
});

/**
 * Read on its own rather than as part of the detail: the people who may be asked are only wanted
 * once somebody opens the menu, and reading them with every change request would spend a request
 * per host on a list nobody looked at.
 */
const WsPullRequestsReviewerCandidatesRpc = Rpc.make(WS_METHODS.pullRequestsReviewerCandidates, {
  payload: PullRequestRef,
  success: PullRequestReviewerCandidateList,
  error: PullRequestRpcError,
});

const WsPullRequestsRequestReviewersRpc = Rpc.make(WS_METHODS.pullRequestsRequestReviewers, {
  payload: PullRequestReviewerRequestInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

/** Read when the label menu opens, for the same reason the reviewer candidates are. */
const WsPullRequestsLabelCandidatesRpc = Rpc.make(WS_METHODS.pullRequestsLabelCandidates, {
  payload: PullRequestRef,
  success: PullRequestLabelCandidateList,
  error: PullRequestRpcError,
});

const WsPullRequestsSetLabelsRpc = Rpc.make(WS_METHODS.pullRequestsSetLabels, {
  payload: PullRequestLabelChangeInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsSourceControlLookupRepositoryRpc = Rpc.make(WS_METHODS.sourceControlLookupRepository, {
  payload: SourceControlRepositoryLookupInput,
  success: SourceControlRepositoryInfo,
  error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
});

const WsSourceControlCloneRepositoryRpc = Rpc.make(WS_METHODS.sourceControlCloneRepository, {
  payload: SourceControlCloneRepositoryInput,
  success: SourceControlCloneRepositoryResult,
  error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
});

// Clone-backed project creation. `start` returns once the project exists and
// the clone is running; progress arrives on the subscription.
const WsProjectCloneStartRpc = Rpc.make(WS_METHODS.projectCloneStart, {
  payload: ProjectCloneStartInput,
  success: ProjectCloneStartResult,
  error: Schema.Union([
    SourceControlRepositoryError,
    OrchestrationDispatchCommandError,
    EnvironmentAuthorizationError,
  ]),
});

const WsProjectCloneCancelRpc = Rpc.make(WS_METHODS.projectCloneCancel, {
  payload: ProjectCloneActionInput,
  success: ProjectCloneActionResult,
  error: EnvironmentAuthorizationError,
});

const WsProjectCloneRetryRpc = Rpc.make(WS_METHODS.projectCloneRetry, {
  payload: ProjectCloneActionInput,
  success: ProjectCloneActionResult,
  error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
});

const WsSubscribeProjectClonesRpc = Rpc.make(WS_METHODS.subscribeProjectClones, {
  payload: ProjectCloneSubscribeInput,
  success: ProjectCloneListEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsSourceControlPublishRepositoryRpc = Rpc.make(WS_METHODS.sourceControlPublishRepository, {
  payload: SourceControlPublishRepositoryInput,
  success: SourceControlPublishRepositoryResult,
  error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
});

const PersonalBotsRpcError = Schema.Union([PersonalBotsError, EnvironmentAuthorizationError]);

const WsPersonalBotsListRpc = Rpc.make(WS_METHODS.personalBotsList, {
  payload: Schema.Struct({}),
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

const WsPersonalFilesDeleteRpc = Rpc.make(WS_METHODS.personalFilesDelete, {
  payload: PersonalFileDeleteInput,
  success: Schema.Struct({}),
  error: PersonalBotsRpcError,
});

const PersonalTasksRpcError = Schema.Union([PersonalTasksError, EnvironmentAuthorizationError]);

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

const PersonalGroupsRpcError = Schema.Union([PersonalGroupsError, EnvironmentAuthorizationError]);

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

const PersonalSecretsRpcError = Schema.Union([PersonalSecretsError, EnvironmentAuthorizationError]);

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

const PersonalConnectionsRpcError = Schema.Union([
  PersonalConnectionsError,
  EnvironmentAuthorizationError,
]);

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

const PersonalLoginsRpcError = Schema.Union([PersonalLoginsError, EnvironmentAuthorizationError]);

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

const WsPersonalLoginsSetSensitiveRpc = Rpc.make(WS_METHODS.personalLoginsSetSensitive, {
  payload: PersonalLoginSetSensitiveInput,
  success: PersonalLogin,
  error: PersonalLoginsRpcError,
});

// personal browser
const PersonalBrowserRpcError = Schema.Union([PersonalBrowserError, EnvironmentAuthorizationError]);

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

const PersonalDesktopRpcError = Schema.Union([PersonalDesktopError, EnvironmentAuthorizationError]);

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

const PersonalRoutinesRpcError = Schema.Union([
  PersonalRoutinesError,
  EnvironmentAuthorizationError,
]);

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

const PersonalMemoryRpcError = Schema.Union([PersonalMemoryError, EnvironmentAuthorizationError]);

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

const PersonalPushRpcError = Schema.Union([PersonalPushError, EnvironmentAuthorizationError]);

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

const WsProjectsSearchEntriesRpc = Rpc.make(WS_METHODS.projectsSearchEntries, {
  payload: ProjectSearchEntriesInput,
  success: ProjectSearchEntriesResult,
  error: Schema.Union([ProjectSearchEntriesError, EnvironmentAuthorizationError]),
});

const WsProjectsSearchContentsRpc = Rpc.make(WS_METHODS.projectsSearchContents, {
  payload: ProjectSearchContentsInput,
  success: ProjectSearchContentsResult,
  error: Schema.Union([ProjectSearchContentsError, EnvironmentAuthorizationError]),
});

const WsProjectsListEntriesRpc = Rpc.make(WS_METHODS.projectsListEntries, {
  payload: ProjectListEntriesInput,
  success: ProjectListEntriesResult,
  error: Schema.Union([ProjectListEntriesError, EnvironmentAuthorizationError]),
});

const WsProjectsReadFileRpc = Rpc.make(WS_METHODS.projectsReadFile, {
  payload: ProjectReadFileInput,
  success: ProjectReadFileResult,
  error: Schema.Union([ProjectReadFileError, EnvironmentAuthorizationError]),
});

const WsProjectsWriteFileRpc = Rpc.make(WS_METHODS.projectsWriteFile, {
  payload: ProjectWriteFileInput,
  success: ProjectWriteFileResult,
  error: Schema.Union([ProjectWriteFileError, EnvironmentAuthorizationError]),
});

const WsShellOpenInEditorRpc = Rpc.make(WS_METHODS.shellOpenInEditor, {
  payload: LaunchEditorInput,
  error: Schema.Union([ExternalLauncherError, EnvironmentAuthorizationError]),
});

const WsFilesystemBrowseRpc = Rpc.make(WS_METHODS.filesystemBrowse, {
  payload: FilesystemBrowseInput,
  success: FilesystemBrowseResult,
  error: Schema.Union([FilesystemBrowseError, EnvironmentAuthorizationError]),
});

const WsAgentSessionsScanRpc = Rpc.make(WS_METHODS.agentSessionsScan, {
  payload: AgentSessionScanInput,
  success: AgentSessionScanResult,
  error: Schema.Union([AgentSessionScanError, EnvironmentAuthorizationError]),
});

const WsAgentSessionsImportRpc = Rpc.make(WS_METHODS.agentSessionsImport, {
  payload: AgentSessionImportInput,
  success: AgentSessionImportResult,
  error: Schema.Union([
    AgentSessionImportProjectChangedError,
    AgentSessionImportProjectNotFoundError,
    AgentSessionScanError,
    EnvironmentAuthorizationError,
  ]),
});

const WsAssetsCreateUrlRpc = Rpc.make(WS_METHODS.assetsCreateUrl, {
  payload: AssetCreateUrlInput,
  success: AssetCreateUrlResult,
  error: Schema.Union([AssetAccessError, EnvironmentAuthorizationError]),
});

const WsAttachmentsCreateUploadUrlRpc = Rpc.make(WS_METHODS.attachmentsCreateUploadUrl, {
  payload: AttachmentCreateUploadUrlInput,
  success: AttachmentCreateUploadUrlResult,
  error: Schema.Union([AttachmentUploadSigningKeyError, EnvironmentAuthorizationError]),
});

const WsAttachmentsDeleteRpc = Rpc.make(WS_METHODS.attachmentsDelete, {
  payload: AttachmentDeleteInput,
  error: EnvironmentAuthorizationError,
});

const WsProviderUploadFeedbackRpc = Rpc.make(WS_METHODS.providerUploadFeedback, {
  payload: ProviderUploadFeedbackInput,
  success: ProviderUploadFeedbackResult,
  error: Schema.Union([ProviderUploadFeedbackError, EnvironmentAuthorizationError]),
});

const WsSubscribeVcsStatusRpc = Rpc.make(WS_METHODS.subscribeVcsStatus, {
  payload: VcsStatusInput,
  success: VcsStatusStreamEvent,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsVcsPullRpc = Rpc.make(WS_METHODS.vcsPull, {
  payload: VcsPullInput,
  success: VcsPullResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

const WsVcsRefreshStatusRpc = Rpc.make(WS_METHODS.vcsRefreshStatus, {
  payload: VcsStatusInput,
  success: VcsStatusResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

const WsSubscribeWorktreeSetupRpc = Rpc.make(WS_METHODS.subscribeWorktreeSetup, {
  payload: WorktreeSetupSubscribeInput,
  success: WorktreeSetupStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsWorktreeSetupCancelRpc = Rpc.make(WS_METHODS.worktreeSetupCancel, {
  payload: WorktreeSetupCancelInput,
  success: WorktreeSetupCancelResult,
  error: EnvironmentAuthorizationError,
});

const WsGitRunStackedActionRpc = Rpc.make(WS_METHODS.gitRunStackedAction, {
  payload: GitRunStackedActionInput,
  success: GitActionProgressEvent,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsGitResolvePullRequestRpc = Rpc.make(WS_METHODS.gitResolvePullRequest, {
  payload: GitPullRequestRefInput,
  success: GitResolvePullRequestResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

const WsGitPreparePullRequestThreadRpc = Rpc.make(WS_METHODS.gitPreparePullRequestThread, {
  payload: GitPreparePullRequestThreadInput,
  success: GitPreparePullRequestThreadResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

const WsVcsListRefsRpc = Rpc.make(WS_METHODS.vcsListRefs, {
  payload: VcsListRefsInput,
  success: VcsListRefsResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

const WsVcsCreateWorktreeRpc = Rpc.make(WS_METHODS.vcsCreateWorktree, {
  payload: VcsCreateWorktreeInput,
  success: VcsCreateWorktreeResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

const WsVcsRemoveWorktreeRpc = Rpc.make(WS_METHODS.vcsRemoveWorktree, {
  payload: VcsRemoveWorktreeInput,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

const WsVcsCreateRefRpc = Rpc.make(WS_METHODS.vcsCreateRef, {
  payload: VcsCreateRefInput,
  success: VcsCreateRefResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

const WsVcsSwitchRefRpc = Rpc.make(WS_METHODS.vcsSwitchRef, {
  payload: VcsSwitchRefInput,
  success: VcsSwitchRefResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

const WsVcsInitRpc = Rpc.make(WS_METHODS.vcsInit, {
  payload: VcsInitInput,
  error: Schema.Union([VcsError, EnvironmentAuthorizationError]),
});

/**
 * Ephemeral live diff preview for compact/mobile surfaces.
 * Not the persisted T3 Review model. Future review sessions should use
 * review.open* + review.getSnapshot.
 */
const WsReviewGetDiffPreviewRpc = Rpc.make(WS_METHODS.reviewGetDiffPreview, {
  payload: ReviewDiffPreviewInput,
  success: ReviewDiffPreviewResult,
  error: Schema.Union([ReviewDiffPreviewError, EnvironmentAuthorizationError]),
});

const WsReviewGetDiffFileContentsRpc = Rpc.make(WS_METHODS.reviewGetDiffFileContents, {
  payload: ReviewDiffFileContentsInput,
  success: ReviewDiffFileContentsResult,
  error: Schema.Union([ReviewDiffPreviewError, EnvironmentAuthorizationError]),
});

const WsTerminalOpenRpc = Rpc.make(WS_METHODS.terminalOpen, {
  payload: TerminalOpenInput,
  success: TerminalSessionSnapshot,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

const WsTerminalAttachRpc = Rpc.make(WS_METHODS.terminalAttach, {
  payload: TerminalAttachInput,
  success: TerminalAttachStreamEvent,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsTerminalWriteRpc = Rpc.make(WS_METHODS.terminalWrite, {
  payload: TerminalWriteInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

const WsTerminalResizeRpc = Rpc.make(WS_METHODS.terminalResize, {
  payload: TerminalResizeInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

const WsTerminalClearRpc = Rpc.make(WS_METHODS.terminalClear, {
  payload: TerminalClearInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

const WsTerminalRestartRpc = Rpc.make(WS_METHODS.terminalRestart, {
  payload: TerminalRestartInput,
  success: TerminalSessionSnapshot,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

const WsTerminalCloseRpc = Rpc.make(WS_METHODS.terminalClose, {
  payload: TerminalCloseInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

const WsPreviewOpenRpc = Rpc.make(WS_METHODS.previewOpen, {
  payload: PreviewOpenInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

const WsPreviewNavigateRpc = Rpc.make(WS_METHODS.previewNavigate, {
  payload: PreviewNavigateInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

const WsPreviewResizeRpc = Rpc.make(WS_METHODS.previewResize, {
  payload: PreviewResizeInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

const WsPreviewRefreshRpc = Rpc.make(WS_METHODS.previewRefresh, {
  payload: PreviewRefreshInput,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

const WsPreviewCloseRpc = Rpc.make(WS_METHODS.previewClose, {
  payload: PreviewCloseInput,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

const WsPreviewListRpc = Rpc.make(WS_METHODS.previewList, {
  payload: PreviewListInput,
  success: PreviewListResult,
  error: EnvironmentAuthorizationError,
});

const WsPreviewReportStatusRpc = Rpc.make(WS_METHODS.previewReportStatus, {
  payload: PreviewReportStatusInput,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

const WsPreviewAutomationConnectRpc = Rpc.make(WS_METHODS.previewAutomationConnect, {
  payload: PreviewAutomationHost,
  success: PreviewAutomationStreamEvent,
  error: Schema.Union([PreviewAutomationError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsPreviewAutomationRespondRpc = Rpc.make(WS_METHODS.previewAutomationRespond, {
  payload: PreviewAutomationResponse,
  error: Schema.Union([PreviewAutomationError, EnvironmentAuthorizationError]),
});

const WsPreviewAutomationFocusHostRpc = Rpc.make(WS_METHODS.previewAutomationFocusHost, {
  payload: PreviewAutomationHostFocus,
  error: EnvironmentAuthorizationError,
});

const WsSubscribePreviewEventsRpc = Rpc.make(WS_METHODS.subscribePreviewEvents, {
  payload: Schema.Struct({}),
  success: PreviewEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsSubscribeDiscoveredLocalServersRpc = Rpc.make(WS_METHODS.subscribeDiscoveredLocalServers, {
  payload: Schema.Struct({
    configuredUrls: Schema.optional(ConfiguredLocalServerUrls),
  }),
  success: DiscoveredLocalServerList,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsDeviceTestHostRpc = Rpc.make(WS_METHODS.deviceTestHost, {
  payload: SshDeviceHostConfig,
  success: DeviceHostSummary,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsDeviceListRpc = Rpc.make(WS_METHODS.deviceList, {
  payload: DeviceListInput,
  success: DeviceServiceState,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsDeviceConfigureRpc = Rpc.make(WS_METHODS.deviceConfigure, {
  payload: DeviceConfigureInput,
  success: DeviceServiceState,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsDeviceOpenRpc = Rpc.make(WS_METHODS.deviceOpen, {
  payload: DeviceOpenInput,
  success: DeviceSession,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsDeviceCloseRpc = Rpc.make(WS_METHODS.deviceClose, {
  payload: DeviceCloseInput,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsDeviceShutdownRpc = Rpc.make(WS_METHODS.deviceShutdown, {
  payload: DeviceShutdownInput,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsDeviceDetailRpc = Rpc.make(WS_METHODS.deviceDetail, {
  payload: DeviceDetailInput,
  success: DeviceDetail,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsDeviceActionRpc = Rpc.make(WS_METHODS.deviceAction, {
  payload: DeviceActionInput,
  success: DeviceDetail,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsSubscribeDeviceStateRpc = Rpc.make(WS_METHODS.subscribeDeviceState, {
  payload: Schema.Struct({}),
  success: DeviceServiceState,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsOrchestrationDispatchCommandRpc = Rpc.make(ORCHESTRATION_WS_METHODS.dispatchCommand, {
  payload: ClientOrchestrationCommand,
  success: OrchestrationRpcSchemas.dispatchCommand.output,
  error: Schema.Union([OrchestrationDispatchCommandError, EnvironmentAuthorizationError]),
});

const WsOrchestrationGetWorkflowScriptRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getWorkflowScript, {
  payload: OrchestrationRpcSchemas.getWorkflowScript.input,
  success: OrchestrationRpcSchemas.getWorkflowScript.output,
  error: Schema.Union([OrchestrationGetWorkflowScriptError, EnvironmentAuthorizationError]),
});

const WsOrchestrationGetTurnDiffRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getTurnDiff, {
  payload: OrchestrationGetTurnDiffInput,
  success: OrchestrationRpcSchemas.getTurnDiff.output,
  error: Schema.Union([OrchestrationGetTurnDiffError, EnvironmentAuthorizationError]),
});

const WsOrchestrationGetFullThreadDiffRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getFullThreadDiff, {
  payload: OrchestrationGetFullThreadDiffInput,
  success: OrchestrationRpcSchemas.getFullThreadDiff.output,
  error: Schema.Union([OrchestrationGetFullThreadDiffError, EnvironmentAuthorizationError]),
});

const WsOrchestrationSearchThreadsRpc = Rpc.make(ORCHESTRATION_WS_METHODS.searchThreads, {
  payload: OrchestrationSearchThreadsInput,
  success: OrchestrationRpcSchemas.searchThreads.output,
  error: Schema.Union([OrchestrationSearchThreadsError, EnvironmentAuthorizationError]),
});

const WsOrchestrationGetArchivedShellSnapshotRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
  {
    payload: OrchestrationRpcSchemas.getArchivedShellSnapshot.input,
    success: OrchestrationRpcSchemas.getArchivedShellSnapshot.output,
    error: Schema.Union([OrchestrationGetSnapshotError, EnvironmentAuthorizationError]),
  },
);

const WsOrchestrationSubscribeShellRpc = Rpc.make(ORCHESTRATION_WS_METHODS.subscribeShell, {
  payload: OrchestrationRpcSchemas.subscribeShell.input,
  success: OrchestrationRpcSchemas.subscribeShell.output,
  error: Schema.Union([OrchestrationGetSnapshotError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsOrchestrationSubscribeThreadRpc = Rpc.make(ORCHESTRATION_WS_METHODS.subscribeThread, {
  payload: OrchestrationRpcSchemas.subscribeThread.input,
  success: OrchestrationRpcSchemas.subscribeThread.output,
  error: Schema.Union([OrchestrationGetSnapshotError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsSubscribeTerminalEventsRpc = Rpc.make(WS_METHODS.subscribeTerminalEvents, {
  payload: Schema.Struct({}),
  success: TerminalEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsSubscribeTerminalMetadataRpc = Rpc.make(WS_METHODS.subscribeTerminalMetadata, {
  payload: Schema.Struct({}),
  success: TerminalMetadataStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeServerConfigRpc = Rpc.make(WS_METHODS.subscribeServerConfig, {
  payload: Schema.Struct({
    /**
     * Whether this client understands `environmentThemesUpdated` events.
     * Already-shipped clients decode the stream against the old event union
     * and would die on an unknown member, so the server emits the theme
     * stream only to subscribers that ask for it. Absent on old clients;
     * dropped by old servers.
     */
    environmentThemes: Schema.optional(Schema.Boolean),
    /** Whether this client understands `usageLimitSourcesUpdated` events. */
    usageLimitSources: Schema.optional(Schema.Boolean),
    /**
     * Whether this client answers `/usage-limits` itself. The server injects
     * that command into provider catalogs only for such clients; an older
     * client would send it to the provider as an ordinary prompt.
     */
    usageLimitsCommand: Schema.optional(Schema.Boolean),
    /**
     * Whether this client renders none of the composer's workspace data --
     * `workspaceSnapshots`, `slashCommands` and `skills`. Those three fields
     * were measured at 119 KB of a 145 KB boot snapshot, and the whole catalog
     * is rebroadcast whenever a provider health poll moves a `checkedAt`
     * timestamp (~40 s), so a client that never reads them pays ~111 KB per
     * poll for nothing.
     *
     * Opt-out rather than opt-in on purpose: a client that does not send it,
     * cannot send it, or talks to a server that drops it keeps the full
     * catalog. The failure mode is the payload staying large, never a composer
     * silently losing its slash commands.
     */
    omitProviderWorkspaceData: Schema.optional(Schema.Boolean),
  }),
  success: ServerConfigStreamEvent,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsSubscribeServerLifecycleRpc = Rpc.make(WS_METHODS.subscribeServerLifecycle, {
  payload: Schema.Struct({}),
  success: ServerLifecycleStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsSubscribeAuthAccessRpc = Rpc.make(WS_METHODS.subscribeAuthAccess, {
  payload: Schema.Struct({}),
  success: AuthAccessStreamEvent,
  error: Schema.Union([AuthAccessStreamError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsSubscribeBackgroundPolicyRpc = Rpc.make(WS_METHODS.subscribeBackgroundPolicy, {
  payload: Schema.Struct({}),
  success: BackgroundPolicySnapshot,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsSubscribeResourceTelemetryRpc = Rpc.make(WS_METHODS.subscribeResourceTelemetry, {
  payload: Schema.Struct({}),
  success: ResourceTelemetrySnapshot,
  error: EnvironmentAuthorizationError,
  stream: true,
});

/**
 * The WebSocket surface, split into five groups that are merged back into one
 * `WsRpcGroup` below. The split is a compile-time requirement, not taxonomy:
 * `RpcGroup.toLayer` costs O(methods squared) type instantiations, because it
 * resolves each handler's service requirements against the *whole* Rpc union.
 * One group of ~240 methods exhausts TypeScript's per-operation instantiation
 * budget, at which point the compiler abandons the computation and silently
 * substitutes `any` for the requirements channel - which surfaces, with no
 * mention of RPCs at all, as TS2345 in `apps/server/src/bin.ts`.
 *
 * Each group is handled by its own `toLayer` call in `apps/server/src/ws.ts`,
 * so each gets its own budget and the practical limit is ~200 methods *per
 * group*. Adding a group is the way to add headroom; see
 * `HANDOFF-rpc-ceiling.md` for the measurements behind those numbers.
 */
/**
 * Server lifecycle, configuration, providers, diagnostics, usage and the cloud relay.
 */
export const WsServerRpcGroup = RpcGroup.make(
  WsServerProbeRpc,
  WsServerGetConfigRpc,
  WsServerRefreshProvidersRpc,
  WsServerUpdateProviderRpc,
  WsProviderConsumeResetCreditRpc,
  WsProviderAuthStartRpc,
  WsProviderAuthCompleteRpc,
  WsProviderAuthRespondRpc,
  WsProviderAuthCancelRpc,
  WsProviderAuthLogoutRpc,
  WsProviderAuthSubscribeRpc,
  WsProviderInstallStartRpc,
  WsProviderInstallCancelRpc,
  WsProviderInstallSubscribeRpc,
  WsProviderInstallRemoveRpc,
  WsServerUpdateServerRpc,
  WsServerUpdateServerWithProgressRpc,
  WsServerCommitDesktopUpdateRpc,
  WsServerUpsertKeybindingRpc,
  WsServerRemoveKeybindingRpc,
  WsServerGetSettingsRpc,
  WsServerUpdateSettingsRpc,
  WsServerDiscoverSourceControlRpc,
  WsServerGetTraceDiagnosticsRpc,
  WsServerGetProcessDiagnosticsRpc,
  WsServerGetHostResourcesRpc,
  WsServerGetProcessResourceHistoryRpc,
  WsServerGetResourceTelemetryHistoryRpc,
  WsServerRetryResourceTelemetryRpc,
  WsServerGetUsageSummaryRpc,
  WsServerRefreshUsageRatesRpc,
  WsServerSignalProcessRpc,
  WsServerReportClientActivityRpc,
  WsServerReportHostPowerStateRpc,
  WsServerGetBackgroundPolicyRpc,
  WsCloudGetRelayClientStatusRpc,
  WsCloudInstallRelayClientRpc,
);

/**
 * Pull requests - their reviews, comments and labels - and repository source control.
 */
export const WsPullRequestRpcGroup = RpcGroup.make(
  WsPullRequestsListRpc,
  WsPullRequestsListStatsRpc,
  WsPullRequestsSummaryRpc,
  WsPullRequestsRoutingRpc,
  WsPullRequestsRoutingIdentityRpc,
  WsPullRequestsStackRpc,
  WsPullRequestsLinkedThreadsRpc,
  WsPullRequestsDetailRpc,
  WsPullRequestsPreviewRpc,
  WsPullRequestsActivityRpc,
  WsPullRequestsThreadCommentsRpc,
  WsPullRequestsDiffFileContentsRpc,
  WsPullRequestsFilesViewedRpc,
  WsPullRequestsSetFilesViewedRpc,
  WsPullRequestsRunActionRpc,
  WsPullRequestsUpdateRpc,
  WsPullRequestsCommentRpc,
  WsPullRequestsUpdateCommentRpc,
  WsPullRequestsSubmitReviewRpc,
  WsPullRequestsReplyToThreadRpc,
  WsPullRequestsSetThreadResolutionRpc,
  WsPullRequestsSetReactionRpc,
  WsPullRequestsInvalidateRpc,
  WsPullRequestsSubscribeRefreshesRpc,
  WsPullRequestsReviewerCandidatesRpc,
  WsPullRequestsRequestReviewersRpc,
  WsPullRequestsLabelCandidatesRpc,
  WsPullRequestsSetLabelsRpc,
  WsSourceControlLookupRepositoryRpc,
  WsSourceControlCloneRepositoryRpc,
  WsSourceControlPublishRepositoryRpc,
);

/**
 * The personal side of the app: bots and their threads, files, tasks, groups,
 * secrets, logins, the browser, routines, memory and push.
 */
export const WsPersonalRpcGroup = RpcGroup.make(
  WsPersonalBotsListRpc,
  WsPersonalBotsCreateRpc,
  WsPersonalBotsUpdateRpc,
  WsPersonalBotsDeleteRpc,
  WsPersonalBotsCreateThreadRpc,
  WsPersonalBotsArchiveThreadRpc,
  WsPersonalBotsDeleteThreadRpc,
  WsPersonalBotsPrewarmThreadRpc,
  WsPersonalBotsGetProfileRpc,
  WsPersonalBotsSetProfileRpc,
  WsPersonalBotsListFilesRpc,
  WsPersonalBotsRecheckProviderRpc,
  WsPersonalFilesDeleteRpc,
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
  WsPersonalLoginsCreateRpc,
  WsPersonalLoginsUpdateRpc,
  WsPersonalLoginsDeleteRpc,
  WsPersonalLoginsSetSensitiveRpc,
  // personal browser
  WsPersonalBrowserStatusRpc,
  WsPersonalBrowserTakeControlRpc,
  WsPersonalBrowserReturnToAgentRpc,
  WsPersonalBrowserCloseRpc,
  WsPersonalBrowserListFilesRpc,
  WsPersonalBrowserActivityRpc,
  WsPersonalDesktopStatusRpc,
  WsPersonalDesktopStopRpc,
  WsPersonalRoutinesListRpc,
  WsPersonalRoutinesCreateRpc,
  WsPersonalRoutinesUpdateRpc,
  WsPersonalRoutinesDeleteRpc,
  WsPersonalRoutinesPauseRpc,
  WsPersonalRoutinesResumeRpc,
  WsPersonalRoutinesRunNowRpc,
  WsPersonalRoutinesRegenerateHookRpc,
  WsPersonalMemoryListRpc,
  WsPersonalMemorySearchRpc,
  WsPersonalMemoryUpdateRpc,
  WsPersonalMemoryDeleteRpc,
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

/**
 * The project workspace: clones, file reads and writes, agent session import,
 * attachments, version control and diff review.
 */
export const WsWorkspaceRpcGroup = RpcGroup.make(
  WsProjectCloneStartRpc,
  WsProjectCloneCancelRpc,
  WsProjectCloneRetryRpc,
  WsSubscribeProjectClonesRpc,
  WsProjectsListEntriesRpc,
  WsProjectsReadFileRpc,
  WsProjectsSearchContentsRpc,
  WsProjectsSearchEntriesRpc,
  WsProjectsWriteFileRpc,
  WsShellOpenInEditorRpc,
  WsFilesystemBrowseRpc,
  WsAgentSessionsScanRpc,
  WsAgentSessionsImportRpc,
  WsAssetsCreateUrlRpc,
  WsAttachmentsCreateUploadUrlRpc,
  WsAttachmentsDeleteRpc,
  WsProviderUploadFeedbackRpc,
  WsSubscribeVcsStatusRpc,
  WsSubscribeWorktreeSetupRpc,
  WsWorktreeSetupCancelRpc,
  WsVcsPullRpc,
  WsVcsRefreshStatusRpc,
  WsGitRunStackedActionRpc,
  WsGitResolvePullRequestRpc,
  WsGitPreparePullRequestThreadRpc,
  WsVcsListRefsRpc,
  WsVcsCreateWorktreeRpc,
  WsVcsRemoveWorktreeRpc,
  WsVcsCreateRefRpc,
  WsVcsSwitchRefRpc,
  WsVcsInitRpc,
  WsReviewGetDiffPreviewRpc,
  WsReviewGetDiffFileContentsRpc,
);

/**
 * Live sessions: terminals, previews, devices, the server-wide subscriptions, and
 * orchestration itself.
 */
export const WsSessionRpcGroup = RpcGroup.make(
  WsTerminalOpenRpc,
  WsTerminalAttachRpc,
  WsTerminalWriteRpc,
  WsTerminalResizeRpc,
  WsTerminalClearRpc,
  WsTerminalRestartRpc,
  WsTerminalCloseRpc,
  WsSubscribeTerminalEventsRpc,
  WsSubscribeTerminalMetadataRpc,
  WsPreviewOpenRpc,
  WsPreviewNavigateRpc,
  WsPreviewResizeRpc,
  WsPreviewRefreshRpc,
  WsPreviewCloseRpc,
  WsPreviewListRpc,
  WsPreviewReportStatusRpc,
  WsPreviewAutomationConnectRpc,
  WsPreviewAutomationRespondRpc,
  WsPreviewAutomationFocusHostRpc,
  WsSubscribePreviewEventsRpc,
  WsSubscribeDiscoveredLocalServersRpc,
  WsDeviceConfigureRpc,
  WsDeviceListRpc,
  WsDeviceTestHostRpc,
  WsDeviceOpenRpc,
  WsDeviceCloseRpc,
  WsDeviceShutdownRpc,
  WsDeviceDetailRpc,
  WsDeviceActionRpc,
  WsSubscribeDeviceStateRpc,
  WsSubscribeServerConfigRpc,
  WsSubscribeServerLifecycleRpc,
  WsSubscribeAuthAccessRpc,
  WsSubscribeBackgroundPolicyRpc,
  WsSubscribeResourceTelemetryRpc,
  WsOrchestrationDispatchCommandRpc,
  WsOrchestrationGetWorkflowScriptRpc,
  WsOrchestrationGetTurnDiffRpc,
  WsOrchestrationGetFullThreadDiffRpc,
  WsOrchestrationSearchThreadsRpc,
  WsOrchestrationGetArchivedShellSnapshotRpc,
  WsOrchestrationSubscribeShellRpc,
  WsOrchestrationSubscribeThreadRpc,
);

/**
 * Every WebSocket method in one group: this is what the server serves, what the
 * client calls, and what `RPC_REQUIRED_SCOPES` is checked against.
 */
export const WsRpcGroup = WsServerRpcGroup.merge(
  WsPullRequestRpcGroup,
  WsPersonalRpcGroup,
  WsWorkspaceRpcGroup,
  WsSessionRpcGroup,
);
