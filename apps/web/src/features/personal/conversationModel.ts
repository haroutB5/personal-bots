import type { PendingApproval, PendingUserInput } from "@t3tools/client-runtime/pending-requests";
import { PROVIDER_DISPLAY_NAMES, type ProviderDriverKind } from "@t3tools/contracts";
import type {
  OrchestrationLatestTurn,
  OrchestrationSession,
  OrchestrationSessionProviderRetry,
  OrchestrationThreadActivity,
  PersonalBrowserStatus,
  PersonalChatNoticeMarker,
  PersonalGroupSystemEvent,
  PersonalTask,
  PersonalLoginRequest,
} from "@t3tools/contracts";
import { classifyTurnFailure } from "@t3tools/shared/turnFailure";

import { formatContextWindowTokens } from "~/lib/contextWindow";

import type { ChatMessage, ProposedPlan } from "~/types";
import type { TimelineEntry, WorkLogEntry } from "~/session-logic";

import { isServerTurnNotice, readChatNotice } from "./chatNotices";
import { readServerTurn, type ServerTurn, taskCreatedMs } from "./delegationModel";
import { readGroupMarker } from "./groupModel";
import { PERSONAL_TIME_ZONE } from "./greeting";
import type { QuestionCardItem } from "./questionCards";
import type { SecretRequestCardItem } from "./secretRequestCards";
import type { ConnectionApprovalCardItem } from "./connectionApprovalCards";
import type { LeadBotChangeCardItem } from "./leadBotChangeCards";
import type { MemoryCardItem } from "./memoryCards";

/**
 * Header state for a bot conversation, derived only from session/turn/request
 * state, plus the thread's task when it is parked on delegated work.
 */
export type ConversationState =
  | "idle"
  | "needs_help"
  | "working"
  | "waiting"
  | "delegating"
  | "rate_limited"
  | "retrying"
  | "error";

/** A working turn that has produced nothing yet (`isTurnThinking`): the avatar's thinking pose, in words. */
export const THINKING_LABEL = "Thinking";

export const CONVERSATION_STATE_LABEL: Record<ConversationState, string> = {
  idle: "Idle",
  needs_help: "Needs your help",
  working: "Working",
  waiting: "Waiting for you",
  // The screen names the bots ("Waiting on Developer") when it knows them.
  delegating: "Waiting on a task",
  rate_limited: "Rate limited",
  retrying: "Retrying",
  error: "Error",
};

/**
 * The provider wait a session is stuck on, if any. A rate limit also outlives
 * the turn that failed on it (the session keeps its reset time); a transport
 * retry only matters while the turn still runs.
 */
export function providerWaitState(
  session: OrchestrationSession | null | undefined,
): "rate_limited" | "retrying" | null {
  const retry = session?.providerRetry;
  if (retry === undefined || session === null || session === undefined) return null;
  const running = session.status === "running" || session.status === "starting";
  if (retry.kind === "rate_limited" && (running || session.status === "error")) {
    return "rate_limited";
  }
  // The server's own retry of a failed turn outlives that turn by design: it
  // is waiting on a clock, with the session sitting in `error` until it fires.
  if (retry.auto === "pending") return "retrying";
  if (retry.auto === "exhausted") return null;
  return retry.kind === "retrying" && running ? "retrying" : null;
}

export function deriveConversationState(input: {
  readonly session: OrchestrationSession | null;
  readonly latestTurn: OrchestrationLatestTurn | null;
  readonly pendingApprovals: ReadonlyArray<PendingApproval>;
  readonly pendingUserInputs: ReadonlyArray<PendingUserInput>;
  readonly browserStatus?: PersonalBrowserStatus | null;
  readonly threadId?: string;
  /** The thread's task is parked waiting for delegated work (`waiting_for_agent`). */
  readonly waitingForAgent?: boolean;
}): ConversationState {
  if (
    input.threadId !== undefined &&
    input.browserStatus?.helpRequest?.threadId === input.threadId
  ) {
    return "needs_help";
  }
  if (input.pendingApprovals.length > 0 || input.pendingUserInputs.length > 0) return "waiting";
  const wait = providerWaitState(input.session);
  if (wait !== null) return wait;
  const status = input.session?.status;
  if (input.latestTurn?.state === "running" || status === "running" || status === "starting") {
    return "working";
  }
  // The delegating turn ended cleanly; its outcome is still open.
  if (input.waitingForAgent === true) return "delegating";
  if (status === "error" || input.latestTurn?.state === "error") return "error";
  return "idle";
}

