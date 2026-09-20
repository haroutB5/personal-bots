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
