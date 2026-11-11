import { isThreadLive } from "@hbots/personal-client/bots/botSummaries";
import type { EnvironmentThreadShell } from "@hbots/personal-client/bots/threadShell";

export interface WorkingBotRecord {
  readonly botId: string;
  readonly name?: string | null;
}

export interface WorkingLink {
  readonly botId: string;
  readonly threadId: string;
}

/** One chat that is running a turn right now. */
export interface WorkingThread {
  readonly threadId: string;
  readonly botId: string;
  readonly botName: string;
  readonly title: string;
}

const FALLBACK_BOT_NAME = "hbots";

/**
 * Every chat of a known bot that is running now, in a steady order (bot name, then chat id) so the
 * notification and the Stop list do not shuffle between reads. A parked rate limit is not working.
 */
export function workingThreads(input: {
  readonly bots: ReadonlyArray<WorkingBotRecord>;
  readonly links: ReadonlyArray<WorkingLink>;
  readonly shells: ReadonlyArray<EnvironmentThreadShell>;
}): ReadonlyArray<WorkingThread> {
  const nameByBot = new Map(
    input.bots.map((bot) => [bot.botId, bot.name?.trim() ? bot.name.trim() : FALLBACK_BOT_NAME]),
  );
  const shellById = new Map(input.shells.map((shell) => [shell.id as string, shell]));
  const found: WorkingThread[] = [];
  for (const link of input.links) {
    const botName = nameByBot.get(link.botId);
    const shell = shellById.get(link.threadId);
    if (botName === undefined || shell === undefined || !isThreadLive(shell)) continue;
    found.push({ threadId: link.threadId, botId: link.botId, botName, title: shell.title });
  }
  return found.toSorted(
    (left, right) =>
      left.botName.localeCompare(right.botName) || left.threadId.localeCompare(right.threadId),
  );
}