/**
 * The opening stretch of a working turn, before the bot has produced anything:
 * no reply text (reasoning traces do not count) and, when the caller has the
 * thread's activities, no tool call either. Drives the avatar's `thinking`
 * pose; only meaningful while the conversation is `working`.
 *
 * `latestTurn.assistantMessageId` is the signal: the server and the client
 * reducer both set it on the turn's first assistant message (streaming or
 * not) and never clear it within the turn. A session that is running a turn
 * the shell has not caught up with yet (or still starting one) is thinking too.
 * The chats list has shells only, so on its own this reads a turn that goes
 * straight to tools as thinking until its first line of text; the list clears
 * that with the working-progress read's `toolStep` (`currentTurnHasToolStep`).
 * The conversation header, which has the activities, switches to working on
 * the first tool call.
 */
export function isTurnThinking(input: {
  readonly session: Pick<OrchestrationSession, "status" | "activeTurnId"> | null;
  readonly latestTurn: Pick<
    OrchestrationLatestTurn,
    "turnId" | "state" | "assistantMessageId"
  > | null;
  readonly activities?: ReadonlyArray<Pick<OrchestrationThreadActivity, "tone" | "turnId">>;
}): boolean {
  const { session, latestTurn: turn } = input;
  if (turn !== null && turn.state === "running") {
    if (turn.assistantMessageId !== null) return false;
    const activities = input.activities ?? [];
    return !activities.some(
      (activity) => activity.tone === "tool" && activity.turnId === turn.turnId,
    );
  }
  if (session?.status === "starting") return true;
  if (session?.status === "running") {
    return session.activeTurnId === null || session.activeTurnId !== turn?.turnId;
  }
  return false;
}

/**
 * The context size to show beside the bot's name, or null before the chat has
 * reported one.
 *
 * Shown at every size, not only a heavy chat: the number rides along with the
 * turn's own activities, so displaying it costs nothing, and a chat's weight is
 * worth watching before it is a problem (it drives cost per turn, and the point
 * at which compaction starts summarising detail away).
 */
export function contextBadgeLabel(usedTokens: number | null | undefined): string | null {
  if (usedTokens === null || usedTokens === undefined) return null;
  if (!Number.isFinite(usedTokens) || usedTokens <= 0) return null;
  return formatContextWindowTokens(usedTokens);
}

/**
 * The chat header's state text: "Thinking" while the turn has produced
 * nothing (the avatar's thinking pose, same check), otherwise the state's own
 * words. The header's "Update broke …" still wins (`conversationHeaderStatus`).
 */
export function conversationHeaderStateLabel(input: {
  readonly state: ConversationState;
  /** `isTurnThinking` for the open chat: working, nothing out of the turn yet. */
  readonly thinking: boolean;
  /** "Waiting on Developer", when the screen knows the bots it waits on. */
  readonly waitingLabel: string | null;
  readonly session: OrchestrationSession | null;
  readonly now: Date;
}): string {
  if (input.thinking && input.state === "working") return THINKING_LABEL;
  if (input.state === "delegating")
    return input.waitingLabel ?? CONVERSATION_STATE_LABEL.delegating;
  return conversationStateLabel(input.state, input.session, input.now);
}

/**
 * Header state text. Provider waits say when the provider will try again, in
 * London time (weekday added when it is not today), or that it did not say:
 * "Rate limited · retry ~10:47", "Rate limited · reset not reported".
 */
export function conversationStateLabel(
  state: ConversationState,
  session: OrchestrationSession | null,
  now: Date,
  timeZone: string = PERSONAL_TIME_ZONE,
): string {
  if (state !== "rate_limited" && state !== "retrying") return CONVERSATION_STATE_LABEL[state];
  const retryAt = session?.providerRetry?.retryAt;
  const at = retryAt === undefined ? Number.NaN : Date.parse(retryAt);
  if (state === "rate_limited") {
    return Number.isFinite(at)
      ? `Rate limited · retry ~${formatRetryTime(new Date(at), now, timeZone)}`
      : "Rate limited · reset not reported";
  }
  return Number.isFinite(at) && at > now.getTime()
    ? `Retrying · next ~${formatRetryTime(new Date(at), now, timeZone)}`
    : "Retrying";
}

function formatRetryTime(at: Date, now: Date, timeZone: string): string {
  const time = formatter(timeZone, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
    at,
  );
  if (dayKey(at, timeZone) === dayKey(now, timeZone)) return time;
  return `${formatter(timeZone, { weekday: "short" }).format(at)} ${time}`;
}

