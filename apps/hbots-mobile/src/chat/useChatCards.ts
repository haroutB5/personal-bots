import type {
  EnvironmentId,
  PersonalBot,
  PersonalMemoryRulesUsage,
  ServerProvider,
} from "@t3tools/contracts";
import {
  derivePendingRequests,
  deriveUserInputHistory,
  type PendingUserInput,
} from "@t3tools/client-runtime/pending-requests";
import {
  placeDelegationCards,
  type ConversationItem,
} from "@hbots/personal-client/conversation/conversationModel";
import {
  delegatedChildren,
  waitingLabelsByThread,
} from "@hbots/personal-client/conversation/delegationModel";
import { placeChatCards } from "@hbots/personal-client/conversation/feedCards";
import { deriveLeadBotChangeCards } from "@hbots/personal-client/conversation/leadBotChangeCards";
import { deriveMemoryCards } from "@hbots/personal-client/conversation/memoryCards";
import {
  deriveQuestionCards,
  deriveUserInputResolutions,
} from "@hbots/personal-client/conversation/questionCards";
import { mergeTaskLists } from "@hbots/personal-client/conversation/taskPresentation";
import { useMemo, useState } from "react";

import type { ChatEnvironment } from "./chatEnvironment";
import type { CardContext } from "./cards/types";
import type { NativePersonal } from "../personal/nativePersonalClient";

interface SeenUserInputs {
  readonly threadId: string;
  readonly requests: ReadonlyMap<string, PendingUserInput>;
}

/**
 * The feed's cards for one chat: questions asked here, delegated tasks and
 * their work records, team-lead changes and memory changes. The card list is
 * placed into `items` exactly where the web puts it, so the phone transcript
 * reads in the same order.
 */
export function useChatCards(input: {
  readonly native: NativePersonal;
  readonly chat: ChatEnvironment;
  readonly environmentId: EnvironmentId | null;
  readonly threadId: string;
  readonly activities: Parameters<typeof derivePendingRequests>[0];
  readonly items: ReadonlyArray<ConversationItem>;
  readonly bots: ReadonlyArray<PersonalBot>;
  readonly botName: string;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly nowMs: number;
  readonly onOpenChat: (botId: string, threadId: string) => void;
}): {
  readonly items: ConversationItem[];
  readonly context: CardContext;
  readonly rulesUsage: PersonalMemoryRulesUsage | null;
} {
  const { native, environmentId, threadId } = input;
  const { userInputs } = useMemo(() => derivePendingRequests(input.activities), [input.activities]);

  // Remember every request this screen showed, so an answered card keeps its
  // place with the answer instead of vanishing under the thumb.
  const [seen, setSeen] = useState<SeenUserInputs>(() => ({
    threadId,
    requests: new Map(),
  }));
  const sameThread = seen.threadId === threadId;
  if (
    !sameThread ||
    userInputs.some(
      (request) => seen.requests.get(request.requestId)?.createdAt !== request.createdAt,
    )
  ) {
    const requests = new Map<string, PendingUserInput>(sameThread ? seen.requests : []);
    for (const request of userInputs) requests.set(request.requestId, request);
    setSeen({ threadId, requests });
  }

  const questionCards = useMemo(() => {
    const asked = new Map<string, PendingUserInput>(
      deriveUserInputHistory(input.activities).map((request) => [
        request.requestId as string,
        request,
      ]),
    );
    if (seen.threadId === threadId) {
      for (const [requestId, request] of seen.requests) {
        if ((asked.get(requestId)?.createdAt ?? "") < request.createdAt) {
          asked.set(requestId, request);
        }
      }
    }
    return deriveQuestionCards(userInputs, asked, deriveUserInputResolutions(input.activities));
  }, [input.activities, seen, threadId, userInputs]);

  const memoryQuery = native.bots.usePersonalMemoryCards(environmentId, threadId);
  const memoryChanges = useMemo(
    () => deriveMemoryCards(memoryQuery.data?.cards ?? [], threadId),
    [memoryQuery.data, threadId],
  );

  const leadQuery = native.bots.usePersonalLeadBotChanges(environmentId);
  const leadBotChanges = useMemo(
    () => deriveLeadBotChangeCards(leadQuery.data?.changes ?? [], threadId),
    [leadQuery.data, threadId],
  );

  const taskFeed = native.bots.usePersonalTasks(environmentId);
  const relatedTasks = native.bots.usePersonalRelatedTasks(environmentId, threadId);
  const tasks = useMemo(() => {
    const merged = mergeTaskLists(taskFeed.data ?? null, relatedTasks.data?.tasks ?? null);
    return merged === null ? [] : [...merged.values()];
  }, [taskFeed.data, relatedTasks.data]);
  const children = useMemo(() => delegatedChildren(threadId, tasks), [tasks, threadId]);
  const nameOf = useMemo(() => {
    const names = new Map(input.bots.map((bot) => [bot.botId as string, bot.name]));
    return (botId: string) => names.get(botId) ?? null;
  }, [input.bots]);
  const waitingLabels = useMemo(() => waitingLabelsByThread(tasks, nameOf), [tasks, nameOf]);

  const items = useMemo(() => {
    const withDelegations = placeDelegationCards(input.items, children);
    return placeChatCards(withDelegations, {
      questions: questionCards,
      secrets: [],
      logins: [],
      connectionApprovals: [],
      leadBotChanges,
      memoryChanges,
    });
  }, [children, input.items, leadBotChanges, memoryChanges, questionCards]);

  const botsById = useMemo(
    () => new Map(input.bots.map((bot) => [bot.botId as string, bot] as const)),
    [input.bots],
  );
  const context = useMemo<CardContext>(
    () => ({
      native,
      chat: input.chat,
      environmentId,
      threadId,
      nowMs: input.nowMs,
      botName: input.botName,
      botNameOf: (botId) => botsById.get(botId)?.name,
      findBot: (botId) => botsById.get(botId) ?? null,
      providers: input.providers,
      waitingLabelFor: (id) => (id === null ? null : (waitingLabels.get(id) ?? null)),
      onOpenChat: input.onOpenChat,
    }),
    [
      botsById,
      environmentId,
      input.botName,
      input.chat,
      input.nowMs,
      input.onOpenChat,
      input.providers,
      native,
      threadId,
      waitingLabels,
    ],
  );

  const rulesUsage = native.bots.usePersonalMemoryRulesUsage(environmentId);

  return { items, context, rulesUsage: rulesUsage.data };
}
