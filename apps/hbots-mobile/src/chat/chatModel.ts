import {
  type EnvironmentId,
  type ModelSelection,
  type OrchestrationSession,
  type OrchestrationV2ThreadProjection,
  type PersonalBot,
  type PersonalBotThread,
  type ServerProvider,
  botEffectiveModelSelection,
} from "@t3tools/contracts";
import {
  deriveLatestContextWindowSnapshot,
  latestProviderTurnTokenUsage,
} from "@t3tools/client-runtime/state/context-window";
import * as DateTime from "effect/DateTime";
import type {
  EnvironmentThreadShell,
  OrchestrationLatestTurn,
} from "@hbots/personal-client/bots/threadShell";
import { botMuteState, mutedUntilLabel } from "@hbots/personal-client/bots/botMuteModel";
import { botActiveModelShortLabel } from "@hbots/personal-client/bots/botModelLabel";
import { conversationChatTitle } from "@hbots/personal-client/feed/chatNames";
import {
  contextBadgeLabel,
  conversationHeaderStateLabel,
  deriveConversationState,
  isTurnThinking,
  type ConversationState,
} from "@hbots/personal-client/conversation/conversationModel";
import { formatContextWindowTokens } from "@hbots/personal-client/conversation/contextWindowTokens";

export interface ChatBotRecord {
  readonly bot: PersonalBot;
  readonly shell: EnvironmentThreadShell | null;
  readonly link: PersonalBotThread | null;
}

export interface ChatHeaderModel {
  readonly botName: string;
  readonly chatTitle: string | null;
  readonly muted: boolean;
  readonly muteLabel: string | null;
  readonly contextBadge: string | null;
  readonly state: ConversationState;
  readonly stateLabel: string;
  readonly modelLabel: string | null;
  readonly thinking: boolean;
}

export function findChatBot(
  bots: ReadonlyArray<PersonalBot>,
  links: ReadonlyArray<PersonalBotThread>,
  shells: ReadonlyArray<EnvironmentThreadShell>,
  botId: string,
  threadId: string,
): ChatBotRecord | null {
  const bot = bots.find((candidate) => candidate.botId === botId);
  if (bot === undefined) return null;
  const link = links.find((candidate) => candidate.threadId === threadId) ?? null;
  const shell = shells.find((candidate) => candidate.id === threadId) ?? null;
  return { bot, link, shell };
}

/** The open chat's context use, in tokens, with the window size when the provider reports one. */
export interface ChatContextUsage {
  readonly usedTokens: number;
  readonly maxTokens: number | null;
}

/**
 * The chat's context use from the v2 projection, the source the web composer
 * reads. The active provider thread's own report wins, then its newest turn's
 * usage, then the last compaction's token count. Null when the chat has never
 * reported one.
 */
export function chatContextUsage(
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "contextTransfers" | "providerThreads" | "providerTurns" | "visibleTurnItems"
  > | null,
): ChatContextUsage | null {
  if (projection === null) return null;
  const providerThread =
    projection.providerThreads.find(
      (candidate) => candidate.id === projection.thread.activeProviderThreadId,
    ) ?? null;
  const live = latestProviderTurnTokenUsage(projection.providerTurns, projection, providerThread);
  const snapshot = deriveLatestContextWindowSnapshot(
    projection.visibleTurnItems,
    live,
    providerThread,
  );
  if (snapshot === null) return null;
  const rawMaxTokens = snapshot.maxTokens;
  const maxTokens =
    typeof rawMaxTokens === "number" && Number.isFinite(rawMaxTokens) && rawMaxTokens > 0
      ? rawMaxTokens
      : null;
  return { usedTokens: snapshot.usedTokens, maxTokens };
}

/** "84k / 1m" with the window size, "84k" when the window is unknown, null before any report. */
export function contextUsageLabel(usage: ChatContextUsage | null): string | null {
  if (usage === null) return null;
  const used = contextBadgeLabel(usage.usedTokens);
  if (used === null) return null;
  return usage.maxTokens === null
    ? used
    : `${used} / ${formatContextWindowTokens(usage.maxTokens)}`;
}