export interface FriendlyTurnError {
  /** Plain sentence for the chat. */
  readonly message: string;
  /** The provider's own first line, stack trace removed, for a "Details" toggle. */
  readonly detail: string | null;
}

const GENERIC_TURN_FAILURE = "The last reply failed. Send your message again.";
const DETAIL_MAX = 200;

/**
 * A session error as the owner should read it: never a raw exception or stack
 * trace. Known failure kinds get a plain sentence; everything else a generic
 * one. The original first line survives as `detail`.
 *
 * `fallback` replaces the generic sentence for callers whose failure is not a
 * failed reply (answering a question, closing one), so the unrecognised case
 * still names what actually went wrong.
 */
export function friendlyTurnError(
  raw: string,
  fallback: string = GENERIC_TURN_FAILURE,
): FriendlyTurnError {
  const firstLine =
    raw
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  const withoutStack = redactSecrets(
    firstLine
      .replace(/\s+at\s+\S+\s+\(file:\/\/.*$/i, "")
      .replace(/\s+at\s+file:\/\/.*$/i, "")
      .trim(),
  );
  const detail =
    withoutStack.length === 0 || withoutStack === "The last turn failed."
      ? null
      : withoutStack.length > DETAIL_MAX
        ? `${withoutStack.slice(0, DETAIL_MAX)}…`
        : withoutStack;

  // The same reading the server retries on, so the chat can never call a
  // failure transient that the server calls a refusal, or the other way round.
  const kind = classifyTurnFailure(raw);
  let message = fallback;
  switch (kind) {
    case "usage_limit": {
      const reset = /resets?\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s?(?:am|pm)?)/i.exec(raw)?.[1];
      message =
        reset === undefined
          ? "Usage limit reached. Try again later."
          : `Usage limit reached. It resets at ${reset}.`;
      break;
    }
    case "session_closed":
      message = "This chat's session ended. Send a message to start it again.";
      break;
    case "signin":
      message = "The provider isn't signed in on your computer.";
      break;
    case "invalid_request":
      message = "The provider couldn't run that request.";
      break;
    case "upstream":
      message = "The provider's service didn't answer. Try again in a moment.";
      break;
    case "timeout":
      message = "The reply took too long and was stopped. Try again.";
      break;
    case "network":
      message = "Couldn't reach the provider. Check your computer's internet connection.";
      break;
    // A turn the owner stopped is not an error worth renaming, and an
    // unrecognised one must not be guessed at: both keep the caller's sentence.
    case "interrupted":
    case "unknown":
      break;
  }
  return { message, detail: detail === message ? null : detail };
}

/**
 * Credentials a provider error can echo back (an API key in a 401, a bearer
 * header in a proxy error). The chat shows the error's first line, so these
 * are masked before it ever reaches the screen.
 */
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [hidden]"],
  [
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization)(["']?\s*[:=]\s*["']?)[^\s"',;]{4,}/gi,
    "$1$2[hidden]",
  ],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "[hidden]"],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "[hidden]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{8,}/g, "[hidden]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[hidden]"],
];

