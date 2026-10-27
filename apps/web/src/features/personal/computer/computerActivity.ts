import type { ActivitySource, ComputerActivityEvent } from "./computerContract";

export type ActivityIcon =
  | "globe"
  | "type"
  | "pointer"
  | "monitor"
  | "hand"
  | "shield"
  | "download";

export interface ActivityRow {
  readonly id: string;
  readonly source: ActivitySource;
  /** "You", the bot's name, or null when the server named nobody. */
  readonly actor: string | null;
  /** The summary without the actor, e.g. "clicked Continue". */
  readonly text: string;
  readonly failed: boolean;
  /** "paused" or "refused" when the step did not fail outright. */
  readonly outcome: "paused" | "refused" | null;
  readonly at: string;
  readonly icon: ActivityIcon;
  readonly threadId: string | null;
  /** A saved file: the row links to Files. */
  readonly isDownload: boolean;
}

export interface ActivityGroup {
  readonly key: string;
  readonly head: ActivityRow;
  /** Older rows folded under the head, newest first. */
  readonly rest: ReadonlyArray<ActivityRow>;
}

export const ACTIVITY_GROUP_WINDOW_MS = 2 * 60 * 1000;

/** Kinds that are about who holds the machine, not a step a bot took. */
const CONTROL_KINDS: ReadonlySet<string> = new Set(["control", "release", "stop", "help"]);

function atMillis(iso: string): number {
  const millis = Date.parse(iso);
  return Number.isFinite(millis) ? millis : 0;
}

