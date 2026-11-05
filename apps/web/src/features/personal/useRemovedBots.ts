/**
 * The removed-bots list and restore live in the shared client, so the phone
 * and the web ask the server the same question and refresh the same two lists.
 */
export {
  personalRemovedBotsList,
  personalBotRestore,
  useRemovedBots,
  useRestoreRemovedBot,
} from "./usePersonalBots";
export type { RestoreOutcome } from "@hbots/personal-client/bots/personalBots";