function redactSecrets(line: string): string {
  let out = line;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** "Couldn't send: …" when nothing more specific than the provider's own line is known. */
const START_FAILURE_FALLBACK = "the bot couldn't start a reply. Try again.";

/**
 * The red line under a failed message. A turn that never started (the owner's
 * message has no turn) reads "Couldn't send: <short reason>", the reason being
 * the known failure's sentence or else the provider's own sanitised first line,
 * so it is never a bare "something failed". A turn that started and then failed
 * keeps {@link friendlyTurnError}'s wording.
 */
export function failedTurnError(input: {
  readonly raw: string;
  /** False when the owner's last message never got a turn. */
  readonly turnStarted: boolean;
}): FriendlyTurnError {
  if (input.turnStarted) return friendlyTurnError(input.raw);
  const known = friendlyTurnError(input.raw, "");
  if (known.message.length > 0) {
    return { message: `Couldn't send: ${known.message}`, detail: known.detail };
  }
  const reason = known.detail ?? START_FAILURE_FALLBACK;
  return { message: `Couldn't send: ${reason}`, detail: null };
}

/**
 * "Claude", "Codex": the plain name of a provider driver kind, or null for one
 * this build has no name for.
 */
export function providerFriendlyLabel(provider: string | null | undefined): string | null {
  if (provider === null || provider === undefined) return null;
  return PROVIDER_DISPLAY_NAMES[provider as ProviderDriverKind] ?? null;
}

/**
 * The server found the provider's conversation for this chat gone and is
 * re-running the turn on a new one by itself. Not a failure yet.
 */
export function isSessionRenewalPending(
  retry: OrchestrationSessionProviderRetry | null | undefined,
): boolean {
  return retry?.reason === "session_renewed" && retry.auto === "pending";
}

/**
 * Whether the chat's notice is a failure (red, with Retry) or an automatic
 * retry the server is still running (neutral, nothing for the owner to do).
 */
export function turnNoticeTone(
  retry: OrchestrationSessionProviderRetry | null | undefined,
): "danger" | "info" {
  return retry?.auto === "pending" ? "info" : "danger";
}

export interface TurnErrorNotice {
  /** The line under the failed message. */
  readonly message: string;
  /** The provider's sanitised line, behind "Details". */
  readonly detail: string | null;
  readonly tone: "danger" | "info";
  /** Offer Retry: a settled failure of a message the owner sent. */
  readonly canRetry: boolean;
}

/**
 * The notice under a failed or auto-retrying turn, or null when the chat has
 * nothing to say. While the server retries by itself (a renewed session or a
 * transient failure) the notice is neutral and offers no Retry; once the
 * failure is final it is red, reads "Couldn't send: …" for a message that
 * never got a turn, and offers Retry when the owner's own message is there to
 * re-send. The server clears the error on the next good turn, and so does this.
 */
export function turnErrorNotice(input: {
  readonly state: ConversationState;
  readonly session: OrchestrationSession | null;
  /**
   * Whether the owner's last message got a turn (`turnId` set); null when the
   * last user-role message is not the owner's, so there is nothing to retry.
   */
  readonly lastMessageTurnStarted: boolean | null;
}): TurnErrorNotice | null {
  const { session, state } = input;
  const retry = session?.providerRetry;
  const failedOnLimit = state === "rate_limited" && session?.status === "error";
  const notice = autoRetryNotice(retry);
  if (state !== "error" && !failedOnLimit && notice === null) return null;
  const raw = session?.lastError ?? "The last turn failed.";
  if (turnNoticeTone(retry) === "info" && notice !== null) {
    return {
      message: notice,
      detail: friendlyTurnError(raw).detail,
      tone: "info",
      canRetry: false,
    };
  }
  const info = failedTurnError({ raw, turnStarted: input.lastMessageTurnStarted ?? true });
  return {
    message: notice ?? info.message,
    detail: info.detail,
    tone: "danger",
    canRetry: state === "error" && input.lastMessageTurnStarted !== null,
  };
}

/**
 * What the chat says about a failed reply the server is retrying by itself.
 * Null when no automatic retry is in play, so the caller keeps its own text.
 *
 * Honesty is the whole point of this function: while a retry is pending it
 * says so and counts it, and once the attempts are spent it says they are
 * spent rather than leaving a hopeful "trying again" on screen forever. The
 * provider's own line is untouched either way, and stays under "Details".
 */
export function autoRetryNotice(
  retry: OrchestrationSessionProviderRetry | null | undefined,
): string | null {
  if (retry === null || retry === undefined || retry.auto === undefined) return null;
  if (isSessionRenewalPending(retry)) {
    const provider = providerFriendlyLabel(retry.provider);
    return provider === null
      ? "This chat's old session has ended. Retrying on a new session…"
      : `The old ${provider} session for this chat has ended. Retrying on a new session…`;
  }
  const max = retry.maxAttempts ?? 0;
  if (retry.auto === "pending") {
    const attempt = retry.attempt ?? 1;
    return max > 1
      ? `That reply failed. Trying again (${attempt} of ${max}).`
      : "That reply failed. Trying again.";
  }
  return max === 1
    ? "That reply failed, and trying again once didn't help. Send your message again."
    : `That reply failed, and ${max} automatic retries didn't help. Send your message again.`;
}

export type ConversationHeaderName =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly name: string };

/**
 * The header names the bot, never the thread: while the bots list is still
 * loading (a cold deep link) the header is a skeleton, and a bot that no
 * longer exists reads "Chat".
 */
export function resolveConversationHeaderName(input: {
  readonly botName: string | null;
  readonly botsLoaded: boolean;
}): ConversationHeaderName {
  if (input.botName !== null) return { status: "ready", name: input.botName };
  return input.botsLoaded ? { status: "ready", name: "Chat" } : { status: "loading" };
}

const TIME_FORMAT_CACHE = new Map<string, Intl.DateTimeFormat>();

export function formatter(
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  let cached = TIME_FORMAT_CACHE.get(key);
  if (cached === undefined) {
    cached = new Intl.DateTimeFormat("en-GB", { timeZone, ...options });
    TIME_FORMAT_CACHE.set(key, cached);
  }
  return cached;
}

