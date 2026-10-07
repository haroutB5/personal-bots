// Groups and their members: list, create, update, remove, add and remove a member.
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  CommandId,
  PERSONAL_GROUP_DEFAULT_MAX_BOT_TURNS,
  PERSONAL_GROUP_MAX_BOT_TURNS_CEILING,
  PERSONAL_GROUP_MAX_MEMBERS,
  PersonalGroupsError,
  type PersonalGroupListResult,
} from "@t3tools/contracts";
import { GROUP_THREAD_TITLE, type GroupRecord } from "./groupShared.ts";
import type { GroupCore } from "./groupCore.ts";
import type { GroupVotes } from "./groupVotes.ts";
import type { GroupTurns } from "./groupTurns.ts";
import type { PersonalGroupService } from "./PersonalGroupService.ts";

export const makeGroupManagement = (core: GroupCore, votes: GroupVotes, turns: GroupTurns) => {
  const {
    botName,
    bots,
    dispatchOrLog,
    fail,
    groupThreadIds,
    liveBots,
    lock,
    publishGroup,
    repository,
    requireGroup,
    requireLiveBot,
    toPublic,
    toPublicGroup,
    toRound,
    writeSystemRow,
  } = core;
  const { expirePendingVotes } = votes;
  const { abandonActive, clearActive, interruptActiveTurn, writeRound } = turns;

  const list: PersonalGroupService["Service"]["list"] = () =>
    Effect.gen(function* () {
      const groups = yield* repository.listGroups();
      const published = yield* Effect.forEach(groups, (group) =>
        toPublicGroup(group, { withNewestMessage: true }),
      );
      const live = yield* repository.listLiveRounds();
      const votes = yield* repository.listPendingVotesForRounds(live.map((round) => round.roundId));
      // A group with no live round still reports its newest one, terminal or
      // not. A client that missed the round ending (a phone asleep, a socket
      // reconnecting) otherwise keeps its last "running" copy forever: the
      // replay it resubscribes to would never mention the round again.
      const liveGroupIds = new Set(live.map((round) => round.groupId));
      const settled = yield* Effect.forEach(
        groups.filter((group) => !liveGroupIds.has(group.groupId)),
        (group) => repository.latestRoundForGroup(group.groupId),
      );
      const rounds = [...live, ...settled.flatMap((round) => Option.toArray(round))];
      return {
        groups: published,
        rounds: rounds.map(toRound),
        votes,
      } satisfies PersonalGroupListResult;
    }).pipe(toPublic("list"));

  const create: PersonalGroupService["Service"]["create"] = (input) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const existing = yield* repository.getGroup(input.groupId);
          if (Option.isSome(existing)) {
            // The client minted the id, so a replayed create is the same group.
            return yield* toPublicGroup(existing.value);
          }
          const botIds = [...new Set(input.botIds)];
          if (botIds.length === 0) {
            return yield* fail("A group needs at least one bot.");
          }
          if (botIds.length > PERSONAL_GROUP_MAX_MEMBERS) {
            return yield* fail(
              `A group can have at most ${String(PERSONAL_GROUP_MAX_MEMBERS)} members.`,
            );
          }
          const members = yield* Effect.forEach(botIds, requireLiveBot);
          const name = input.name.trim().length === 0 ? "New group" : input.name.trim();
          const maxBotTurns = Math.min(
            PERSONAL_GROUP_MAX_BOT_TURNS_CEILING,
            Math.max(1, input.maxBotTurns ?? PERSONAL_GROUP_DEFAULT_MAX_BOT_TURNS),
          );
          // The group thread is created before the rows, so a failed create
          // leaves an orphan thread rather than a group pointing at nothing.
          yield* bots
            .createSharedThread({
              threadId: input.threadId,
              title: GROUP_THREAD_TITLE,
              modelSelection: members[0]!.modelSelection,
            })
            .pipe(
              Effect.mapError((cause) =>
                fail("Personal groups could not create the group chat.", cause),
              ),
            );
          const now = yield* DateTime.now;
          const group: GroupRecord = {
            groupId: input.groupId,
            name,
            description: input.description ?? "",
            threadId: input.threadId,
            maxBotTurns,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
          };
          yield* repository.transaction(
            Effect.gen(function* () {
              const inserted = yield* repository.insertGroup(group);
              if (!inserted) {
                return;
              }
              yield* Effect.forEach(
                members,
                (bot, index) =>
                  repository.insertMember({
                    groupId: group.groupId,
                    botId: bot.botId,
                    threadId: null,
                    role: "member",
                    sortOrder: index,
                    deliveredSeq: 0,
                    joinedAt: now,
                    leftAt: null,
                  }),
                { discard: true },
              );
            }),
          );
          groupThreadIds.add(group.threadId);
          return yield* publishGroup(group);
        }),
      )
      .pipe(toPublic("create"));

  const update: PersonalGroupService["Service"]["update"] = (input) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const group = yield* requireGroup(input.groupId);
          const now = yield* DateTime.now;
          const snooze = input.snoozedUntil;
          if (
            snooze != null &&
            DateTime.toEpochMillis(snooze) - DateTime.toEpochMillis(now) > 366 * 24 * 60 * 60 * 1000
          ) {
            return yield* Effect.fail(
              new PersonalGroupsError({ message: "A group can be snoozed for at most a year." }),
            );
          }
          // Archiving drops the pin and the snooze, as it does for a chat.
          const archiving = input.archived === true;
          const nextPinnedAt =
            archiving || input.pinned === false
              ? null
              : input.pinned === true
                ? (group.pinnedAt ?? now)
                : (group.pinnedAt ?? null);
          // Wake now ends a running snooze at this moment (the group comes back
          // at the top); waking a group that is not snoozed changes nothing.
          const stillSnoozed =
            group.snoozedUntil != null &&
            DateTime.toEpochMillis(group.snoozedUntil) > DateTime.toEpochMillis(now);
          const nextSnoozedUntil = archiving
            ? null
            : snooze === undefined
              ? (group.snoozedUntil ?? null)
              : snooze === null
                ? stillSnoozed
                  ? now
                  : (group.snoozedUntil ?? null)
                : snooze;
          const conversationChanged =
            input.name !== undefined ||
            input.description !== undefined ||
            input.archived !== undefined;
          const next: GroupRecord = {
            ...group,
            ...(input.name === undefined ? {} : { name: input.name.trim() }),
            ...(input.description === undefined ? {} : { description: input.description }),
            ...(input.archived === undefined ? {} : { archivedAt: input.archived ? now : null }),
            pinnedAt: nextPinnedAt,
            snoozedUntil: nextSnoozedUntil,
            // Pin and snooze are not conversation: they leave updatedAt alone.
            ...(conversationChanged ? { updatedAt: now } : {}),
          };
          yield* repository.writeGroup(next);
          return yield* publishGroup(next);
        }),
      )
      .pipe(toPublic("update"));

  const remove: PersonalGroupService["Service"]["remove"] = (input) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const group = yield* repository.getGroup(input.groupId);
          if (Option.isNone(group)) {
            return;
          }
          // Its live rounds end here, under the same permit as the delete. A
          // message sent after an earlier Stop would otherwise leave a running
          // round on a group that no longer exists.
          for (const round of yield* repository.listLiveRounds()) {
            if (round.groupId !== input.groupId) continue;
            yield* interruptActiveTurn(round, "delete");
            yield* abandonActive(group.value, round);
            yield* expirePendingVotes(round);
            yield* writeRound(round, { status: "stopped", queue: [], ...clearActive });
          }
          // These threads contain the members' private copies of this group
          // conversation. Delete their bot links while the group still exists:
          // otherwise they become ordinary chats as soon as the group vanishes.
          // Clear each cursor after deletion so a failed later step leaves a
          // usable group whose next round can open a fresh member thread.
          for (const member of yield* repository.listMembers(input.groupId)) {
            if (member.threadId === null) continue;
            yield* bots
              .deleteThread({ threadId: member.threadId })
              .pipe(
                Effect.mapError((cause) =>
                  fail("Personal groups could not delete a member chat.", cause),
                ),
              );
            yield* repository.writeMember({ ...member, threadId: null, deliveredSeq: 0 });
          }
          const now = yield* DateTime.now;
          yield* repository.softDeleteGroup({ groupId: input.groupId, deletedAt: now });
          groupThreadIds.delete(group.value.threadId);
          yield* dispatchOrLog("delete group thread", {
            type: "thread.delete",
            commandId: CommandId.make(`personal-group:thread.delete:${group.value.threadId}`),
            threadId: group.value.threadId,
          });
        }),
      )
      .pipe(toPublic("delete"));

  const addMember: PersonalGroupService["Service"]["addMember"] = (input) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const group = yield* requireGroup(input.groupId);
          const members = yield* repository.listMembers(input.groupId);
          if (members.some((member) => member.botId === input.botId)) {
            return yield* toPublicGroup(group);
          }
          if (members.length >= PERSONAL_GROUP_MAX_MEMBERS) {
            return yield* fail(
              `A group can have at most ${String(PERSONAL_GROUP_MAX_MEMBERS)} members.`,
            );
          }
          const bot = yield* requireLiveBot(input.botId);
          const now = yield* DateTime.now;
          // A member joining mid-conversation starts at the current cursor:
          // it is told what has been said since it joined, not the backlog.
          const deliveredSeq = yield* repository.latestSeq(input.groupId);
          yield* repository.insertMember({
            groupId: input.groupId,
            botId: input.botId,
            threadId: null,
            role: input.role ?? "member",
            sortOrder: members.reduce((max, member) => Math.max(max, member.sortOrder), -1) + 1,
            deliveredSeq,
            joinedAt: now,
            leftAt: null,
          });
          yield* writeSystemRow(group, null, "member-added", `${bot.name} joined the group.`);
          return yield* publishGroup(group);
        }),
      )
      .pipe(toPublic("addMember"));

  const removeMember: PersonalGroupService["Service"]["removeMember"] = (input) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const group = yield* requireGroup(input.groupId);
          const members = yield* repository.listMembers(input.groupId);
          if (!members.some((member) => member.botId === input.botId)) {
            return yield* toPublicGroup(group);
          }
          const all = yield* liveBots();
          yield* repository.removeMember({ groupId: input.groupId, botId: input.botId });
          yield* writeSystemRow(
            group,
            null,
            "member-removed",
            `${botName(all, input.botId)} left the group.`,
          );
          const remaining = yield* repository.listMembers(input.groupId);
          if (remaining.length === 0 && group.archivedAt === null) {
            // An empty group is archived, never deleted: the transcript is the
            // record of a conversation that actually happened.
            const now = yield* DateTime.now;
            const archived: GroupRecord = { ...group, archivedAt: now, updatedAt: now };
            yield* repository.writeGroup(archived);
            return yield* publishGroup(archived);
          }
          return yield* publishGroup(group);
        }),
      )
      .pipe(toPublic("removeMember"));

  return { addMember, create, list, remove, removeMember, update };
};

export type GroupManagement = ReturnType<typeof makeGroupManagement>;
