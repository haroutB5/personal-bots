import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  botTeam,
  isBotPinned,
  isProviderAvailable,
  isTeamLead,
  PERSONAL_BOT_TEAM_ORDER,
  type PersonalBot,
  type PersonalRoutine,
  type PersonalBotThread,
  type PersonalBotThreadNewestMessage,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  type ConversationState,
  conversationStateLabel,
  isTurnThinking,
  providerWaitState,
} from "./conversationModel";
import { routineNextRunLabel } from "./taskPresentation";

export interface BotProviderStatus {
  readonly label: string;
  /** False when the bot's instance is missing, disabled or unavailable. */
  readonly available: boolean;
  /** The test message after an update failed on the version installed now. */
  readonly broken: boolean;
}

export interface BotSummary {
  readonly bot: PersonalBot;
  readonly provider: BotProviderStatus;
  /** Most recently updated, non-archived thread linked to the bot. */
  readonly newestThread: EnvironmentThreadShell | null;
  /** That thread's newest user/assistant message, from `personalBots.list`. */
  readonly newestMessage: PersonalBotThreadNewestMessage | null;
  readonly threadTitles: ReadonlyArray<string>;
  /** A linked thread has a turn or session running right now (not stuck on a rate limit). */
  readonly live: boolean;
  /**
   * Live, and every live thread is still in its opening stretch with no reply
   * yet (`isTurnThinking`). One thread producing output makes the bot working.
   */
  readonly thinking: boolean;
  /** A linked thread is stuck on a provider rate limit. */
  readonly rateLimited: boolean;
  readonly rateLimitedThread: EnvironmentThreadShell | null;
  /** Linked threads waiting on the user (approval or requested input). */
  readonly attentionThreads: ReadonlyArray<EnvironmentThreadShell>;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly needsBrowserHelp: boolean;
  /** A linked chat has a secret request the bot is parked on. */
  readonly needsSecret: boolean;
  /** "Waiting for Developer": a linked thread's task is parked on delegated work. */
  readonly waitingFor: string | null;
  /** A linked chat holds the user's real PC right now. */
  readonly usingPc?: boolean;
  /** A linked chat is in line for the PC while another bot has it. */
  readonly waitingForPc?: boolean;
  readonly nextRoutine: PersonalRoutine | null;
  readonly lastActivityMs: number | null;
}

