import * as Effect from "effect/Effect";

import { PersonalGroupsError, type PersonalGroupDeleteInput } from "@t3tools/contracts";

import { purgePersonalBot, type PersonalBotPurgeServices } from "./purgePersonalBot.ts";

/**
 * Deletes a group, and the member bots the owner ticked in the confirm sheet.
 *
 * This lives beside `purgePersonalBot` rather than inside `PersonalGroupService`
 * on purpose: purging a bot needs tasks, routines, memories, secrets and the
 * orchestration engine, and `purgePersonalBot` already needs the group service.
 * A group service that called it back would be a layer cycle. The composition
 * site is therefore here, where both halves are plain function arguments and a
 * test can hand it fakes.
 *
 * The order is the whole safety argument:
 *
 * 1. **Validate first, touch nothing.** Every id in `purgeBotIds` must name a
 *    current member of this group. One stranger refuses the entire call, before
 *    the round is stopped and before a single bot is purged, so a stale or
 *    tampered sheet cannot destroy a bot the owner never saw listed.
 * 2. **Stop the round.** A live round holds a member turn, a queue and a lease
 *    against a thread that is about to be deleted. `stop` is the existing path
 *    and is a no-op when nothing is live.
 * 3. **Purge the ticked bots**, in the order the sheet listed them. Each goes
 *    through `purgePersonalBot`, so its memberships of OTHER groups are dropped
 *    with a system row in each, and a group the deletion empties is archived,
 *    never deleted.
 * 4. **Delete the group last.**
 *
 * If one purge fails, the call aborts there and **the group is not deleted**.
 * That is the recoverable end state: the bots before it are gone, the bots
 * after it are untouched, and the group is still on screen with the members it
 * has left, so re-opening Delete group offers exactly what is still there.
 * Deleting the group first would have left a half-purged bot with no surface to
 * retry from.
 */
export const deletePersonalGroup = Effect.fn("deletePersonalGroup")(function* (
  services: PersonalBotPurgeServices,
  input: PersonalGroupDeleteInput,
) {
  const { groups } = services;
  const requested = new Set<string>(input.purgeBotIds ?? []);

  const { groups: all } = yield* groups.list();
  const group = all.find((entry) => entry.groupId === input.groupId);
  if (group === undefined) {
    // Already gone. Deleting it again is the no-op it has always been - but
    // only when nothing was ticked, or we would be purging bots on the word of
    // a sheet whose group no longer exists.
    if (requested.size > 0) {
      return yield* new PersonalGroupsError({
        message: "That group no longer exists, so its bots were not deleted.",
      });
    }
    return;
  }

  const memberIds = new Set(group.members.map((member) => member.botId as string));
  const strangers = [...requested].filter((botId) => !memberIds.has(botId));
  if (strangers.length > 0) {
    return yield* new PersonalGroupsError({
      message: `Only bots that are in this group can be deleted with it: ${strangers.join(", ")} ${
        strangers.length === 1 ? "is not" : "are not"
      } a member.`,
    });
  }

  yield* groups.stop({ groupId: input.groupId });

  // Member order, not the order the client happened to send, so the system rows
  // and the logs read the way the sheet did.
  for (const member of group.members) {
    if (!requested.has(member.botId as string)) continue;
    yield* purgePersonalBot(services, member.botId).pipe(
      Effect.mapError(
        (cause) =>
          new PersonalGroupsError({
            message:
              "Couldn't delete one of the bots, so the group was kept. " +
              "Bots deleted before it are gone; the rest are untouched.",
            cause,
          }),
      ),
    );
  }

  yield* groups.remove({ groupId: input.groupId });
});
