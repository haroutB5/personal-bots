import type {
  EnvironmentId,
  PersonalGroup,
  PersonalGroupRound,
  PersonalGroupStreamEvent,
  PersonalGroupVote,
} from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import type { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { useMemo } from "react";

import type { PersonalClient } from "../client.ts";
import { groupRelayThreadIds } from "../conversation/groupModel.ts";

/**
 * Marks a subscription feed as loaded before its first event.
 *
 * A feed folds its replay with `Stream.scan`, and `scan` emits nothing when its
 * upstream emits nothing. On a root with no data the replay is empty and the
 * feed never produces a first value, so a consumer that reads `null` as
 * "still loading" sits on "Loading…" instead of showing its empty state.
 */
export function feedStartsWith<A>(initial: A) {
  return <E, R>(stream: Stream.Stream<A, E, R>): Stream.Stream<A, E, R> =>
    stream.pipe(Stream.prepend([initial]));
}

export interface PersonalGroupsFeedState {
  readonly groups: ReadonlyMap<string, PersonalGroup>;
  readonly rounds: ReadonlyMap<string, PersonalGroupRound>;
  /**
   * Keyed by vote id, not by group: a round can settle more than one question,
   * and the tally card has to name the one it is asking about.
   */
  readonly votes: ReadonlyMap<string, PersonalGroupVote>;
}

export const EMPTY_PERSONAL_GROUPS_FEED: PersonalGroupsFeedState = {
  groups: new Map(),
  rounds: new Map(),
  votes: new Map(),
};

/**
 * One chunk of feed events folded into the state. Extracted from the atom so
 * it can be tested as what it is - a pure reducer - rather than only through a
 * live subscription.
 */
export function foldPersonalGroupsFeed(
  state: PersonalGroupsFeedState,
  events: Iterable<PersonalGroupStreamEvent>,
): PersonalGroupsFeedState {
  const groups = new Map(state.groups);
  const rounds = new Map(state.rounds);
  const votes = new Map(state.votes);
  for (const event of events) {
    if (event.type === "group") {
      groups.set(event.group.groupId, event.group);
    } else if (event.type === "vote") {
      votes.set(event.vote.voteId, event.vote);
    } else {
      // One live round per group: a newer round for the same group replaces
      // the old one rather than accumulating history here.
      rounds.set(event.round.groupId, event.round);
    }
  }
  return { groups, rounds, votes };
}

/**
 * State only, as `personalGroups.subscribe` is defined: the transcript arrives
 * on the group thread's ordinary thread-detail subscription.
 *
 * Chunked exactly like the tasks feed: the replay is one event per group and
 * per round, and folding it per event would copy both maps n times (O(n²)).
 * The empty feed goes first so a connection with no groups still produces a
 * value.
 */
export function foldPersonalGroupsStream<E, R>(
  stream: Stream.Stream<PersonalGroupStreamEvent, E, R>,
): Stream.Stream<PersonalGroupsFeedState, E, R> {
  return feedStartsWith(EMPTY_PERSONAL_GROUPS_FEED)(
    stream.pipe(
      Stream.groupedWithin(256, "50 millis"),
      Stream.scan(EMPTY_PERSONAL_GROUPS_FEED, foldPersonalGroupsFeed),
    ),
  );
}

const NO_GROUPS: ReadonlyArray<PersonalGroup> = [];
const NO_THREAD_IDS: ReadonlySet<string> = new Set();
const NO_ROUNDS: ReadonlyArray<PersonalGroupRound> = [];
const NO_VOTES: ReadonlyArray<PersonalGroupVote> = [];

/**
 * Groups and rounds from whichever source has them: the feed once it is armed
 * and has replayed, the list query before that. Keeping the list underneath is
 * what lets a list paint group rows on the same frame as bot rows, before any
 * subscription exists.
 */
export function mergePersonalGroups(
  list: {
    readonly groups: ReadonlyArray<PersonalGroup>;
    readonly rounds: ReadonlyArray<PersonalGroupRound>;
    readonly votes?: ReadonlyArray<PersonalGroupVote> | undefined;
  } | null,
  feed: PersonalGroupsFeedState | null,
): {
  readonly groups: ReadonlyArray<PersonalGroup>;
  /**
   * Archived is "hide, not delete": the server still lists them (only a
   * deleted group drops out), so they stay reachable from the list's archived
   * section, search and a saved link.
   */
  readonly archivedGroups: ReadonlyArray<PersonalGroup>;
  readonly rounds: ReadonlyArray<PersonalGroupRound>;
  readonly votes: ReadonlyArray<PersonalGroupVote>;
} {
  const groups = new Map<string, PersonalGroup>();
  for (const group of list?.groups ?? NO_GROUPS) groups.set(group.groupId, group);
  for (const [groupId, group] of feed?.groups ?? new Map()) groups.set(groupId, group);
  const rounds = new Map<string, PersonalGroupRound>();
  for (const round of list?.rounds ?? NO_ROUNDS) rounds.set(round.groupId, round);
  for (const [groupId, round] of feed?.rounds ?? new Map()) rounds.set(groupId, round);
  const votes = new Map<string, PersonalGroupVote>();
  for (const vote of list?.votes ?? NO_VOTES) votes.set(vote.voteId, vote);
  for (const [voteId, vote] of feed?.votes ?? new Map()) votes.set(voteId, vote);
  // Frozen so callers can treat the result as a value: nothing downstream has
  // any business sorting or splicing it in place.
  const all = [...groups.values()];
  return {
    groups: Object.freeze(all.filter((group) => group.archivedAt === null)),
    archivedGroups: Object.freeze(all.filter((group) => group.archivedAt !== null)),
    rounds: Object.freeze([...rounds.values()]),
    votes: Object.freeze([...votes.values()]),
  };
}

/**
 * Builds the groups list, its live feed, every group mutation, and the hooks
 * the screens read. The apps own the connection runtime and the ports, so the
 * package owns no web singleton and no environment selection.
 *
 * Membership moves a bot in or out of the Chats list (a bot only in groups is
 * hidden there, see `PersonalBot.groupOnly`), so every change to who is in a
 * group refetches the bots list with the groups. The bots list atom family
 * belongs to the bots client, so the app passes that refresh in.
 */
export function createPersonalGroupsClient<R, ER, P>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, ER>,
  client: PersonalClient<R, ER, P>,
  options: {
    readonly refreshBots?: (
      registry: AtomRegistry.AtomRegistry,
      environmentId: EnvironmentId,
    ) => void;
  } = {},
) {
  /** Groups and their live rounds for one environment. */
  const personalGroupsList = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "personal-groups:list",
    tag: WS_METHODS.personalGroupsList,
    staleTimeMs: 10_000,
    idleTtlMs: 5 * 60_000,
  });

  /** Live group, round and vote events for one environment. */
  const personalGroupsFeed = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "personal-groups:feed",
    tag: WS_METHODS.personalGroupsSubscribe,
    transform: foldPersonalGroupsStream,
  });

  const refreshGroupsAndBots = (
    target: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() => {
      registry.refresh(personalGroupsList({ environmentId: target.environmentId, input: {} }));
      options.refreshBots?.(registry, target.environmentId);
    });

  const personalGroupCreate = createEnvironmentRpcCommand(runtime, {
    label: "personal-groups:create",
    tag: WS_METHODS.personalGroupsCreate,
    onSuccess: refreshGroupsAndBots,
  });

  const personalGroupUpdate = createEnvironmentRpcCommand(runtime, {
    label: "personal-groups:update",
    tag: WS_METHODS.personalGroupsUpdate,
    onSuccess: refreshGroupsAndBots,
  });

  const personalGroupDelete = createEnvironmentRpcCommand(runtime, {
    label: "personal-groups:delete",
    tag: WS_METHODS.personalGroupsDelete,
    onSuccess: refreshGroupsAndBots,
  });

  const personalGroupAddMember = createEnvironmentRpcCommand(runtime, {
    label: "personal-groups:add-member",
    tag: WS_METHODS.personalGroupsAddMember,
    onSuccess: refreshGroupsAndBots,
  });

  const personalGroupRemoveMember = createEnvironmentRpcCommand(runtime, {
    label: "personal-groups:remove-member",
    tag: WS_METHODS.personalGroupsRemoveMember,
    onSuccess: refreshGroupsAndBots,
  });

  /**
   * Opens a round. The message itself lands on the group thread and arrives
   * over the thread-detail subscription, so nothing here refreshes the list:
   * the round comes back as the result and again on the feed.
   */
  const personalGroupSendMessage = createEnvironmentRpcCommand(runtime, {
    label: "personal-groups:send-message",
    tag: WS_METHODS.personalGroupsSendMessage,
  });

  const personalGroupContinueRound = createEnvironmentRpcCommand(runtime, {
    label: "personal-groups:continue-round",
    tag: WS_METHODS.personalGroupsContinueRound,
  });

  const personalGroupStop = createEnvironmentRpcCommand(runtime, {
    label: "personal-groups:stop",
    tag: WS_METHODS.personalGroupsStop,
  });

  function usePersonalGroupsList(environmentId: EnvironmentId | null) {
    const atom = useMemo(
      () => (environmentId === null ? null : personalGroupsList({ environmentId, input: {} })),
      [environmentId],
    );
    return client.useEnvironmentQuery(atom);
  }

  /**
   * The live feed. Pass `null` to hold it back, so a root's first paint does
   * not contend with the replay.
   */
  function usePersonalGroupsFeed(environmentId: EnvironmentId | null) {
    const atom = useMemo(
      () => (environmentId === null ? null : personalGroupsFeed({ environmentId, input: {} })),
      [environmentId],
    );
    const query = client.useEnvironmentQuery(atom);
    return { feed: query.data, error: query.error };
  }

  /**
   * Group relay thread ids for a screen that lists a bot's chats but has no
   * other use for groups. Same list-then-feed merge as the Chats screen, so a
   * relay created after the list loaded (a member's first reply) is hidden too.
   *
   * Empty while the groups load: the bots list's own `groupRelay` flags hide
   * every relay it knows until then (`isGroupRelayLink`), so nothing waits.
   */
  function usePersonalGroupRelayThreadIds(
    environmentId: EnvironmentId | null,
  ): ReadonlySet<string> {
    const list = usePersonalGroupsList(environmentId);
    const { feed } = usePersonalGroupsFeed(environmentId);
    return useMemo(
      () =>
        list.data === null && feed === null
          ? NO_THREAD_IDS
          : groupRelayThreadIds(mergePersonalGroups(list.data ?? null, feed ?? null)),
      [list.data, feed],
    );
  }

  return {
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
  };
}

export type PersonalGroupsClient = ReturnType<typeof createPersonalGroupsClient>;