// `formatToParts` costs microseconds and runs twice per entry per rebuild;
// keyed on a 15-minute UTC bucket plus zone it is a lookup for everything
// but new buckets.
const DAY_KEY_CACHE = new Map<string, string>();
const DAY_KEY_CACHE_LIMIT = 1_000;

export function dayKey(date: Date, timeZone: string): string {
  // Every real zone offset is a multiple of 15 minutes, so all instants in
  // one 15-minute UTC bucket fall on the same local day.
  const cacheKey = `${timeZone}|${Math.floor(date.getTime() / 900_000)}`;
  const cached = DAY_KEY_CACHE.get(cacheKey);
  if (cached !== undefined) return cached;
  const parts = formatter(timeZone, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  const key = `${part("year")}-${part("month")}-${part("day")}`;
  if (DAY_KEY_CACHE.size >= DAY_KEY_CACHE_LIMIT) DAY_KEY_CACHE.clear();
  DAY_KEY_CACHE.set(cacheKey, key);
  return key;
}

export function previousDayKey(key: string): string {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! - 1)).toISOString().slice(0, 10);
}

export const SHORT_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** "Today, 21:38", "Yesterday, 09:05", "12 Sep, 14:00" or "12 Sep 2025, 14:00". */
export function formatDayDivider(
  then: Date,
  now: Date,
  timeZone: string = PERSONAL_TIME_ZONE,
): string {
  const time = formatter(timeZone, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
    then,
  );
  const thenDay = dayKey(then, timeZone);
  const nowDay = dayKey(now, timeZone);
  if (thenDay === nowDay) return `Today, ${time}`;
  if (thenDay === previousDayKey(nowDay)) return `Yesterday, ${time}`;
  const [year, month, day] = thenDay.split("-").map(Number);
  const label = `${day} ${SHORT_MONTHS[month! - 1]}`;
  return thenDay.slice(0, 4) === nowDay.slice(0, 4)
    ? `${label}, ${time}`
    : `${label} ${year}, ${time}`;
}

/** A new divider starts each London day, and after an hour of silence. */
const DIVIDER_GAP_MS = 60 * 60_000;

export type ConversationItem =
  | { readonly kind: "divider"; readonly id: string; readonly at: Date }
  | { readonly kind: "message"; readonly id: string; readonly message: ChatMessage }
  /** A turn the task service wrote in the user's role; a compact system row. */
  | {
      readonly kind: "system-turn";
      readonly id: string;
      readonly message: ChatMessage;
      readonly turn: ServerTurn;
    }
  | { readonly kind: "plan"; readonly id: string; readonly plan: ProposedPlan }
  /**
   * A line the server wrote in the chat on its own behalf: paused on a usage
   * limit, or the automatic continue after it (a user-role turn message, never
   * the owner's words).
   */
  | {
      readonly kind: "notice";
      readonly id: string;
      readonly message: ChatMessage;
      readonly notice: PersonalChatNoticeMarker;
    }
  | {
      readonly kind: "work";
      readonly id: string;
      readonly entries: ReadonlyArray<WorkLogEntry>;
    }
  /**
   * A member speaking in a group transcript. The speaker rides on the message's
   * own marker, so it is right offline and survives paging; `showSpeaker` is
   * false on a run of consecutive messages from the same member, which is what
   * makes a bot that answers in three paragraphs read as one voice.
   */
  | {
      readonly kind: "group-message";
      readonly id: string;
      readonly message: ChatMessage;
      readonly speaker: { readonly botId: string; readonly name: string };
      readonly showSpeaker: boolean;
    }
  /** A row the group service wrote on its own behalf (a member joined, ...). */
  | {
      readonly kind: "group-system";
      readonly id: string;
      readonly message: ChatMessage;
      readonly event: PersonalGroupSystemEvent;
    }
  /** A task delegated from this thread, shown as a live card. */
  | { readonly kind: "delegation"; readonly id: string; readonly task: PersonalTask }
  /** A question the bot asked, at the point in the chat where it asked it. */
  | { readonly kind: "question"; readonly id: string; readonly card: QuestionCardItem }
  /** A secret the bot asked for, at the point in the chat where it asked. */
  | { readonly kind: "secret"; readonly id: string; readonly card: SecretRequestCardItem }
  | { readonly kind: "login"; readonly id: string; readonly request: PersonalLoginRequest }
  | {
      readonly kind: "connection-approval";
      readonly id: string;
      readonly card: ConnectionApprovalCardItem;
    }
  /** A team lead asking to remove or rewrite a bot, in the lead's chat. */
  | { readonly kind: "lead-bot-change"; readonly id: string; readonly card: LeadBotChangeCardItem }
  /** A bot's save or forget of memory other bots see, waiting for the owner's OK. */
  | { readonly kind: "memory-change"; readonly id: string; readonly card: MemoryCardItem };

