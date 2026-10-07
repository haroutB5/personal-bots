import {
  CHAT_NAME_TAKEN_CODE,
  PersonalBotsError,
  chatNameTakenMessage,
  normalizeChatName,
  type PersonalBotId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { DEFAULT_THREAD_TITLE } from "../orchestration/threadTitles.ts";
import type * as PersonalBotRepository from "./PersonalBotRepository.ts";
import { PERSONAL_THREAD_TITLE } from "./personalThreadTitles.ts";

/**
 * One bot's open chats have unique names (1.66.5): trimmed, inner whitespace
 * collapsed, case ignored. Archived and deleted chats, other bots' chats and
 * group relays never count.
 *
 * - A name the owner types is refused when it is taken (`requireFreeOwnerTitle`,
 *   `chat_name_taken`).
 * - Any name a machine picks (a task or routine chat, a first-message seed, an
 *   AI or provider title, a regeneration, an unarchive) never fails: it gets
 *   " 2", " 3", ... after it (`uniqueChatTitle`).
 * - The placeholder titles ("New chat", "New thread") are exempt on both
 *   sides: a bot can have any number of chats that are not named yet.
 *
 * Every title write goes through `withChatTitleLock`, which makes the read of
 * the open names and the write one step in this process, so two chats named at
 * the same time cannot pick the same free number.
 */

/** The chat-title lock. Module-level: one server process owns the database. */
const chatTitleLock = Semaphore.makeUnsafe(1);

export const withChatTitleLock = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => chatTitleLock.withPermits(1)(effect);

/** What the title checks read; the real `PersonalBotRepository` satisfies it. */
export type ChatTitleRepository = Pick<
  PersonalBotRepository.PersonalBotRepository["Service"],
  "listOpenChatTitles" | "getChatTitleScope"
>;

/** A placeholder is not a name: it is never refused and never suffixed. */
export const isPlaceholderChatTitle = (title: string): boolean => {
  const trimmed = title.trim();
  return trimmed === PERSONAL_THREAD_TITLE || trimmed === DEFAULT_THREAD_TITLE;
};

const takenNames = (titles: Iterable<string>): Set<string> => {
  const taken = new Set<string>();
  for (const title of titles) {
    if (!isPlaceholderChatTitle(title)) taken.add(normalizeChatName(title));
  }
  return taken;
};

/** Whether `title` is the name of one of `others` (placeholders never are). */
export const chatNameIsTaken = (title: string, others: Iterable<string>): boolean =>
  !isPlaceholderChatTitle(title) && takenNames(others).has(normalizeChatName(title));

/**
 * `title` itself when no other chat has it, else the title plus the lowest
 * free number from 2: "Morning report", "Morning report 2", "Morning report 3".
 */
export const uniqueChatTitle = (title: string, others: Iterable<string>): string => {
  if (isPlaceholderChatTitle(title)) return title;
  const taken = takenNames(others);
  if (!taken.has(normalizeChatName(title))) return title;
  for (let number = 2; ; number += 1) {
    const candidate = `${title.trim()} ${number}`;
    if (!taken.has(normalizeChatName(candidate))) return candidate;
  }
};

const isPersonalBotsError = Schema.is(PersonalBotsError);

const nameTaken = (title: string) =>
  new PersonalBotsError({
    message: chatNameTakenMessage(title.trim()),
    code: CHAT_NAME_TAKEN_CODE,
  });

/**
 * A name the owner typed for a chat that exists: fails with `chat_name_taken`
 * when another open chat of the same bot has it. Call it inside
 * `withChatTitleLock`, around the write. A chat outside the rule (not a bot
 * chat, archived, a relay) passes.
 */
export const requireFreeOwnerTitle = (
  repository: ChatTitleRepository,
  input: { readonly threadId: ThreadId; readonly title: string },
): Effect.Effect<void, PersonalBotsError> =>
  Effect.gen(function* () {
    if (isPlaceholderChatTitle(input.title)) return;
    const scope = yield* Effect.suspend(() => repository.getChatTitleScope(input));
    if (Option.isNone(scope) || scope.value.archived) return;
    if (chatNameIsTaken(input.title, scope.value.peerTitles)) return yield* nameTaken(input.title);
  }).pipe(Effect.catchCause(failOnlyWithTakenName));

/** The same check for a chat that is about to be created for `botId`. */
export const requireFreeOwnerTitleForBot = (
  repository: ChatTitleRepository,
  input: { readonly botId: PersonalBotId; readonly title: string },
): Effect.Effect<void, PersonalBotsError> =>
  Effect.gen(function* () {
    if (isPlaceholderChatTitle(input.title)) return;
    const titles = yield* Effect.suspend(() =>
      repository.listOpenChatTitles({ botId: input.botId }),
    );
    if (chatNameIsTaken(input.title, titles)) return yield* nameTaken(input.title);
  }).pipe(Effect.catchCause(failOnlyWithTakenName));

// A failed read of the names must not block a rename or a title: only the
// refusal itself reaches the caller; anything else is logged and lets it through.
function failOnlyWithTakenName(
  cause: Cause.Cause<unknown>,
): Effect.Effect<void, PersonalBotsError> {
  const failure = Cause.findErrorOption(cause);
  if (Option.isSome(failure) && isPersonalBotsError(failure.value)) {
    return Effect.fail(failure.value);
  }
  return Effect.logWarning("personal chat name check failed; letting the name through", {
    cause: Cause.pretty(cause),
  });
}

/**
 * The title a machine-made name becomes for an existing chat: `title`, or
 * `title` plus the lowest free number. Never fails: a chat outside the rule
 * (not a bot chat, archived, a relay) or a failed read keeps `title`.
 */
export const uniqueAutomaticTitle = (
  repository: ChatTitleRepository,
  input: { readonly threadId: ThreadId; readonly title: string },
): Effect.Effect<string> =>
  Effect.gen(function* () {
    if (isPlaceholderChatTitle(input.title)) return input.title;
    const scope = yield* Effect.suspend(() => repository.getChatTitleScope(input));
    if (Option.isNone(scope) || scope.value.archived) return input.title;
    return uniqueChatTitle(input.title, scope.value.peerTitles);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("personal chat title uniqueness check failed; keeping the title", {
        cause: Cause.pretty(cause),
      }).pipe(Effect.as(input.title)),
    ),
  );

/** The same for a chat that is about to be created for `botId`. Never fails. */
export const uniqueAutomaticTitleForBot = (
  repository: ChatTitleRepository,
  input: { readonly botId: PersonalBotId; readonly title: string },
): Effect.Effect<string> =>
  Effect.gen(function* () {
    if (isPlaceholderChatTitle(input.title)) return input.title;
    const titles = yield* Effect.suspend(() =>
      repository.listOpenChatTitles({ botId: input.botId }),
    );
    return uniqueChatTitle(input.title, titles);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("personal chat title uniqueness check failed; keeping the title", {
        cause: Cause.pretty(cause),
      }).pipe(Effect.as(input.title)),
    ),
  );

/**
 * The name an archived chat comes back with: its own title, or the title plus
 * the lowest free number when another open chat of its bot has taken it since.
 * Null when it keeps its title. Never fails.
 */
export const unarchivedChatTitle = (
  repository: ChatTitleRepository,
  input: { readonly threadId: ThreadId; readonly title: string },
): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    if (isPlaceholderChatTitle(input.title)) return null;
    const scope = yield* Effect.suspend(() => repository.getChatTitleScope(input));
    if (Option.isNone(scope)) return null;
    const unique = uniqueChatTitle(input.title, scope.value.peerTitles);
    return unique === input.title ? null : unique;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("personal chat unarchive title check failed; keeping the title", {
        cause: Cause.pretty(cause),
      }).pipe(Effect.as(null)),
    ),
  );
