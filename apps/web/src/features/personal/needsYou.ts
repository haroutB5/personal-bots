import type {
  PersonalGroupRound,
  PersonalLoginRequest,
  PersonalSecretRequest,
} from "@t3tools/contracts";

/**
 * The "Needs you" model: every request that is open right now, derived in one
 * place so the filter chip, the tab badge and the list can never disagree.
 *
 * One derivation, one count. The sources are the data the app already has:
 *
 * - a chat's shell flags (`hasPendingUserInput`, `hasPendingApprovals`), the
 *   same flags the old review row read;
 * - the pending secret requests (`personalSecrets.listPending`, polled);
 * - the login requests in `pending` or `filling` (per chat today: see the note
 *   on {@link NeedsYouInput.loginRequests});
 * - a browser-help request (`personalDesktop.status` through the computer feed);
 * - a group round paused for a vote (`paused_vote`).
 *
 * A request leaves the model the moment its source stops reporting it, so an
 * answered request disappears from the chip, the badge and the list together.
 * Nothing here reads the clock or the DOM: the screens pass the rows they are
 * showing and this maps requests onto them.
 */

/** The kinds a pill can be, in the order the design lists them. */
export type NeedsYouKind = "answer" | "approve" | "login" | "secret" | "help" | "vote";

export const NEEDS_YOU_PILL_LABEL: Readonly<Record<NeedsYouKind, string>> = {
  answer: "Answer",
  approve: "Approve",
  login: "Sign in",
  secret: "Secret",
  help: "Help",
  vote: "Decide",
};

/** The words for the request itself ("Needs your answer"), used in row names. */
export const NEEDS_YOU_WORDS: Readonly<Record<NeedsYouKind, string>> = {
  answer: "Needs your answer",
  approve: "Needs approval",
  login: "Needs a sign-in",
  secret: "Needs a secret",
  help: "Needs your help",
  vote: "Needs your decision",
};

/**
 * Which request a pill shows when one chat has several open. The same order
 * `botStatus` read its row through: help blocks everything, a secret parks the
 * bot's task outright, then a sign-in, then approvals and questions.
 */
const KIND_PRIORITY: Readonly<Record<NeedsYouKind, number>> = {
  help: 0,
  secret: 1,
  login: 2,
  approve: 3,
  answer: 4,
  vote: 5,
};

export interface NeedsYouRequest {
  readonly kind: NeedsYouKind;
  /** The list row it hangs on: a chat's threadId, or a group's groupId. */
  readonly key: string;
  /** The chat (a group row's own shared thread id for a vote). */
  readonly threadId: string;
  readonly botId: string | null;
  /**
   * The specific request, where the source has one (a secret request id), so
   * two of the same kind on one chat count as two.
   */
  readonly requestId: string | null;
}

export interface NeedsYouModel {
  /** Per row key (a chat's threadId, a group's groupId): its open requests, highest priority first. */
  readonly byRow: ReadonlyMap<string, ReadonlyArray<NeedsYouRequest>>;
  /** Every open request, one entry per request. The count is its length. */
  readonly all: ReadonlyArray<NeedsYouRequest>;
  readonly count: number;
}

export const EMPTY_NEEDS_YOU: NeedsYouModel = {
  byRow: new Map(),
  all: [],
  count: 0,
};

/** A chat row the home is showing (awake, open, not a group relay). */
export interface NeedsYouThread {
  readonly threadId: string;
  readonly botId: string;
  /** The live state of that chat; null before its shell has landed. */
  readonly shell: {
    readonly hasPendingUserInput?: boolean | undefined;
    readonly hasPendingApprovals?: boolean | undefined;
  } | null;
}

export interface NeedsYouInput {
  /** The chat rows on screen. A chat whose shell has not landed carries none of its flags. */
  readonly threads: ReadonlyArray<NeedsYouThread>;
  readonly secretRequests: ReadonlyArray<PersonalSecretRequest>;
  /**
   * The login requests whose status is `pending` or `filling`.
   *
   * The screen supplies these from the queries it can reach. The login-request
   * RPC is per chat (`personalLoginRequests.list { threadId }`), so today the
   * list can only be filled for the chat that is open: see the "Sign in" note
   * in the 1.67.0 result. The kind itself is wired end to end, so nothing but
   * the data is missing.
   */
  readonly loginRequests: ReadonlyArray<PersonalLoginRequest>;
  /** A chat waiting on the owner in the browser (`helpRequest.threadId`). */
  readonly browserHelpThreadId: string | null;
  /** Chats with a pending connection approval (`personalConnectionApprovals.list`). */
  readonly approvalThreadIds: ReadonlySet<string>;
  /** The group rows on screen (awake, open groups). */
  readonly groupIds: ReadonlySet<string>;
  readonly rounds: ReadonlyArray<PersonalGroupRound>;
}