/**
 * Flattens the upstream timeline into chat rows: consecutive work entries
 * fold into one collapsible group, and day dividers are inserted from the
 * entries' real timestamps. System messages are not shown; turns the task
 * service authored become system rows instead of the user's bubble.
 */
export function buildConversationItems(
  entries: ReadonlyArray<TimelineEntry>,
  options: {
    readonly timeZone?: string;
    /** Settings > Chat > "Show tool steps". Off by default: no work rows at all. */
    readonly showToolSteps?: boolean;
    /**
     * Read the group speaker marker off each message. Off everywhere but a
     * group transcript, so a bot chat's rows are byte-for-byte what they were —
     * including a member's own thread, where the relayed brief stays the plain
     * message it is rather than pretending to be the group.
     */
    readonly groups?: boolean;
  } = {},
): ConversationItem[] {
  const timeZone = options.timeZone ?? PERSONAL_TIME_ZONE;
  const showToolSteps = options.showToolSteps ?? false;
  const groups = options.groups ?? false;
  /** The member whose run of messages is still open, for header collapsing. */
  let lastSpeakerBotId: string | null = null;
  const items: ConversationItem[] = [];
  /** The last row actually rendered: day dividers are about visible gaps. */
  let lastAt: Date | null = null;
  /**
   * The last entry of any kind, hidden work included. A bot that worked for an
   * hour was not silent, so its reply must not inherit a "gap" divider just
   * because the steps behind it are hidden.
   */
  let lastActivityAt: Date | null = null;
  let openWork: { id: string; entries: WorkLogEntry[] } | null = null;

  const noteActivity = (createdAt: string) => {
    const at = new Date(createdAt);
    if (!Number.isNaN(at.getTime())) lastActivityAt = at;
  };

  const pushDividerIfNeeded = (createdAt: string) => {
    const at = new Date(createdAt);
    if (Number.isNaN(at.getTime())) return;
    const since = lastActivityAt ?? lastAt;
    if (
      lastAt === null ||
      dayKey(at, timeZone) !== dayKey(lastAt, timeZone) ||
      (since !== null && at.getTime() - since.getTime() >= DIVIDER_GAP_MS)
    ) {
      openWork = null;
      // A day or an hour of silence ends a run: the next message re-introduces
      // its speaker rather than inheriting a header from before the gap.
      lastSpeakerBotId = null;
      items.push({ kind: "divider", id: `divider:${createdAt}`, at });
    }
    lastAt = at;
    lastActivityAt = at;
  };

  for (const entry of entries) {
    // `reasoning` carries the provider's thinking trace. It is plumbing in the
    // same sense as a tool step: a bot chat shows what the bot said, not how it
    // got there, and rendering it would otherwise read as the bot speaking.
    if (
      entry.kind === "message" &&
      (entry.message.role === "system" || entry.message.role === "reasoning")
    )
      continue;
    // Checkpoints are developer plumbing (undo snapshots of a git workspace);
    // a bot chat never shows their steps, failed or not. With "Show tool steps"
    // off (the default) every work entry is dropped the same way, so no work
    // group is ever created and the transcript is just what was said.
    if (
      entry.kind === "work" &&
      (!showToolSteps || entry.entry.sourceActivityKind?.startsWith("checkpoint.") === true)
    ) {
      noteActivity(entry.createdAt);
      continue;
    }
    pushDividerIfNeeded(entry.createdAt);
    if (entry.kind === "work") {
      if (openWork === null) {
        openWork = { id: `work:${entry.id}`, entries: [] };
        items.push({ kind: "work", id: openWork.id, entries: openWork.entries });
      }
      openWork.entries.push(entry.entry);
      continue;
    }
    openWork = null;
    if (entry.kind === "message") {
      const marker = groups ? readGroupMarker(entry.message) : null;
      if (marker !== null && marker.speaker.kind === "bot") {
        const speaker = { botId: marker.speaker.botId as string, name: marker.speaker.name };
        items.push({
          kind: "group-message",
          id: entry.id,
          message: entry.message,
          speaker,
          showSpeaker: lastSpeakerBotId !== speaker.botId,
        });
        lastSpeakerBotId = speaker.botId;
        continue;
      }
      lastSpeakerBotId = null;
      if (marker !== null && marker.speaker.kind === "system") {
        items.push({
          kind: "group-system",
          id: entry.id,
          message: entry.message,
          event: marker.speaker.event,
        });
        continue;
      }
      const notice = readChatNotice(entry.message);
      if (notice !== null) {
        items.push({ kind: "notice", id: entry.id, message: entry.message, notice });
        continue;
      }
      const turn = readServerTurn(entry.message);
      items.push(
        turn === null
          ? { kind: "message", id: entry.id, message: entry.message }
          : { kind: "system-turn", id: entry.id, message: entry.message, turn },
      );
    } else {
      lastSpeakerBotId = null;
      items.push({ kind: "plan", id: entry.id, plan: entry.proposedPlan });
    }
  }
  return items;
}

