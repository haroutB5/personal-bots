import { createPersonalBotsClient } from "@hbots/personal-client/bots/personalBots";

import { connectionAtomRuntime } from "../../connection/runtime";
import { personalClient } from "./personalClient";

export * from "@hbots/personal-client/bots/personalBots";

export const {
  personalBotsListInput,
  personalBotsList,
  personalRemovedBotsList,
  personalPushInAppFeed,
  personalPushAckInApp,
  personalPushReportViewing,
  personalPushReportForeground,
  personalProfile,
  personalFilesList,
  personalBotsTokenUsage,
  personalBotCreate,
  personalBotUpdate,
  personalProviderRecheck,
  personalBotDelete,
  personalBotRestore,
  personalBotCreateThread,
  personalBotArchiveThread,
  personalBotDeleteThread,
  personalBotArchiveThreads,
  personalBotDeleteThreads,
  personalBotUpdateThreads,
  personalFileDelete,
  personalFilesDeleteMany,
  personalProfileSet,
  usePersonalEnvironmentId,
  usePersonalBotsList,
  useRemovedBots,
  useRestoreRemovedBot,
  usePersonalArchivedLinks,
  usePersonalFiles,
  usePersonalProfile,
  useHiddenUsageProviders,
  usePersonalTokenUsage,
} = createPersonalBotsClient(connectionAtomRuntime, personalClient);