export function chatHeaderModel(input: {
  readonly bot: PersonalBot | null;
  readonly shell: EnvironmentThreadShell | null;
  readonly title: string | null;
  readonly session: OrchestrationSession | null;
  readonly latestTurn: OrchestrationLatestTurn | null;
  readonly activities: ReadonlyArray<{
    readonly kind: string;
    readonly payload: unknown;
    readonly tone: string;
    readonly turnId: string | null;
  }>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly contextUsage: ChatContextUsage | null;
  readonly nowMs: number;
  /** The last list's name for this bot, used when the live list is offline. */
  readonly fallbackBotName?: string | null;
}): ChatHeaderModel {
  const state = deriveConversationState({
    session: input.session,
    latestTurn: input.latestTurn,
    pendingApprovals: [],
    pendingUserInputs: [],
  });
  const thinking = isTurnThinking({
    session: input.session,
    latestTurn: input.latestTurn,
    activities: input.activities as never,
  });
  const mute =
    input.bot === null ? { muted: false as const } : botMuteState(input.bot, input.nowMs);
  return {
    botName: input.bot?.name ?? input.fallbackBotName ?? "Bot",
    chatTitle: conversationChatTitle(input.title),
    muted: mute.muted,
    muteLabel: mute.muted ? mutedUntilLabel(mute, input.nowMs) : null,
    contextBadge: contextUsageLabel(input.contextUsage),
    state,
    stateLabel: conversationHeaderStateLabel({
      state,
      thinking,
      waitingLabel: null,
      session: input.session,
      now: new Date(input.nowMs),
    }),
    modelLabel: input.bot === null ? null : botActiveModelShortLabel(input.bot, input.providers),
    thinking,
  };
}

export interface ChatChipModel {
  readonly threadId: string;
  readonly text: string;
  readonly current: boolean;
  readonly pinned: boolean;
  readonly unread: boolean;
  readonly state: ConversationState;
}

/**
 * The bot's chat chips, pinned first then newest activity first: the order of
 * the bot's chat list. The current chat always has a chip.
 */
export function buildChatChips(input: {
  readonly botId: string;
  readonly currentThreadId: string;
  readonly links: ReadonlyArray<PersonalBotThread>;
  readonly shells: ReadonlyArray<EnvironmentThreadShell>;
}): ReadonlyArray<ChatChipModel> {
  const shellById = new Map(input.shells.map((shell) => [shell.id as string, shell]));
  const rows = input.links
    .filter((link) => link.botId === input.botId && link.archivedAt === null)
    .flatMap((link) => {
      const shell = shellById.get(link.threadId);
      if (shell === undefined) return [];
      return [{ link, shell }];
    });
  const current = rows.find((row) => row.link.threadId === input.currentThreadId);
  const sorted = [...rows].sort((left, right) => {
    const pinnedLeft = left.link.pinnedAt !== undefined;
    const pinnedRight = right.link.pinnedAt !== undefined;
    if (pinnedLeft !== pinnedRight) return pinnedLeft ? -1 : 1;
    const leftAt = DateTime.toEpochMillis(left.link.lastActivityAt ?? left.link.createdAt);
    const rightAt = DateTime.toEpochMillis(right.link.lastActivityAt ?? right.link.createdAt);
    return rightAt - leftAt;
  });
  if (current === undefined && input.currentThreadId.length > 0) {
    const shell = shellById.get(input.currentThreadId);
    if (shell !== undefined) {
      sorted.unshift({
        link: {
          botId: input.botId as PersonalBotThread["botId"],
          threadId: input.currentThreadId as PersonalBotThread["threadId"],
          createdAt: shell.createdAt as never,
          archivedAt: null,
        },
        shell,
      });
    }
  }
  return sorted.map((row) => {
    const threadId = row.link.threadId as string;
    const currentChip = threadId === input.currentThreadId;
    const state: ConversationState = currentChip
      ? "idle"
      : deriveConversationState({
          session: row.shell.session,
          latestTurn: row.shell.latestTurn,
          pendingApprovals: [],
          pendingUserInputs: [],
        });
    return {
      threadId,
      text: conversationChatTitle(row.shell.title) ?? "New chat",
      current: currentChip,
      pinned: row.link.pinnedAt !== null,
      unread: row.link.unread === true && !currentChip,
      state,
    };
  });
}

export function chatSendModelSelection(
  bot: PersonalBot | null,
  threadSelection: ModelSelection,
): ModelSelection {
  return bot === null ? threadSelection : botEffectiveModelSelection(bot);
}

export function isOfflineNotice(phase: string): boolean {
  return phase !== "connected";
}

export function threadWorkspaceRoot(
  thread: { readonly worktreePath?: string | null } | null,
  environmentId: EnvironmentId | null,
): string | null {
  if (thread === null || environmentId === null) return null;
  return thread.worktreePath ?? null;
}
