import type {
  EnvironmentId,
  PersonalBot,
  PersonalConnectionApproval,
  PersonalMemoryRulesUsage,
  PersonalSecretRequest,
  ServerProvider,
} from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import * as DateTime from "effect/DateTime";
import {
  derivePendingRequests,
  deriveUserInputHistory,
} from "@t3tools/client-runtime/pending-requests";
import type { PendingUserInput } from "@hbots/personal-client/conversation/wireTypes";
import {
  placeDelegationCards,
  type ConversationItem,
} from "@hbots/personal-client/conversation/conversationModel";
import {
  delegatedChildren,
  waitingLabelsByThread,
} from "@hbots/personal-client/conversation/delegationModel";
import {
  deriveConnectionApprovalCards,
  type ConnectionApprovalOutcome,
} from "@hbots/personal-client/conversation/connectionApprovalCards";
import { placeChatCards } from "@hbots/personal-client/conversation/feedCards";
import { deriveLeadBotChangeCards } from "@hbots/personal-client/conversation/leadBotChangeCards";
import { deriveMemoryCards } from "@hbots/personal-client/conversation/memoryCards";
import {
  deriveQuestionCards,
  deriveUserInputResolutions,
} from "@hbots/personal-client/conversation/questionCards";
import {
  deriveSecretRequestCards,
  type SecretRequestHistoryEntry,
  type SecretRequestOutcome,
} from "@hbots/personal-client/conversation/secretRequestCards";
import type { SecretAccessChoice } from "@hbots/personal-client/settings/secretAccess";
import { mergeTaskLists } from "@hbots/personal-client/conversation/taskPresentation";
import { useMemo, useState } from "react";

