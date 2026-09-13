import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  isProviderAvailable,
  type PersonalBot,
  type PersonalBotThread,
  type PersonalBotThreadNewestMessage,
  type ServerProvider,
} from "@t3tools/contracts";

import { providerWaitState } from "./conversationModel";

export interface BotProviderStatus {
  readonly label: string;
  /** False when the bot's instance is missing, disabled or unavailable. */
  readonly available: boolean;
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
  /** Linked threads waiting on the user (approval or requested input). */
  readonly attentionThreads: ReadonlyArray<EnvironmentThreadShell>;
  /** "Waiting for Developer": a linked thread's task is parked on delegated work. */
  readonly waitingFor: string | null;
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
    return { label: humanizeInstanceId(instanceId), available: false };
  }
  const label = resolveProviderInstanceDisplayName(snapshot);
  return {
    // The bots UI names Anthropic's runtime by its product name.
    label: label === "Claude" ? "Claude Code" : label,
    available: snapshot.enabled && isProviderAvailable(snapshot),
  };
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
    return {
      bot,
      provider: resolveBotProvider(bot.modelSelection.instanceId, input.providers),
      newestThread,
      newestMessage:
        newestThread === null ? null : (newestMessageByThread.get(newestThread.id) ?? null),
      threadTitles: shells.map((shell) => shell.title),
      live: shells.some(isThreadLive),
      rateLimited: shells.some(isThreadRateLimited),
      attentionThreads: shells.filter(threadNeedsAttention),
      waitingFor:
        shells
          .map((shell) => input.waitingByThread?.get(shell.id) ?? null)
          .find((label) => label !== null) ?? null,
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

/** Threads waiting on the user across all bots, most recent first. */
export function collectAttentionThreads(
  summaries: ReadonlyArray<BotSummary>,
): EnvironmentThreadShell[] {
  return summaries
    .flatMap((summary) => summary.attentionThreads)
    .toSorted((left, right) => updatedMs(right) - updatedMs(left));
}
