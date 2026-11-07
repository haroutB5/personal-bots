import type { PersonalBotThread } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "./threadShell.ts";
import * as DateTime from "effect/DateTime";

const parseMs = (value: string | null | undefined): number | null => {
  if (value == null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

/**
 * When a chat last had real conversation: the owner's last message.
 */
export function chatActivityMs(
  shell: Pick<EnvironmentThreadShell, "createdAt" | "latestUserMessageAt" | "latestTurn">,
  link?: Pick<PersonalBotThread, "lastActivityAt"> | undefined,
): number {
  const turn = shell.latestTurn;
  const memo = activityMemo.get(shell);
  if (
    memo !== undefined &&
    memo.link === link &&
    memo.linkAt === link?.lastActivityAt &&
    memo.createdAt === shell.createdAt &&
    memo.latestUserMessageAt === shell.latestUserMessageAt &&
    memo.requestedAt === turn?.requestedAt &&
    memo.startedAt === turn?.startedAt &&
    memo.completedAt === turn?.completedAt
  ) {
    return memo.ms;
  }
  const ms = chatActivityMsUncached(shell, link);
  activityMemo.set(shell, {
    link,
    linkAt: link?.lastActivityAt,
    createdAt: shell.createdAt,
    latestUserMessageAt: shell.latestUserMessageAt,
    requestedAt: turn?.requestedAt,
    startedAt: turn?.startedAt,
    completedAt: turn?.completedAt,
    ms,
  });
  return ms;
}

/**
 * The last answer per shell. The Bots list sorts every bot's chats by.
 */
const activityMemo = new WeakMap<
  object,
  {
    link: unknown;
    linkAt: unknown;
    createdAt: unknown;
    latestUserMessageAt: unknown;
    requestedAt: unknown;
    startedAt: unknown;
    completedAt: unknown;
    ms: number;
  }
>();

/** The same answer without the memo: the `activity-memo` kill switch (botSummaries.ts) uses it. */
export function chatActivityMsUncached(
  shell: Pick<EnvironmentThreadShell, "createdAt" | "latestUserMessageAt" | "latestTurn">,
  link: Pick<PersonalBotThread, "lastActivityAt"> | undefined,
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
