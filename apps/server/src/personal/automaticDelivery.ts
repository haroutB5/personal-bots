import { normalizeChatName, type PersonalBotId, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import type * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { isPlaceholderChatTitle } from "./personalChatTitles.ts";
import type * as PersonalBotRepository from "./PersonalBotRepository.ts";

/**
 * Where an automatic message goes (1.66.8). A release notice, a routine run, a
 * delegated task's result for its parent: none of them is something the owner
 * typed, so none may bring back a chat he archived. Only his own action (a tap
 * on the archived chat, a message sent in it) unarchives; that path is the
 * turn-start listener in PersonalTaskChatArchive and stays as it is.
 *
 * `resolveDeliveryThread` answers for one intended chat:
 * - open (not archived, not deleted): deliver there, as before;
 * - archived or deleted: the same bot's open chat with the same title (the
 *   title the target had); several: the most recently active; none by that
 *   title: the bot's most recently active open chat (unless `sameTitleOnly`);
 *   the bot has no open chat at all: `new-chat`, and the caller makes one.
 *   With `archivedOnly` a chat with no link row is not traced (`unknown`).
 *   With `sameTitleOnly` the fallback to another chat is off: no chat of that
 *   name means `new-chat` (a routine's output does not belong in a stranger).
 *   The archived chat is never touched, so it keeps its place and its name.
 * - nothing ties the id to a bot: `unknown`.
 *
 * A chat made for a delegated task or routine run is a work item, not a
 * conversation, so a conversation is preferred over one when picking.
 */
export type DeliveryTarget =
  | { readonly kind: "open"; readonly threadId: ThreadId }
  | {
      readonly kind: "redirect";
      readonly threadId: ThreadId;
      readonly from: ThreadId;
      readonly reason: "same-title" | "most-recent";
    }
  | {
      readonly kind: "new-chat";
      readonly from: ThreadId;
      readonly botId: PersonalBotId;
      readonly title: string | null;
    }
  | { readonly kind: "unknown" };

export interface DeliveryDeps {
  readonly repository: Pick<
    PersonalBotRepository.PersonalBotRepository["Service"],
    "getThreadLink" | "listOpenChats" | "getRemovedChatOrigin"
  >;
  readonly projections: Pick<
    ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"],
    "getThreadShellById"
  >;
}

const epochMs = (iso: string) => {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? 0 : parsed;
};

/** Conversations before work chats, then newest activity, then a stable id order. */
const newestFirst = (
  a: PersonalBotRepository.PersonalOpenChat,
  b: PersonalBotRepository.PersonalOpenChat,
) =>
  Number(a.taskChat) - Number(b.taskChat) ||
  epochMs(b.activityAt) - epochMs(a.activityAt) ||
  (a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0);

/** Pure part of the rule: which of the bot's open chats takes the delivery. */
export const chooseOpenChat = (
  title: string | null,
  openChats: ReadonlyArray<PersonalBotRepository.PersonalOpenChat>,
  options?: { readonly sameTitleOnly?: boolean },
): {
  readonly threadId: ThreadId;
  readonly reason: "same-title" | "most-recent";
} | null => {
  if (typeof title === "string" && !isPlaceholderChatTitle(title)) {
    const wanted = normalizeChatName(title);
    const same = openChats
      .filter((chat) => normalizeChatName(chat.title) === wanted)
      .toSorted(newestFirst);
    if (same[0] !== undefined) return { threadId: same[0].threadId, reason: "same-title" };
  }
  if (options?.sameTitleOnly === true) return null;
  const newest = openChats.toSorted(newestFirst)[0];
  return newest === undefined ? null : { threadId: newest.threadId, reason: "most-recent" };
};

export const resolveDeliveryThread = Effect.fn("resolveDeliveryThread")(function* (
  deps: DeliveryDeps,
  threadId: ThreadId,
  options?: { readonly sameTitleOnly?: boolean; readonly archivedOnly?: boolean },
) {
  // A lookup that fails is not a lookup that found nothing: both failing means
  // the chat's state is unknown, and "unknown" must not read as "removed" (which
  // would send the message to another chat or open a new one).
  const linkResult = yield* Effect.result(deps.repository.getThreadLink({ threadId }));
  const shellResult = yield* Effect.result(deps.projections.getThreadShellById(threadId));
  if (Result.isFailure(linkResult) && Result.isFailure(shellResult)) {
    yield* Effect.logWarning(
      "personal delivery could not read a chat's link or shell; leaving it where it is",
      {
        threadId,
        linkError: String(linkResult.failure),
        shellError: String(shellResult.failure),
      },
    );
    return { kind: "unknown" } satisfies DeliveryTarget;
  }
  const link = Result.isSuccess(linkResult) ? linkResult.success : Option.none();
  const shell = Result.isSuccess(shellResult) ? shellResult.success : Option.none();
  const archived =
    Option.isSome(link) &&
    (link.value.archivedAt !== null || (Option.isSome(shell) && shell.value.archivedAt != null));
  if (Option.isSome(link) && !archived) return { kind: "open", threadId } satisfies DeliveryTarget;
  // A thread nothing links to a bot: an ordinary T3 thread, or (with
  // `archivedOnly`) a chat the caller only wants judged while it still has a link.
  if (Option.isNone(link) && options?.archivedOnly === true) {
    return { kind: "unknown" } satisfies DeliveryTarget;
  }
  // A thread that exists but has no bot link is an ordinary T3 thread.
  if (Option.isNone(link) && Option.isSome(shell))
    return { kind: "unknown" } satisfies DeliveryTarget;
  // Archived; or deleted, which removes the link row and the shell, so the bot
  // and the name come from what outlives them.
  const origin = Option.isSome(link)
    ? Option.none()
    : yield* deps.repository
        .getRemovedChatOrigin({ threadId })
        .pipe(Effect.orElseSucceed(() => Option.none()));
  const botId = Option.isSome(link)
    ? link.value.botId
    : Option.isSome(origin)
      ? origin.value.botId
      : null;
  if (botId === null) return { kind: "unknown" } satisfies DeliveryTarget;
  const title = Option.isSome(shell)
    ? shell.value.title
    : Option.isSome(origin)
      ? origin.value.title
      : null;
  const openChats = yield* deps.repository
    .listOpenChats({ botId, exceptThreadId: threadId })
    .pipe(Effect.orElseSucceed(() => []));
  const chosen = chooseOpenChat(title, openChats, options);
  if (chosen !== null) {
    return {
      kind: "redirect",
      threadId: chosen.threadId,
      from: threadId,
      reason: chosen.reason,
    } satisfies DeliveryTarget;
  }
  return { kind: "new-chat", from: threadId, botId, title } satisfies DeliveryTarget;
});