/** The login requests that count as open. */
export function openLoginRequests(
  requests: ReadonlyArray<PersonalLoginRequest>,
): ReadonlyArray<PersonalLoginRequest> {
  return requests.filter((request) => request.status === "pending" || request.status === "filling");
}

function sortRequests(requests: NeedsYouRequest[]): NeedsYouRequest[] {
  return requests.toSorted((left, right) => {
    const byKind = KIND_PRIORITY[left.kind] - KIND_PRIORITY[right.kind];
    if (byKind !== 0) return byKind;
    return (left.requestId ?? "").localeCompare(right.requestId ?? "");
  });
}

/**
 * The open requests, per row and in total. Pure: the same input always gives
 * the same model, and two screens deriving from the same store change agree
 * to the entry.
 */
export function deriveNeedsYou(input: NeedsYouInput): NeedsYouModel {
  const byRow = new Map<string, NeedsYouRequest[]>();
  const push = (request: NeedsYouRequest) => {
    const existing = byRow.get(request.key);
    if (existing === undefined) byRow.set(request.key, [request]);
    else existing.push(request);
  };

  for (const thread of input.threads) {
    if (thread.shell === null) continue;
    if (thread.shell.hasPendingUserInput === true) {
      push({
        kind: "answer",
        key: thread.threadId,
        threadId: thread.threadId,
        botId: thread.botId,
        requestId: null,
      });
    }
    if (thread.shell.hasPendingApprovals === true) {
      push({
        kind: "approve",
        key: thread.threadId,
        threadId: thread.threadId,
        botId: thread.botId,
        requestId: null,
      });
    }
  }

  // A pending approval can arrive without the chat's shell flag (the vendor
  // call is decided by the connection service): the thread ids the list
  // reports are their own authority, so one kind never hides the other.
  const listed = new Map(input.threads.map((thread) => [thread.threadId, thread] as const));
  for (const threadId of input.approvalThreadIds) {
    const thread = listed.get(threadId);
    if (thread === undefined) continue;
    const already = byRow
      .get(threadId)
      ?.some((request) => request.kind === "approve" && request.requestId === null);
    if (already === true) continue;
    push({
      kind: "approve",
      key: threadId,
      threadId,
      botId: thread.botId,
      requestId: null,
    });
  }

  for (const request of input.secretRequests) {
    if (request.status !== "pending") continue;
    const threadId = String(request.threadId);
    if (!listed.has(threadId)) continue;
    push({
      kind: "secret",
      key: threadId,
      threadId,
      botId: String(request.botId),
      requestId: String(request.requestId),
    });
  }

  for (const request of openLoginRequests(input.loginRequests)) {
    const threadId = String(request.threadId);
    if (!listed.has(threadId)) continue;
    push({
      kind: "login",
      key: threadId,
      threadId,
      botId: String(request.botId),
      requestId: String(request.requestId),
    });
  }

  if (input.browserHelpThreadId !== null) {
    const thread = listed.get(input.browserHelpThreadId);
    if (thread !== undefined) {
      push({
        kind: "help",
        key: thread.threadId,
        threadId: thread.threadId,
        botId: thread.botId,
        requestId: null,
      });
    }
  }

  for (const round of input.rounds) {
    if (round.status !== "paused_vote") continue;
    const groupId = String(round.groupId);
    if (!input.groupIds.has(groupId)) continue;
    push({
      kind: "vote",
      key: groupId,
      threadId: String(round.activeThreadId ?? round.groupId),
      botId: null,
      requestId: String(round.roundId),
    });
  }

  const all: NeedsYouRequest[] = [];
  for (const [key, requests] of byRow) {
    const sorted = sortRequests(requests);
    byRow.set(key, sorted);
    all.push(...sorted);
  }
  return { byRow, all, count: all.length };
}

/** The pill a row shows: its highest-priority open request, or null. */
export function rowRequest(model: NeedsYouModel, key: string): NeedsYouRequest | null {
  return model.byRow.get(key)?.[0] ?? null;
}

/** Whether any of `threadIds` has an open request (a bot's rail caption). */
export function botNeedsYou(model: NeedsYouModel, threadIds: ReadonlyArray<string>): boolean {
  return threadIds.some((threadId) => model.byRow.has(threadId));
}
