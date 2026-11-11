import type { WorkingThread } from "./workingThreads";

/** What crosses to the native notification: one entry per working bot. */
export interface WorkingFeedBot {
  readonly botId: string;
  readonly name: string;
  /** The bot's current step. Native shows it only when the lock and the bot's privacy allow. */
  readonly note?: string;
}

/** Native shows five lines at most; this keeps the bridge payload small. */
export const MAX_FEED_BOTS = 8;
const MAX_NOTE = 80;

const STEP_WORDS: Readonly<Record<string, string>> = {
  command_execution: "Running a command",
  file_change: "Editing files",
  file_search: "Searching files",
  web_search: "Searching the web",
  dynamic_tool: "Using a tool",
  subagent: "Working with a helper",
};

/** What the server leaves as a step when a tool item has no title: its raw item type, such as `user_input_request`. */
const RAW_TOKEN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

/** A step in words. A raw type with no wording is dropped, so the notice says "Working…" instead. */
export function humanStep(note: string | undefined): string | undefined {
  const trimmed = note?.trim();
  if (!trimmed) return undefined;
  if (!RAW_TOKEN.test(trimmed)) return trimmed;
  return STEP_WORDS[trimmed];
}

/**
 * One entry per bot that is working, even when it runs several chats. A chat that only waits for an
 * answer is not working. The first working chat with a note supplies it.
 */
export function buildWorkingFeed(
  threads: ReadonlyArray<WorkingThread>,
  notes: ReadonlyMap<string, string>,
): ReadonlyArray<WorkingFeedBot> {
  const byBot = new Map<string, { name: string; note: string | undefined }>();
  for (const thread of threads) {
    if (thread.state === "waiting") continue;
    const note = humanStep(notes.get(thread.threadId));
    const entry = byBot.get(thread.botId);
    if (entry === undefined) {
      byBot.set(thread.botId, { name: thread.botName, note: note ? note : undefined });
    } else if (entry.note === undefined && note) {
      entry.note = note;
    }
  }
  return [...byBot.entries()].slice(0, MAX_FEED_BOTS).map(([botId, entry]) => ({
    botId,
    name: entry.name,
    ...(entry.note === undefined ? {} : { note: entry.note.slice(0, MAX_NOTE) }),
  }));
}

export function feedKey(feed: ReadonlyArray<WorkingFeedBot>): string {
  return JSON.stringify(feed.map((bot) => [bot.botId, bot.name, bot.note ?? null]));
}

export interface WorkingSink {
  set(feed: ReadonlyArray<WorkingFeedBot>): void;
  clear(): void;
}

export interface WorkingPublisher {
  /** `null` means the read is not trustworthy yet (still synchronizing): change nothing. */
  update(feed: ReadonlyArray<WorkingFeedBot> | null): void;
  /** Sends the current feed again so native keeps the notification alive. */
  heartbeat(): void;
  reset(): void;
}

/** How often a working feed is resent. Native shows it at most this often and expires it at 3x. */
export const HEARTBEAT_MS = 15_000;

/** Sends only changes, plus an explicit heartbeat, and clears once when the last run ends. */
export function createWorkingPublisher(sink: WorkingSink): WorkingPublisher {
  let lastKey = "";
  let current: ReadonlyArray<WorkingFeedBot> = [];
  return {
    update(feed) {
      if (feed === null) return;
      if (feed.length === 0) {
        if (current.length > 0) sink.clear();
        current = [];
        lastKey = "";
        return;
      }
      const key = feedKey(feed);
      current = feed;
      if (key === lastKey) return;
      lastKey = key;
      sink.set(feed);
    },
    heartbeat() {
      if (current.length > 0) sink.set(current);
    },
    reset() {
      current = [];
      lastKey = "";
    },
  };
}
