import { createPersonalBotsClient } from "@hbots/personal-client/bots/personalBots";

import { connectionAtomRuntime } from "../../connection/runtime";
import { personalClient } from "./personalClient";

export * from "@hbots/personal-client/bots/personalBots";

export const {
  personalBotsListInput,
  personalBotsList,
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
  usePersonalArchivedLinks,
  usePersonalFiles,
  usePersonalProfile,
  useHiddenUsageProviders,
  usePersonalTokenUsage,
} = createPersonalBotsClient(connectionAtomRuntime, personalClient);
