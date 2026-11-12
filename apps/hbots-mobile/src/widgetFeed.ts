import { splitChoices } from "@hbots/personal-client/conversation/choices";

import type {
  WidgetBot,
  WidgetEvent,
  WidgetFeed,
  WidgetMachine,
  WidgetQuestion,
} from "./launcher/nativeLauncher";
import { humanStep } from "./working/workingFeed";

/** Native draws at most six bots; this keeps the bridge payload small. */
export const MAX_WIDGET_BOTS = 8;
export const MAX_ACTIVITY = 60;
export const MAX_QUESTION = 120;
export const MAX_CHOICES = 3;
export const MAX_CHOICE = 40;
export const MAX_EVENTS = 3;
export const MAX_TITLE = 60;
export const FEED_VERSION = 2;

export interface WidgetBotInput {
  readonly botId: string;
  readonly name: string;
  readonly enabled?: boolean;
  readonly pinned?: boolean;
  /** The owner hid this bot's previews: none of its text may reach the home screen. */
  readonly hidePreviews?: boolean;
  readonly avatarColor?: string;
}

export interface WidgetThreadInput {
  readonly threadId: string;
  readonly botId: string;
  readonly title: string;
  readonly state: "working" | "waiting";
  /** When the running turn started, epoch ms. */
  readonly sinceMs?: number;
}

/** A chat's newest message, for the question card. */
export interface WidgetMessageInput {
  readonly threadId: string;
  readonly botId: string;
  readonly role: string;
  readonly text: string;
  readonly atMs: number;
  readonly chatTitle: string;
}

export interface WidgetTaskInput {
  readonly title: string;
  readonly botId: string;
  readonly status: string;
  readonly completedAtMs: number | null;
}

export interface WidgetRoutineInput {
  readonly title: string;
  readonly enabled: boolean;
  readonly nextDueAtMs: number | null;
}

export interface WidgetUsageInput {
  readonly title: string;
  readonly sessionPct: number | null;
  readonly weekPct: number | null;
  /** The clock time the session window resets, as the usage sheet words it. */
  readonly resets: string | null;
}

export interface WidgetSystemInput {
  readonly cpuPct: number | null;
  readonly memUsedGB: number | null;
  readonly memTotalGB: number | null;
  readonly cpuTempC: number | null;
  readonly diskFreeGB: number | null;
  readonly gamingPc:
    | { readonly state: "starting" }
    | {
        readonly state: "on";
        readonly cpuPct: number;
        readonly gpuPct: number | null;
        readonly memUsedGB: number;
        readonly memTotalGB: number;
        readonly users: ReadonlyArray<
          | { readonly kind: "game"; readonly label: string }
          | { readonly kind: "bot"; readonly bot: string }
        >;
      }
    | null;
}

export interface WidgetFeedInput {
  readonly bots: ReadonlyArray<WidgetBotInput>;
  readonly threads: ReadonlyArray<WidgetThreadInput>;
  /** The current step per working chat, by chat id. */
  readonly notes?: ReadonlyMap<string, string>;
  readonly unreadByBot?: ReadonlyMap<string, number>;
  readonly messages?: ReadonlyArray<WidgetMessageInput>;
  readonly tasks?: ReadonlyArray<WidgetTaskInput>;
  readonly routines?: ReadonlyArray<WidgetRoutineInput>;
  readonly usage?: WidgetUsageInput | null;
  readonly system?: WidgetSystemInput | null;
  readonly now: number;
}