function humanizeInstanceId(instanceId: string): string {
  return instanceId
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function resolveBotProvider(
  instanceId: string,
  providers: ReadonlyArray<ServerProvider>,
): BotProviderStatus {
  const snapshot = providers.find((candidate) => candidate.instanceId === instanceId);
  if (snapshot === undefined) {
    return { label: humanizeInstanceId(instanceId), available: false, broken: false };
  }
  const label = resolveProviderInstanceDisplayName(snapshot);
  return {
    // The bots UI names Anthropic's runtime by its product name.
    label: label === "Claude" ? "Claude Code" : label,
    available: snapshot.enabled && isProviderAvailable(snapshot),
    broken: isProviderBroken(snapshot),
  };
}

/** The bots' test message failed on the installed version; a verdict for another version says nothing. */
export function isProviderBroken(
  snapshot: Pick<ServerProvider, "version" | "smokeCheck">,
): boolean {
  return (
    snapshot.smokeCheck?.status === "failed" && snapshot.smokeCheck.version === snapshot.version
  );
}

/**
 * The chat header's status split into the part that may be squeezed out
 * (`prefix`, the provider name) and the part that never may (`status`, what
 * the bot is doing right now). The header renders them as separate spans so a
 * long bot title can never shorten "Idle" / "Working" / "Waiting for you".
 */
export interface ConversationHeaderParts {
  readonly prefix: string | null;
  readonly status: string;
}

export function conversationHeaderParts(
  state: ConversationState,
  stateLabel: string,
  provider: BotProviderStatus | null,
): ConversationHeaderParts {
  if (provider === null) return { prefix: null, status: stateLabel };
  // A failed post-update test replaces the state label unless the bot is
  // waiting on the user, and then it is the whole status.
  if (provider.broken && state !== "needs_help" && state !== "waiting") {
    return { prefix: null, status: `Update broke ${provider.label}` };
  }
  return { prefix: provider.label, status: stateLabel };
}

/** The same header status as one string, for labels and tests. */
export function conversationHeaderStatus(
  state: ConversationState,
  stateLabel: string,
  provider: BotProviderStatus | null,
): string {
  const parts = conversationHeaderParts(state, stateLabel, provider);
  return parts.prefix === null ? parts.status : `${parts.prefix} · ${parts.status}`;
}

/** "Claude Code", or "Claude Code · unavailable" when the bot cannot run. */
export function providerLine(status: BotProviderStatus): string {
  return status.available ? status.label : `${status.label} · unavailable`;
}

export function isThreadRateLimited(shell: EnvironmentThreadShell): boolean {
  return providerWaitState(shell.session) === "rate_limited";
}

/** Running right now. A turn parked on a rate limit is not live, however long it "runs". */
export function isThreadLive(shell: EnvironmentThreadShell): boolean {
  if (isThreadRateLimited(shell)) return false;
  return (
    shell.latestTurn?.state === "running" ||
    shell.session?.status === "running" ||
    shell.session?.status === "starting"
  );
}

/** Every live linked thread is still thinking (see {@link BotSummary.thinking}). */
export function isBotThinking(shells: ReadonlyArray<EnvironmentThreadShell>): boolean {
  const live = shells.filter(isThreadLive);
  return live.length > 0 && live.every((shell) => isTurnThinking(shell));
}

export function threadNeedsAttention(shell: EnvironmentThreadShell): boolean {
  return shell.hasPendingApprovals || shell.hasPendingUserInput;
}

export type BotStatusTone = "review" | "normal";

export function botStatus(
  summary: BotSummary,
  now: number,
): {
  readonly label: string;
  readonly tone: BotStatusTone;
} {
  if (summary.needsBrowserHelp) return { label: "Needs your help", tone: "review" };
  // Above approvals and questions: a secret request parks the bot's task in
  // waiting_for_user until it is answered or declined, and nothing else frees it.
  if (summary.needsSecret) return { label: "Needs a secret", tone: "review" };
  if (summary.hasPendingApprovals) return { label: "Needs approval", tone: "review" };
  if (summary.hasPendingUserInput) return { label: "Needs your reply", tone: "review" };
  // Below the needs-you states, above everything else: the bot's next turn will fail.
  if (summary.provider.broken) {
    return { label: `Update broke ${summary.provider.label}`, tone: "review" };
  }
  // Above Working: a bot in line for the PC is live but not getting anywhere.
  if (summary.waitingForPc === true) return { label: "Waiting for the computer", tone: "normal" };
  if (summary.usingPc === true) return { label: "Using your PC", tone: "normal" };
  if (summary.live) return { label: "Working", tone: "normal" };
  if (summary.rateLimitedThread !== null) {
    return {
      label: conversationStateLabel(
        "rate_limited",
        summary.rateLimitedThread.session,
        new Date(now),
      ),
      tone: "review",
    };
  }
  if (summary.waitingFor !== null) return { label: summary.waitingFor, tone: "normal" };
  if (summary.nextRoutine !== null) {
    return {
      label: routineNextRunLabel(summary.nextRoutine).replace(/^Next: /, "Next run "),
      tone: "normal",
    };
  }
  if (!summary.provider.available) {
    return { label: "Unavailable · tap to fix", tone: "review" };
  }
  return { label: "Ready", tone: "normal" };
}

export function botStatusLine(summary: BotSummary, now: number): string {
  return botStatus(summary, now).label;
}

function updatedMs(shell: EnvironmentThreadShell): number {
  const parsed = Date.parse(shell.updatedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Join bots with their linked thread shells. Only real state feeds the row:
 * activity, attention and timestamps all come from the thread shells. Rows are
 * ordered by latest activity (chat-list convention), then the bots' own order.
 */
export function buildBotSummaries(input: {
  readonly bots: ReadonlyArray<PersonalBot>;
  readonly links: ReadonlyArray<PersonalBotThread>;
  readonly shells: ReadonlyArray<EnvironmentThreadShell>;
  readonly providers: ReadonlyArray<ServerProvider>;
  /** From `waitingLabelsByThread`: thread id to "Waiting for Developer". */
  readonly waitingByThread?: ReadonlyMap<string, string>;
  readonly browserHelpThreadId?: string | null;
  /** From `threadIdsAwaitingSecret`: chats with a pending secret request. */
  readonly secretRequestThreadIds?: ReadonlySet<string>;
  readonly routines?: ReadonlyArray<PersonalRoutine>;
  /** From `personalDesktop.status`: who holds the PC and who waits for it. */
  readonly desktop?: {
    readonly holderThreadId: string | null;
    readonly waitingThreadIds: ReadonlySet<string>;
  } | null;
}): BotSummary[] {
  const shellsById = new Map(input.shells.map((shell) => [shell.id as string, shell] as const));
  const shellsByBot = new Map<string, EnvironmentThreadShell[]>();
  const newestMessageByThread = new Map<string, PersonalBotThreadNewestMessage>();
  for (const link of input.links) {
    if (link.newestMessage != null) newestMessageByThread.set(link.threadId, link.newestMessage);
    if (link.archivedAt !== null) continue;
    const shell = shellsById.get(link.threadId);
    if (shell === undefined || shell.archivedAt !== null) continue;
    const list = shellsByBot.get(link.botId);
    if (list === undefined) {
      shellsByBot.set(link.botId, [shell]);
    } else {
      list.push(shell);
    }
  }

  const summaries = input.bots.map((bot): BotSummary => {
    const shells = (shellsByBot.get(bot.botId) ?? []).toSorted(
      (left, right) => updatedMs(right) - updatedMs(left),
    );
    const newestThread = shells[0] ?? null;
    const rateLimitedThread = shells.find(isThreadRateLimited) ?? null;
    const nextRoutine =
      (input.routines ?? [])
        .filter(
          (routine) =>
            routine.botId === bot.botId &&
            routine.trigger === "schedule" &&
            routine.enabled &&
            routine.nextDueAt !== null,
        )
        .toSorted(
          (left, right) =>
            DateTime.toEpochMillis(left.nextDueAt!) - DateTime.toEpochMillis(right.nextDueAt!),
        )[0] ?? null;
    return {
      bot,
      provider: resolveBotProvider(bot.modelSelection.instanceId, input.providers),
      newestThread,
      newestMessage:
        newestThread === null ? null : (newestMessageByThread.get(newestThread.id) ?? null),
      threadTitles: shells.map((shell) => shell.title),
      live: shells.some(isThreadLive),
      thinking: isBotThinking(shells),
      rateLimited: rateLimitedThread !== null,
      rateLimitedThread,
      attentionThreads: shells.filter(threadNeedsAttention),
      hasPendingApprovals: shells.some((shell) => shell.hasPendingApprovals),
      hasPendingUserInput: shells.some((shell) => shell.hasPendingUserInput),
      needsBrowserHelp: input.links.some(
        (link) =>
          link.botId === bot.botId &&
          link.archivedAt === null &&
          link.threadId === input.browserHelpThreadId,
      ),
      // Off the links, not the shells: a secret request keeps its chat's
      // hasPendingUserInput false, so only the request row knows about it.
      needsSecret: input.links.some(
        (link) =>
          link.botId === bot.botId &&
          link.archivedAt === null &&
          (input.secretRequestThreadIds?.has(link.threadId) ?? false),
      ),
      waitingFor:
        shells
          .map((shell) => input.waitingByThread?.get(shell.id) ?? null)
          .find((label) => label !== null) ?? null,
      usingPc: input.links.some(
        (link) =>
          link.botId === bot.botId &&
          link.archivedAt === null &&
          link.threadId === input.desktop?.holderThreadId,
      ),
      waitingForPc: input.links.some(
        (link) =>
          link.botId === bot.botId &&
          link.archivedAt === null &&
          (input.desktop?.waitingThreadIds.has(link.threadId) ?? false),
      ),
      nextRoutine,
      lastActivityMs: newestThread === null ? null : updatedMs(newestThread),
    };
  });

  return summaries.toSorted((left, right) => {
    if (left.lastActivityMs !== right.lastActivityMs) {
      if (left.lastActivityMs === null) return 1;
      if (right.lastActivityMs === null) return -1;
      return right.lastActivityMs - left.lastActivityMs;
    }
    if (left.bot.sortOrder !== right.bot.sortOrder) {
      return left.bot.sortOrder - right.bot.sortOrder;
    }
    return left.bot.name.localeCompare(right.bot.name);
  });
}

/** Client-side search over bot names and their thread titles. */
/**
 * What the Chats previews depend on, per bot: which thread is newest, and the
 * message boundaries of that thread. Deliberately NOT the shell's
 * `updatedAt`: the server bumps it on every streamed `message-sent` delta, so
 * keying the `personalBots.list` refetch on it refetched the whole list once
 * per chunk while any bot replied. This key moves when the owner sends a
 * message (`latestUserMessageAt`), a turn starts (`turnId`), the bot starts a
 * new message (`assistantMessageId`: commentary between tool calls is one
 * message each) and when the turn settles (`state`, `completedAt`).
 */
export function previewRefreshKey(summaries: ReadonlyArray<BotSummary>): string {
  return summaries
    .map((summary) => {
      const thread = summary.newestThread;
      if (thread === null) return `${summary.bot.botId}=`;
      const turn = thread.latestTurn;
      return `${summary.bot.botId}=${[
        thread.id,
        thread.latestUserMessageAt ?? "",
        turn?.turnId ?? "",
        turn?.state ?? "",
        turn?.assistantMessageId ?? "",
        turn?.completedAt ?? "",
      ].join(",")}`;
    })
    .join("|");
}

function parsePreviewKey(key: string): Map<string, ReadonlyArray<string>> {
  const byBot = new Map<string, ReadonlyArray<string>>();
  for (const segment of key.split("|")) {
    const separator = segment.indexOf("=");
    if (separator <= 0) continue;
    const fields = segment.slice(separator + 1);
    byBot.set(segment.slice(0, separator), fields.length === 0 ? [] : fields.split(","));
  }
  return byBot;
}

/** Newest message boundary a key segment records (ISO strings compare in order). */
function newestBoundary(fields: ReadonlyArray<string>): string {
  const userAt = fields[1] ?? "";
  const completedAt = fields[5] ?? "";
  return userAt > completedAt ? userAt : completedAt;
}

/**
 * Whether the move from `previous` to `next` (two `previewRefreshKey`s) is a
 * message boundary worth refetching `personalBots.list` for. A boundary moved
 * on a bot's newest thread counts. A bot's newest thread changing to another
 * thread counts only when that thread has a newer message: on an app open the
 * newest thread also changes while group relays, tasks and thread shells are
 * still landing, and that cost a second and third list request per open.
 * Bots appearing or leaving come from the list itself, so they never count.
 */
export function previewKeyAdvanced(previous: string, next: string): boolean {
  if (previous === next) return false;
  const before = parsePreviewKey(previous);
  for (const [botId, fields] of parsePreviewKey(next)) {
    const old = before.get(botId);
    if (old === undefined || fields.length === 0) continue;
    if (old.length > 0 && old[0] === fields[0]) {
      if (old.join(",") !== fields.join(",")) return true;
      continue;
    }
    const boundary = newestBoundary(fields);
    if (boundary !== "" && boundary > newestBoundary(old)) return true;
  }
  return false;
}

export function filterBotSummaries(
  summaries: ReadonlyArray<BotSummary>,
  query: string,
): ReadonlyArray<BotSummary> {
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length === 0) return summaries;
  return summaries.filter(
    (summary) =>
      summary.bot.name.toLocaleLowerCase().includes(needle) ||
      summary.threadTitles.some((title) => title.toLocaleLowerCase().includes(needle)),
  );
}

/**
 * Splits the chats list into the pinned box and the list under it. Leads come
 * first in the box — the dev lead, then the assistant's — and any other pinned
 * bot keeps the order it already had. Every bot lands in exactly one of the
 * two, so a pinned bot is never listed twice.
 */
export function partitionPinnedSummaries(summaries: ReadonlyArray<BotSummary>): {
  readonly pinned: ReadonlyArray<BotSummary>;
  readonly rest: ReadonlyArray<BotSummary>;
} {
  const rank = (summary: BotSummary) => {
    if (!isTeamLead(summary.bot)) return PERSONAL_BOT_TEAM_ORDER.length + 1;
    const index = PERSONAL_BOT_TEAM_ORDER.indexOf(botTeam(summary.bot));
    return index < 0 ? PERSONAL_BOT_TEAM_ORDER.length : index;
  };
  return {
    // toSorted is stable, so equal ranks keep the incoming order.
    pinned: summaries
      .filter((summary) => isBotPinned(summary.bot))
      .toSorted((left, right) => rank(left) - rank(right)),
    rest: summaries.filter((summary) => !isBotPinned(summary.bot)),
  };
}

/** Threads waiting on the user across all bots, most recent first. */
export function collectAttentionThreads(
  summaries: ReadonlyArray<BotSummary>,
): EnvironmentThreadShell[] {
  return summaries
    .flatMap((summary) => summary.attentionThreads)
    .toSorted((left, right) => updatedMs(right) - updatedMs(left));
}