/**
 * When the bot last said something, in epoch ms, or null if it has not spoken.
 *
 * Drives the composer's "Queued" notice. A message sent mid-turn reaches the
 * running turn as a steer, so the bot often answers it long before the turn
 * ends: keeping the notice up until then claims the bot has not seen a message
 * it has already replied to. Anything the bot emits after the message was sent
 * is proof that it has.
 */
export function botLastSpokeAtMs(items: ReadonlyArray<ConversationItem>): number | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item === undefined) continue;
    const spoke =
      (item.kind === "message" && item.message.role !== "user") ||
      item.kind === "group-message" ||
      item.kind === "work" ||
      item.kind === "plan";
    if (spoke) return itemTimeMs(item);
  }
  return null;
}

/** A new turn starts here: the user spoke, the task service did, or a new day began. */
export function isTurnBoundary(item: ConversationItem): boolean {
  return (
    item.kind === "divider" ||
    item.kind === "system-turn" ||
    (item.kind === "notice" && isServerTurnNotice(item.notice)) ||
    item.kind === "group-system" ||
    (item.kind === "message" && item.message.role === "user")
  );
}

function itemTimeMs(item: ConversationItem): number {
  switch (item.kind) {
    case "divider":
      return item.at.getTime();
    case "message":
    case "system-turn":
    case "notice":
    case "group-message":
    case "group-system":
      return Date.parse(item.message.createdAt);
    case "plan":
      return Date.parse(item.plan.createdAt);
    case "work":
      return Date.parse(item.entries.at(-1)?.createdAt ?? "");
    case "delegation":
      return taskCreatedMs(item.task);
    case "question":
      return Date.parse(item.card.createdAt);
    case "login":
      return Date.parse(item.request.createdAt);
    case "secret":
    case "connection-approval":
    case "lead-bot-change":
    case "memory-change":
      return item.card.createdAtMs;
  }
}

/**
 * Puts each delegated child's card at the end of the turn that created it:
 * after the last row written before the child existed, then past the rest of
 * that turn (its reply), stopping at the next turn. A child older than every
 * loaded row (earlier turns not paged in) goes first.
 */
export function placeDelegationCards(
  items: ReadonlyArray<ConversationItem>,
  children: ReadonlyArray<PersonalTask>,
): ConversationItem[] {
  if (children.length === 0) return [...items];
  const placed = [...items];
  // Times are parsed once per item, not once per item per child.
  const times = items.map(itemTimeMs);
  for (const task of children.toSorted(
    (left, right) => taskCreatedMs(left) - taskCreatedMs(right),
  )) {
    const createdMs = taskCreatedMs(task);
    let anchor = -1;
    for (let index = 0; index < placed.length; index += 1) {
      const at = times[index]!;
      if (Number.isFinite(at) && at <= createdMs) anchor = index;
    }
    let end = anchor;
    if (anchor >= 0) {
      while (end + 1 < placed.length && !isTurnBoundary(placed[end + 1]!)) end += 1;
    }
    placed.splice(end + 1, 0, { kind: "delegation", id: `delegation:${task.taskId}`, task });
    times.splice(end + 1, 0, createdMs);
  }
  return placed;
}

interface TimedCard {
  readonly item: ConversationItem;
  readonly atMs: number;
  /** Still waiting on the owner, so it must stay the last thing in the chat. */
  readonly pending: boolean;
}