/** One line of plain text: no control characters, single spaces, at most `max` characters. */
export function widgetText(raw: string, max: number): string {
  const flat = raw
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

const whole = (value: number | null): number | null =>
  value === null || !Number.isFinite(value) ? null : Math.round(value);

const pct = (value: number | null): number | null => {
  const rounded = whole(value);
  return rounded === null ? null : Math.min(100, Math.max(0, rounded));
};

function startOfDay(now: number): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

function buildBots(input: WidgetFeedInput): ReadonlyArray<WidgetBot> {
  const working = new Map<string, WidgetThreadInput>();
  const waiting = new Set<string>();
  const activity = new Map<string, string>();
  for (const thread of input.threads) {
    if (thread.state === "waiting") {
      waiting.add(thread.botId);
      continue;
    }
    if (!working.has(thread.botId)) working.set(thread.botId, thread);
    const note = humanStep(input.notes?.get(thread.threadId));
    if (note !== undefined && !activity.has(thread.botId)) activity.set(thread.botId, note);
  }
  const rank = (bot: WidgetBotInput) =>
    working.has(bot.botId) ? 0 : waiting.has(bot.botId) ? 1 : 2;
  return bots(input)
    .filter((bot) => bot.pinned === true || rank(bot) < 2)
    .map((bot, index) => ({ bot, index }))
    .toSorted((left, right) => rank(left.bot) - rank(right.bot) || left.index - right.index)
    .slice(0, MAX_WIDGET_BOTS)
    .map(({ bot }): WidgetBot => {
      const thread = working.get(bot.botId);
      const note = bot.hidePreviews === true ? undefined : activity.get(bot.botId);
      const unread = input.unreadByBot?.get(bot.botId) ?? 0;
      return {
        botId: bot.botId,
        name: widgetText(bot.name, 40),
        working: thread !== undefined,
        ...(thread === undefined && waiting.has(bot.botId) ? { waiting: true } : {}),
        ...(note === undefined ? {} : { activity: widgetText(note, MAX_ACTIVITY) }),
        ...(thread?.sinceMs === undefined ? {} : { sinceMs: thread.sinceMs }),
        ...(unread > 0 ? { unread: Math.min(unread, 99) } : {}),
        ...(bot.avatarColor !== undefined && /^#[0-9A-Fa-f]{6}$/.test(bot.avatarColor)
          ? { color: bot.avatarColor }
          : {}),
      };
    });
}

const bots = (input: WidgetFeedInput) => input.bots.filter((bot) => bot.enabled !== false);

/**
 * The one thing waiting for the owner: a chat parked on an approval or an answer first, else the
 * newest reply that ends in a set of choices. A bot with hidden previews gives its name only.
 */
function buildQuestion(input: WidgetFeedInput): WidgetQuestion | undefined {
  const byId = new Map(bots(input).map((bot) => [bot.botId, bot]));
  const newest = new Map((input.messages ?? []).map((message) => [message.threadId, message]));
  const link = (botId: string, threadId: string) => `hbots://chat/${botId}/${threadId}`;

  const parked = input.threads.find(
    (thread) => thread.state === "waiting" && byId.has(thread.botId),
  );
  const asked =
    parked ??
    (input.messages ?? [])
      .filter(
        (message) =>
          message.role === "assistant" &&
          byId.get(message.botId) !== undefined &&
          byId.get(message.botId)?.hidePreviews !== true &&
          splitChoices(message.text).options !== null,
      )
      .toSorted((left, right) => right.atMs - left.atMs)[0];
  if (asked === undefined) return undefined;

  const bot = byId.get(asked.botId);
  if (bot === undefined) return undefined;
  const message = newest.get(asked.threadId);
  const shown =
    bot.hidePreviews === true || message === undefined || message.role !== "assistant"
      ? null
      : splitChoices(message.text);
  const chatTitle = "chatTitle" in asked ? asked.chatTitle : asked.title;
  return {
    botId: bot.botId,
    botName: widgetText(bot.name, 40),
    chatTitle: bot.hidePreviews === true ? "" : widgetText(chatTitle, 40),
    text: shown === null ? "" : widgetText(shown.body, MAX_QUESTION),
    choices: (shown?.options ?? [])
      .filter((option) => option.length <= MAX_CHOICE)
      .slice(0, MAX_CHOICES)
      .map((option) => widgetText(option, MAX_CHOICE)),
    link: link(bot.botId, asked.threadId),
    ...(message === undefined ? {} : { atMs: message.atMs }),
  };
}

function buildToday(input: WidgetFeedInput): WidgetFeed["today"] {
  if (input.tasks === undefined && input.routines === undefined) return undefined;
  const byId = new Map(bots(input).map((bot) => [bot.botId, bot]));
  const from = startOfDay(input.now);
  const tasks = input.tasks ?? [];
  const finished = tasks.filter(
    (task) =>
      (task.status === "completed" || task.status === "failed") &&
      task.completedAtMs !== null &&
      task.completedAtMs >= from,
  );
  const events = finished
    .toSorted((left, right) => (right.completedAtMs ?? 0) - (left.completedAtMs ?? 0))
    .slice(0, MAX_EVENTS)
    .map((task): WidgetEvent => {
      const bot = byId.get(task.botId);
      return {
        kind: task.status === "failed" ? "failed" : "done",
        title: bot?.hidePreviews === true ? "" : widgetText(task.title, MAX_TITLE),
        bot: widgetText(bot?.name ?? "", 40),
        atMs: task.completedAtMs ?? 0,
      };
    });
  const next = (input.routines ?? [])
    .filter(
      (routine) =>
        routine.enabled && routine.nextDueAtMs !== null && routine.nextDueAtMs > input.now,
    )
    .toSorted((left, right) => (left.nextDueAtMs ?? 0) - (right.nextDueAtMs ?? 0))[0];
  return {
    done: finished.filter((task) => task.status === "completed").length,
    failed: finished.filter((task) => task.status === "failed").length,
    running: tasks.filter((task) => task.status === "running").length,
    events,
    ...(next === undefined
      ? {}
      : { next: { title: widgetText(next.title, MAX_TITLE), atMs: next.nextDueAtMs ?? 0 } }),
  };
}

function buildMachines(system: WidgetSystemInput): {
  readonly laptop: WidgetMachine;
  readonly gamingPc?: WidgetMachine;
} {
  const tenth = (value: number | null) =>
    value === null || !Number.isFinite(value) ? null : Math.round(value);
  const laptop: WidgetMachine = {
    cpuPct: pct(system.cpuPct),
    memUsedGB: tenth(system.memUsedGB),
    memTotalGB: tenth(system.memTotalGB),
    tempC: whole(system.cpuTempC),
    diskFreeGB: whole(system.diskFreeGB),
  };
  const pc = system.gamingPc;
  if (pc === null || pc.state !== "on") return { laptop };
  return {
    laptop,
    gamingPc: {
      cpuPct: pct(pc.cpuPct),
      memUsedGB: tenth(pc.memUsedGB),
      memTotalGB: tenth(pc.memTotalGB),
      gpuPct: pct(pc.gpuPct),
      users: pc.users
        .slice(0, 3)
        .map((user) => widgetText(user.kind === "bot" ? user.bot : user.label, 24))
        .filter((name) => name.length > 0),
    },
  };
}

/**
 * Everything the eight home screen widgets draw. The owner chose to show bot activity and questions
 * there, so it carries text: each string is one cleaned, capped line, a bot with hidden previews
 * gives its name and state only, and a part with no source is left out, never made up.
 */
export function buildWidgetFeed(input: WidgetFeedInput): WidgetFeed {
  const question = buildQuestion(input);
  const today = buildToday(input);
  const usage = input.usage ?? null;
  const machines =
    input.system === null || input.system === undefined ? null : buildMachines(input.system);
  return {
    v: FEED_VERSION,
    bots: buildBots(input),
    ...(usage === null || (usage.sessionPct === null && usage.weekPct === null)
      ? {}
      : {
          usage: {
            title: widgetText(usage.title, 24),
            sessionPct: pct(usage.sessionPct),
            weekPct: pct(usage.weekPct),
            ...(usage.resets === null ? {} : { resets: widgetText(usage.resets, 24) }),
          },
        }),
    ...(machines === null ? {} : machines),
    ...(today === undefined ? {} : { today }),
    ...(question === undefined ? {} : { question }),
  };
}

/** Whether the feed still needs the 15 s beat: a lit working dot goes out without it. */
export function widgetFeedIsLive(feed: WidgetFeed | null): boolean {
  return feed?.bots.some((bot) => bot.working) ?? false;
}
