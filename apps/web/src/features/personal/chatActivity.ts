import type { PersonalBotThread } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import * as DateTime from "effect/DateTime";

const parseMs = (value: string | null | undefined): number | null => {
  if (value == null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

/**
 * When a chat last had real conversation: the owner's last message, the
 * latest turn starting or ending, the newest message the server reports for
 * it (a relay routine posts without a turn), else when it was made. What the
 * Bots list and a bot's chat list order by and show as "7m".
 *
 * Never the shell's `updatedAt`: any metadata write moves it. On 28 Sep two
 * 3-day-old chats jumped to the top of the Bots list as "Now" when upstream's
 * auto-settle settled them (settle after 3 days idle stamps updatedAt, and
 * its session stop adds more).
 */
export function chatActivityMs(
  shell: Pick<EnvironmentThreadShell, "createdAt" | "latestUserMessageAt" | "latestTurn">,
  link?: Pick<PersonalBotThread, "lastActivityAt"> | undefined,
): number {
  const turn = shell.latestTurn;
  const times = [
    shell.createdAt,
    shell.latestUserMessageAt,
    turn?.requestedAt,
    turn?.startedAt,
    turn?.completedAt,
  ]
    .map(parseMs)
    .filter((ms): ms is number => ms !== null);
  if (link?.lastActivityAt != null) times.push(DateTime.toEpochMillis(link.lastActivityAt));
  return times.length === 0 ? 0 : Math.max(...times);
}