/** Both sources in one list, newest first, duplicates by id dropped. */
export function mergeActivity(
  ...feeds: ReadonlyArray<ReadonlyArray<ComputerActivityEvent>>
): ComputerActivityEvent[] {
  const seen = new Set<string>();
  const merged: ComputerActivityEvent[] = [];
  for (const feed of feeds) {
    for (const event of feed) {
      const key = `${event.source}:${event.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(event);
    }
  }
  // Array.prototype.sort is stable, so same-instant events keep feed order.
  return merged.toSorted((a, b) => atMillis(b.at) - atMillis(a.at));
}

/** "Clicked" -> "clicked", but "PDF saved" stays as written. */
function lowerFirstWord(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length < 2) return trimmed.toLowerCase();
  const [first = "", second = ""] = [trimmed[0], trimmed[1]];
  const isAcronym =
    first === first.toUpperCase() && second === second.toUpperCase() && /[A-Z]/.test(second);
  return isAcronym ? trimmed : first.toLowerCase() + trimmed.slice(1);
}

function charCount(event: ComputerActivityEvent): number | null {
  if (event.chars !== null) return event.chars;
  const match = /(\d+)\s*(?:characters?|chars?)/i.exec(event.summary);
  return match?.[1] === undefined ? null : Number(match[1]);
}

function iconFor(event: ComputerActivityEvent): ActivityIcon {
  if (event.kind === "download") return "download";
  if (event.kind === "help") return "hand";
  if (/paused before|sensitive/i.test(event.summary)) return "shield";
  if (event.kind === "type") return "type";
  if (event.kind === "control" || event.kind === "release" || event.kind === "stop") {
    return "pointer";
  }
  if (event.source === "desktop") {
    return event.kind === "click" || event.kind === "drag" || event.kind === "scroll"
      ? "pointer"
      : "monitor";
  }
  switch (event.kind) {
    case "click":
    case "hover":
    case "drag":
    case "scroll":
    case "press":
      return "pointer";
    default:
      return "globe";
  }
}

export function describeActivity(event: ComputerActivityEvent): ActivityRow {
  const summary = event.summary.trim();
  let actor: string | null;
  let text: string;
  if (/^you\b/i.test(summary)) {
    actor = "You";
    text = summary.replace(/^you\s+/i, "");
  } else {
    actor = event.botName;
    text = actor === null ? summary : lowerFirstWord(summary);
  }
  // Privacy: what a bot typed on the desktop is never shown, only how much.
  if (event.kind === "type" && event.source === "desktop") {
    const count = charCount(event);
    text = count === null ? "typed text" : `typed ${count} character${count === 1 ? "" : "s"}`;
  }
  return {
    id: event.id,
    source: event.source,
    actor,
    text,
    failed: event.status === "failed",
    outcome: event.outcome ?? null,
    at: event.at,
    icon: iconFor(event),
    threadId: event.threadId,
    isDownload: event.kind === "download",
  };
}

/**
 * Folds consecutive steps by the same bot on the same source within two
 * minutes into one row (newest first in, newest first out). Control rows and
 * failures stand alone so they are never hidden behind "+N more".
 */
export function groupActivity(events: ReadonlyArray<ComputerActivityEvent>): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  let open: {
    head: ActivityRow;
    rest: ActivityRow[];
    actor: string | null;
    source: ActivitySource;
    lastAt: number;
  } | null = null;
  const flush = () => {
    if (open !== null) groups.push({ key: open.head.id, head: open.head, rest: open.rest });
    open = null;
  };
  for (const event of events) {
    const row = describeActivity(event);
    const groupable =
      !CONTROL_KINDS.has(event.kind) && row.actor !== "You" && row.actor !== null && !row.failed;
    const at = atMillis(event.at);
    if (
      open !== null &&
      groupable &&
      open.actor === row.actor &&
      open.source === row.source &&
      open.lastAt - at <= ACTIVITY_GROUP_WINDOW_MS
    ) {
      open.rest.push(row);
      open.lastAt = at;
      continue;
    }
    flush();
    if (groupable) {
      open = { head: row, rest: [], actor: row.actor, source: row.source, lastAt: at };
    } else {
      groups.push({ key: row.id, head: row, rest: [] });
    }
  }
  flush();
  return groups;
}

export interface BotActionRef {
  readonly source: ActivitySource;
  readonly at: number;
  readonly botName: string | null;
}

/** The newest step a bot took, on either source (drives Auto follow). */
export function latestBotAction(events: ReadonlyArray<ComputerActivityEvent>): BotActionRef | null {
  let best: BotActionRef | null = null;
  for (const event of events) {
    if (CONTROL_KINDS.has(event.kind) || /^you\b/i.test(event.summary)) continue;
    const at = atMillis(event.at);
    if (best === null || at > best.at) best = { source: event.source, at, botName: event.botName };
  }
  return best;
}

/** The newest step by `botName` on `source`, as the driver card's "latest step". */
export function latestStep(
  events: ReadonlyArray<ComputerActivityEvent>,
  source: ActivitySource,
  botName: string | null,
): string | null {
  let best: ComputerActivityEvent | null = null;
  for (const event of events) {
    if (event.source !== source || CONTROL_KINDS.has(event.kind)) continue;
    if (botName !== null && event.botName !== botName) continue;
    if (best === null || atMillis(event.at) > atMillis(best.at)) best = event;
  }
  if (best === null) return null;
  const row = describeActivity(best);
  return row.text;
}

/** When the current run of steps by `botName` on `source` began (epoch ms). */
export function runStartedAt(
  events: ReadonlyArray<ComputerActivityEvent>,
  source: ActivitySource,
  botName: string | null,
): number | null {
  const mine = events
    .filter(
      (event) =>
        event.source === source &&
        (botName === null || event.botName === botName) &&
        !CONTROL_KINDS.has(event.kind),
    )
    .map((event) => atMillis(event.at))
    .toSorted((a, b) => b - a);
  const newest = mine[0];
  if (newest === undefined) return null;
  let start = newest;
  for (const at of mine) {
    if (start - at > 10 * 60 * 1000) break;
    start = at;
  }
  return start;
}

/** "just now", "3 min", "1 h 5 min": how long ago `from` was. */
export function formatElapsed(from: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - from) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}
