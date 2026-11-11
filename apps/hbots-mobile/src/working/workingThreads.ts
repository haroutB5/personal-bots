import { isThreadLive, threadNeedsAttention } from "@hbots/personal-client/bots/botSummaries";
import type { EnvironmentThreadShell } from "@hbots/personal-client/bots/threadShell";

export interface WorkingBotRecord {
  readonly botId: string;
  readonly name?: string | null;
}

export interface WorkingLink {
  readonly botId: string;
  readonly threadId: string;
}

/**
 * `working`: the bot is doing the work. `waiting`: its turn is open but it needs the owner's approval or
 * answer first, so it is not working and the "bots working" notice must not count it.
 */
export type WorkingThreadState = "working" | "waiting";

/** One chat that is running a turn right now. */
export interface WorkingThread {
  readonly threadId: string;
  readonly botId: string;
  readonly botName: string;
  readonly title: string;
  readonly state: WorkingThreadState;
}

const FALLBACK_BOT_NAME = "hbots";

/**
 * Every chat of a known bot that is running now, in a steady order (bot name, then chat id) so the
 * notification and the Stop list do not shuffle between reads. A parked rate limit is not working. A chat that waits for an answer is listed, as `waiting`.
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
    found.push({
      threadId: link.threadId,
      botId: link.botId,
      botName,
      title: shell.title,
      state: threadNeedsAttention(shell) ? "waiting" : "working",
    });
  }
  return found.toSorted(
    (left, right) =>
      left.botName.localeCompare(right.botName) || left.threadId.localeCompare(right.threadId),
  );
}
