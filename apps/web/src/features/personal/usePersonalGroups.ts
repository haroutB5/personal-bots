import type { EnvironmentId, PersonalGroup, PersonalGroupRound } from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery } from "../../state/query";

/** Groups and their live rounds for one environment. */
export const personalGroupsList = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "personal-groups:list",
  tag: WS_METHODS.personalGroupsList,
  staleTimeMs: 10_000,
  idleTtlMs: 5 * 60_000,
});

export interface PersonalGroupsFeedState {
  readonly groups: ReadonlyMap<string, PersonalGroup>;
  readonly rounds: ReadonlyMap<string, PersonalGroupRound>;
}

const EMPTY_FEED: PersonalGroupsFeedState = { groups: new Map(), rounds: new Map() };

/**
 * State only, as `personalGroups.subscribe` is defined: the transcript arrives
 * on the group thread's ordinary thread-detail subscription, so a phone in a
 * group holds one subscription for the conversation, not two.
 *
 * Chunked exactly like the tasks feed: the replay is one event per group and
 * per round, and folding it per event would copy both maps n times (O(n²)) and
 * re-render every consumer n times. Live events still land within 50ms.
 */
export const personalGroupsFeed = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "personal-groups:feed",
    tag: WS_METHODS.personalGroupsSubscribe,
    transform: (stream) =>
      stream.pipe(
        Stream.groupedWithin(256, "50 millis"),
        Stream.scan(EMPTY_FEED, (state, events) => {
          const groups = new Map(state.groups);
          const rounds = new Map(state.rounds);
          for (const event of events) {
            if (event.type === "group") {
              groups.set(event.group.groupId, event.group);
            } else {
              // One live round per group: a newer round for the same group
              // replaces the old one rather than accumulating history here.
              rounds.set(event.round.groupId, event.round);
            }
          }
          return { groups, rounds };
        }),
      ),
  },
);

const refreshGroupsList = (
  target: { readonly environmentId: EnvironmentId },
  registry: { refresh: (atom: ReturnType<typeof personalGroupsList>) => void },
) =>
  Effect.sync(() =>
    registry.refresh(personalGroupsList({ environmentId: target.environmentId, input: {} })),
  );

export const personalGroupCreate = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-groups:create",
  tag: WS_METHODS.personalGroupsCreate,
  onSuccess: refreshGroupsList,
});

export const personalGroupUpdate = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-groups:update",
  tag: WS_METHODS.personalGroupsUpdate,
  onSuccess: refreshGroupsList,
});

export const personalGroupDelete = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-groups:delete",
  tag: WS_METHODS.personalGroupsDelete,
  onSuccess: refreshGroupsList,
});

export const personalGroupAddMember = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-groups:add-member",
  tag: WS_METHODS.personalGroupsAddMember,
  onSuccess: refreshGroupsList,
});

export const personalGroupRemoveMember = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-groups:remove-member",
  tag: WS_METHODS.personalGroupsRemoveMember,
  onSuccess: refreshGroupsList,
});

/**
 * Opens a round. The message itself lands on the group thread and arrives over
 * the thread-detail subscription, so nothing here refreshes the list: the round
 * comes back as the result and again on the feed.
 */
export const personalGroupSendMessage = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-groups:send-message",
  tag: WS_METHODS.personalGroupsSendMessage,
});

export const personalGroupContinueRound = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-groups:continue-round",
  tag: WS_METHODS.personalGroupsContinueRound,
});

export const personalGroupStop = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-groups:stop",
  tag: WS_METHODS.personalGroupsStop,
});

export function usePersonalGroupsList(environmentId: EnvironmentId | null) {
  const atom = useMemo(
    () => (environmentId === null ? null : personalGroupsList({ environmentId, input: {} })),
    [environmentId],
  );
  return useEnvironmentQuery(atom);
}

/**
 * The live feed. Pass `null` to hold it back — ChatsScreen arms it a frame
 * after its first paint so the replay cannot contend with the measured
 * cold-start paint, exactly as it holds back the tasks feed.
 */
export function usePersonalGroupsFeed(environmentId: EnvironmentId | null) {
  const atom = useMemo(
    () => (environmentId === null ? null : personalGroupsFeed({ environmentId, input: {} })),
    [environmentId],
  );
  const query = useEnvironmentQuery(atom);
  return { feed: query.data, error: query.error };
}

const NO_GROUPS: ReadonlyArray<PersonalGroup> = [];
const NO_ROUNDS: ReadonlyArray<PersonalGroupRound> = [];

/**
 * Groups and rounds from whichever source has them: the feed once it is armed
 * and has replayed, the list query before that. Keeping the list underneath is
 * what lets the Chats screen paint group rows on the same frame as bot rows,
 * before any subscription exists.
 */
export function mergePersonalGroups(
  list: {
    readonly groups: ReadonlyArray<PersonalGroup>;
    readonly rounds: ReadonlyArray<PersonalGroupRound>;
  } | null,
  feed: PersonalGroupsFeedState | null,
): {
  readonly groups: ReadonlyArray<PersonalGroup>;
  readonly rounds: ReadonlyArray<PersonalGroupRound>;
} {
  const groups = new Map<string, PersonalGroup>();
  for (const group of list?.groups ?? NO_GROUPS) groups.set(group.groupId, group);
  for (const [groupId, group] of feed?.groups ?? new Map()) groups.set(groupId, group);
  const rounds = new Map<string, PersonalGroupRound>();
  for (const round of list?.rounds ?? NO_ROUNDS) rounds.set(round.groupId, round);
  for (const [groupId, round] of feed?.rounds ?? new Map()) rounds.set(groupId, round);
  // Frozen so callers - and the React compiler - can treat the result as a
  // value: nothing downstream has any business sorting or splicing it in place.
  return {
    groups: Object.freeze([...groups.values()].filter((group) => group.archivedAt === null)),
    rounds: Object.freeze([...rounds.values()]),
  };
}
