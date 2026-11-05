import { createPersonalGroupsClient } from "@hbots/personal-client/groups/personalGroups";

import { connectionAtomRuntime } from "../../connection/runtime";
import { personalClient } from "./personalClient";
import { personalBotsList, personalBotsListInput } from "./usePersonalBots";

export * from "@hbots/personal-client/groups/personalGroups";

export const {
  personalGroupsList,
  personalGroupsFeed,
  personalGroupCreate,
  personalGroupUpdate,
  personalGroupDelete,
  personalGroupAddMember,
  personalGroupRemoveMember,
  personalGroupSendMessage,
  personalGroupContinueRound,
  personalGroupStop,
  usePersonalGroupsList,
  usePersonalGroupsFeed,
  usePersonalGroupRelayThreadIds,
} = createPersonalGroupsClient(connectionAtomRuntime, personalClient, {
  refreshBots: (registry, environmentId) => {
    registry.refresh(personalBotsList({ environmentId, input: personalBotsListInput() }));
  },
});