/**
 * Drops each settled card back into the transcript at the moment it happened,
 * and keeps every still-open one at the end.
 *
 * A question the owner has already answered is history: it belongs where the
 * bot asked it, so whatever the bot said next reads below it instead of above
 * it. A question still waiting for an answer is not history, and a bot that
 * asks and keeps working would bury it mid-transcript, so open cards stay last
 * (in ask order) where the scroller already parks the reader.
 *
 * Ordering is total and stable: cards sort by time then by id, and a card is
 * inserted after every row at or before its own time, so equal timestamps never
 * depend on map or query order. Day dividers are untouched — they were decided
 * in `buildConversationItems` from the entries' own gaps, and inserting a card
 * afterwards cannot invent or move one.
 */
function placeTimedCards(
  items: ReadonlyArray<ConversationItem>,
  cards: ReadonlyArray<TimedCard>,
): ConversationItem[] {
  if (cards.length === 0) return [...items];
  const placed = [...items];
  const times = items.map(itemTimeMs);
  const open: ConversationItem[] = [];
  const sorted = [...cards].sort(
    (left, right) => left.atMs - right.atMs || left.item.id.localeCompare(right.item.id),
  );
  for (const card of sorted) {
    if (card.pending || !Number.isFinite(card.atMs)) {
      open.push(card.item);
      continue;
    }
    let anchor = -1;
    for (let index = 0; index < placed.length; index += 1) {
      const at = times[index]!;
      if (Number.isFinite(at) && at <= card.atMs) anchor = index;
    }
    placed.splice(anchor + 1, 0, card.item);
    times.splice(anchor + 1, 0, card.atMs);
  }
  return [...placed, ...open];
}

/** Question cards, in the flow of the chat. See {@link placeTimedCards}. */
export function placeQuestionCards(
  items: ReadonlyArray<ConversationItem>,
  cards: ReadonlyArray<QuestionCardItem>,
): ConversationItem[] {
  return placeTimedCards(
    items,
    cards.map((card) => ({
      item: { kind: "question", id: `question:${card.requestId}`, card } as const,
      atMs: Date.parse(card.createdAt),
      pending: card.kind === "pending",
    })),
  );
}

/** Secret-request cards, in the flow of the chat. See {@link placeTimedCards}. */
export function placeSecretRequestCards(
  items: ReadonlyArray<ConversationItem>,
  cards: ReadonlyArray<SecretRequestCardItem>,
): ConversationItem[] {
  return placeTimedCards(
    items,
    cards.map((card) => ({
      item: { kind: "secret", id: `secret:${card.requestId}`, card } as const,
      atMs: card.createdAtMs,
      pending: card.kind === "pending",
    })),
  );
}

export function placeLoginRequestCards(
  items: ReadonlyArray<ConversationItem>,
  requests: ReadonlyArray<PersonalLoginRequest>,
): ConversationItem[] {
  return placeTimedCards(
    items,
    requests.map((request) => ({
      item: { kind: "login", id: `login:${request.requestId}`, request } as const,
      atMs: Date.parse(request.createdAt),
      pending: request.status === "pending" || request.status === "filling",
    })),
  );
}

/**
 * A gated vendor call sits where the bot made it, like every other card, so
 * the approval reads next to the work that asked for it rather than stacked at
 * the bottom of the chat away from its own context.
 */
export function placeConnectionApprovalCards(
  items: ReadonlyArray<ConversationItem>,
  cards: ReadonlyArray<ConnectionApprovalCardItem>,
): ConversationItem[] {
  return placeTimedCards(
    items,
    cards.map((card) => ({
      item: {
        kind: "connection-approval",
        id: `connection-approval:${card.approvalId}`,
        card,
      } as const,
      atMs: card.createdAtMs,
      pending: card.kind === "pending",
    })),
  );
}

/** Lead-bot change cards, placed like the connection approvals: at the moment they were asked. */
export function placeLeadBotChangeCards(
  items: ReadonlyArray<ConversationItem>,
  cards: ReadonlyArray<LeadBotChangeCardItem>,
): ConversationItem[] {
  return placeTimedCards(
    items,
    cards.map((card) => ({
      item: { kind: "lead-bot-change", id: `lead-bot-change:${card.changeId}`, card } as const,
      atMs: card.createdAtMs,
      pending: card.kind === "pending",
    })),
  );
}

/** Memory cards, placed like the lead-bot change cards: at the moment the bot asked. */
export function placeMemoryCards(
  items: ReadonlyArray<ConversationItem>,
  cards: ReadonlyArray<MemoryCardItem>,
): ConversationItem[] {
  return placeTimedCards(
    items,
    cards.map((card) => ({
      item: { kind: "memory-change", id: `memory-change:${card.changeId}`, card } as const,
      atMs: card.createdAtMs,
      pending: card.pending,
    })),
  );
}
