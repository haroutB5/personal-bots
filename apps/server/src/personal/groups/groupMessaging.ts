// @effect-diagnostics nodeBuiltinImport:off - same node access as PersonalGroupService.ts.
// The owner speaking into a group, and who may speak in a live turn.
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { CommandId, PersonalGroupRoundId, ThreadId } from "@t3tools/contracts";
import { parseMentions } from "./groupMentions.ts";
import * as PersonalGroupRepository from "./PersonalGroupRepository.ts";
import {
  type RoundRecord,
  type WorkItem,
  budgetFor,
  personalGroupMessageContext,
  windowMsFor,
} from "./groupShared.ts";
import type { GroupCore } from "./groupCore.ts";
import type { PersonalGroupService } from "./PersonalGroupService.ts";

export const makeGroupMessaging = (
  core: GroupCore,
  glue: { readonly worker: { readonly enqueue: (item: WorkItem) => Effect.Effect<void> } },
) => {
  const {
    botName,
    engine,
    fail,
    liveBots,
    lock,
    publishRound,
    repository,
    requireGroup,
    toPublic,
    toRound,
  } = core;
  const { worker } = glue;

  const sendMessage: PersonalGroupService["Service"]["sendMessage"] = (input) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const group = yield* requireGroup(input.groupId);
          const members = yield* repository.listMembers(input.groupId);
          if (members.length === 0) {
            return yield* fail("This group has no members left to reply.");
          }
          const existingMessage = yield* repository.getMessageByMessageId(input.messageId);
          const latest = yield* repository.latestRoundForGroup(input.groupId);
          const liveRound = Option.filter(latest, (round) =>
            PersonalGroupRepository.PERSONAL_GROUP_LIVE_ROUND_STATUSES.some(
              (status) => status === round.status,
            ),
          );
          if (Option.isSome(existingMessage)) {
            // A resend of the same client-minted id: never a second round.
            const round =
              existingMessage.value.roundId === null
                ? Option.none<RoundRecord>()
                : yield* repository.getRound(existingMessage.value.roundId);
            if (Option.isSome(round)) {
              return toRound(round.value);
            }
            if (Option.isSome(liveRound)) {
              return toRound(liveRound.value);
            }
            return yield* fail("That message has already been sent to this group.");
          }

          const now = yield* DateTime.now;
          const roundId = Option.isSome(liveRound)
            ? liveRound.value.roundId
            : PersonalGroupRoundId.make(NodeCrypto.randomUUID());
          const row = yield* repository.insertMessage({
            groupId: group.groupId,
            messageId: input.messageId,
            speakerKind: "user",
            speakerBotId: null,
            roundId,
            createdAt: now,
          });
          yield* engine
            .dispatch({
              type: "thread.message.user.append",
              commandId: CommandId.make(`personal-group:${input.messageId}:append`),
              threadId: group.threadId,
              message: {
                messageId: input.messageId,
                text: input.text,
                attachments: [],
                context: personalGroupMessageContext(
                  {
                    groupId: group.groupId,
                    seq: row.seq,
                    roundId,
                    speaker: { kind: "user" },
                  },
                  input.replyTo,
                ),
              },
              createdAt: DateTime.formatIso(now),
            })
            .pipe(
              Effect.mapError((cause) =>
                fail("Personal groups could not post the message.", cause),
              ),
            );

          if (Option.isSome(liveRound)) {
            // One live round per group. The new message is in the transcript,
            // so the next member to speak picks it up in its catch-up rather
            // than racing a second round for the same single slot.
            return toRound(liveRound.value);
          }

          const all = yield* liveBots();
          const mentioned = parseMentions(
            input.text,
            members.map((member) => ({ botId: member.botId, name: botName(all, member.botId) })),
          );
          const addressed = mentioned.filter((botId) =>
            members.some((member) => member.botId === botId),
          );
          const coordinator = members.find((member) => member.role === "coordinator");
          const firstSpeaker = (coordinator ?? members[0]!).botId;
          const discussionOrder = [
            firstSpeaker,
            ...members
              .filter((member) => member.botId !== firstSpeaker)
              .map((member) => member.botId),
          ];
          // One contribution per member, then one reserved synthesis turn.
          // Explicit mentions retain their targeted conversation behavior.
          const broadcast = addressed.length === 0;
          const queue = broadcast ? discussionOrder : addressed;
          const verdictBotId = broadcast && members.length > 1 ? firstSpeaker : null;
          const round: RoundRecord = {
            roundId,
            groupId: group.groupId,
            triggerMessageId: input.messageId,
            verdictBotId,
            status: "running",
            // A broadcast round is sized to the group: every member is queued
            // and the per-member cap lets each take two turns, so a fixed six
            // would pause a six-member discussion halfway through its own
            // plan. A round aimed at named members keeps the frozen rail.
            budgetRemaining: budgetFor({
              frozenMaxBotTurns: group.maxBotTurns,
              memberCount: members.length,
              broadcast,
            }),
            queue,
            spoken: [],
            activeBotId: null,
            activeThreadId: null,
            activeTurnId: null,
            activeMessageId: null,
            relayedChars: 0,
            leaseOwner: null,
            leaseExpiresAt: null,
            availableAt: null,
            // Turns are serial, so the window is the queue's length in turns,
            // plus the reserved verdict, times one provider turn.
            deadlineAt: DateTime.add(now, {
              milliseconds: windowMsFor(queue.length + (verdictBotId === null ? 0 : 1)),
            }),
            errorMessage: null,
            createdAt: now,
            updatedAt: now,
          };
          yield* repository.insertRound(round);
          yield* publishRound(round);
          yield* worker.enqueue({ type: "pump" });
          return toRound(round);
        }),
      )
      .pipe(toPublic("sendMessage"));

  /**
   * The live group turn the calling member is in the middle of, or a refusal.
   * `getRoundByActiveThread` already filters to live rounds, so this single
   * query IS the "outside a group round" check of section V.1 - there is
   * nowhere else a vote could come from.
   */
  const requireSpeakingMember = Effect.fn("PersonalGroupService.requireSpeakingMember")(function* (
    threadId: ThreadId,
    what: string,
  ) {
    const found = yield* repository.getRoundByActiveThread(threadId);
    const nobody = fail(
      `You are not speaking in a group chat right now, so there is nothing to ${what}.`,
    );
    if (Option.isNone(found)) {
      return yield* nobody;
    }
    const round = found.value;
    const botId = round.activeBotId;
    if (botId === null) {
      return yield* nobody;
    }
    const group = yield* requireGroup(round.groupId);
    const members = yield* repository.listMembers(group.groupId);
    if (!members.some((member) => member.botId === botId)) {
      return yield* fail(`You are not a member of '${group.name}'.`);
    }
    return { round, group, members, botId };
  });

  return { requireSpeakingMember, sendMessage };
};

export type GroupMessaging = ReturnType<typeof makeGroupMessaging>;