import type { ChatEnvironment } from "./chatEnvironment";
import type { CardContext } from "./cards/types";
import type { NativePersonal } from "../personal/nativePersonalClient";
import { appendSecretOutcome } from "./secretOutcomeModel";
import { readSecretOutcomeHistory, writeSecretOutcomeHistory } from "./secretOutcomeStore";

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
  readonly onRevealCard?: (itemId: string) => void;
  readonly cardMaxHeight?: number | null;
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

  const pendingSecretsQuery = native.bots.usePersonalPendingSecrets(environmentId);
  const pendingSecrets = useMemo(
    () => pendingSecretsQuery.data?.requests ?? [],
    [pendingSecretsQuery.data],
  );
  const [seenSecrets, setSeenSecrets] = useState<ReadonlyMap<string, PersonalSecretRequest>>(
    () => new Map(),
  );
  const [secretOutcomes, setSecretOutcomes] = useState<ReadonlyMap<string, SecretRequestOutcome>>(
    () => new Map(),
  );
  const [secretHistory, setSecretHistory] = useState<ReadonlyArray<SecretRequestHistoryEntry>>(
    () => (environmentId === null ? [] : readSecretOutcomeHistory(environmentId)),
  );
  const [respondingSecretIds, setRespondingSecretIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  if (pendingSecrets.some((request) => !seenSecrets.has(request.requestId))) {
    const next = new Map(seenSecrets);
    for (const request of pendingSecrets) next.set(request.requestId, request);
    setSeenSecrets(next);
  }
  const secretCards = useMemo(
    () =>
      deriveSecretRequestCards(
        pendingSecrets,
        threadId,
        seenSecrets,
        secretOutcomes,
        secretHistory,
      ),
    [pendingSecrets, secretHistory, secretOutcomes, seenSecrets, threadId],
  );

  const approvalsQuery = native.bots.usePersonalConnectionApprovals(environmentId);
  const pendingApprovals = useMemo(
    () => approvalsQuery.data?.approvals ?? [],
    [approvalsQuery.data],
  );
  const [seenApprovals, setSeenApprovals] = useState<
    ReadonlyMap<string, PersonalConnectionApproval>
  >(() => new Map());
  const [approvalOutcomes, setApprovalOutcomes] = useState<
    ReadonlyMap<string, ConnectionApprovalOutcome>
  >(() => new Map());
  const [respondingApprovalIds, setRespondingApprovalIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  if (pendingApprovals.some((approval) => !seenApprovals.has(approval.approvalId))) {
    const next = new Map(seenApprovals);
    for (const approval of pendingApprovals) next.set(approval.approvalId, approval);
    setSeenApprovals(next);
  }
  const approvalCards = useMemo(
    () =>
      deriveConnectionApprovalCards(pendingApprovals, threadId, seenApprovals, approvalOutcomes),
    [approvalOutcomes, pendingApprovals, seenApprovals, threadId],
  );

  const loginQuery = native.bots.usePersonalLoginRequests(environmentId, threadId);
  const loginRequests = useMemo(
    () =>
      (loginQuery.data?.requests ?? []).filter((request) => String(request.threadId) === threadId),
    [loginQuery.data, threadId],
  );

  const fulfillSecret = native.client.useAtomCommand(native.bots.personalSecretsFulfill, {
    reportFailure: false,
  });
  const cancelSecret = native.client.useAtomCommand(native.bots.personalSecretsCancel, {
    reportFailure: false,
  });
  const decideApproval = native.client.useAtomCommand(
    native.bots.personalConnectionApprovalsDecide,
    { reportFailure: false },
  );

  const provideSecret = (
    requestId: string,
    value: string,
    shared: boolean,
    access: SecretAccessChoice,
  ) => {
    if (environmentId === null) return;
    setRespondingSecretIds((current) => new Set(current).add(requestId));
    void fulfillSecret({
      environmentId,
      input: {
        requestId: requestId as never,
        value: Redacted.make(value),
        shared,
        mode: access.mode,
        origins: [...access.origins],
        placement: access.placement,
      },
    }).then((result) => {
      if (result._tag === "Success") {
        setSecretOutcomes((current) => new Map(current).set(requestId, "provided"));
        rememberSecretOutcome(requestId, "provided");
      }
      setRespondingSecretIds((current) => {
        const next = new Set(current);
        next.delete(requestId);
        return next;
      });
      pendingSecretsQuery.refresh();
    });
  };

  const rememberSecretOutcome = (requestId: string, outcome: SecretRequestOutcome) => {
    if (environmentId === null) return;
    const request =
      pendingSecrets.find((entry) => String(entry.requestId) === requestId) ??
      seenSecrets.get(requestId);
    if (request === undefined) return;
    const next = appendSecretOutcome(secretHistory, {
      requestId,
      threadId: String(request.threadId),
      createdAtMs: DateTime.toEpochMillis(request.createdAt),
      name: request.name,
      label: request.label,
      outcome,
    });
    setSecretHistory(next);
    writeSecretOutcomeHistory(environmentId, next);
  };

  const declineSecret = (requestId: string) => {
    if (environmentId === null) return;
    setRespondingSecretIds((current) => new Set(current).add(requestId));
    void cancelSecret({
      environmentId,
      input: { requestId: requestId as never },
    }).then((result) => {
      if (result._tag === "Success") {
        setSecretOutcomes((current) => new Map(current).set(requestId, "declined"));
        rememberSecretOutcome(requestId, "declined");
      }
      setRespondingSecretIds((current) => {
        const next = new Set(current);
        next.delete(requestId);
        return next;
      });
      pendingSecretsQuery.refresh();
    });
  };

  const decideConnectionApproval = (approvalId: string, decision: "approved" | "denied") => {
    if (environmentId === null) return;
    setRespondingApprovalIds((current) => new Set(current).add(approvalId));
    void decideApproval({
      environmentId,
      input: { approvalId: approvalId as never, decision },
    }).then((result) => {
      if (result._tag === "Success") {
        setApprovalOutcomes((current) => new Map(current).set(approvalId, decision));
      }
      setRespondingApprovalIds((current) => {
        const next = new Set(current);
        next.delete(approvalId);
        return next;
      });
      approvalsQuery.refresh();
    });
  };

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
      secrets: secretCards,
      logins: loginRequests,
      connectionApprovals: approvalCards,
      leadBotChanges,
      memoryChanges,
    });
  }, [
    approvalCards,
    children,
    input.items,
    leadBotChanges,
    loginRequests,
    memoryChanges,
    questionCards,
    secretCards,
  ]);

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
      revealCard: input.onRevealCard,
      cardMaxHeight: input.cardMaxHeight ?? null,
      secrets: {
        respondingIds: respondingSecretIds,
        onProvide: provideSecret,
        onDecline: declineSecret,
      },
      connectionApprovals: {
        respondingIds: respondingApprovalIds,
        onDecide: decideConnectionApproval,
      },
    }),
    [
      botsById,
      decideConnectionApproval,
      declineSecret,
      environmentId,
      input.botName,
      input.cardMaxHeight,
      input.chat,
      input.nowMs,
      input.onOpenChat,
      input.onRevealCard,
      input.providers,
      native,
      provideSecret,
      respondingApprovalIds,
      respondingSecretIds,
      threadId,
      waitingLabels,
    ],
  );

  const rulesUsage = native.bots.usePersonalMemoryRulesUsage(environmentId);

  return { items, context, rulesUsage: rulesUsage.data };
}
