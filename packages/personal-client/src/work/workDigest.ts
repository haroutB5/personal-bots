import type { PersonalWorkEvent, WorkTaskRef } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { formatSpan } from "./projectCards.ts";
import { taskDisplayTitle } from "./taskPresentation.ts";

export const WORK_DIGEST_VISIBLE = 5;

export type WorkDigestTone = "failure" | "done" | "dropped" | "restarted" | "started";

export interface WorkDigestLine {
  readonly key: string;
  /** The mark the line starts with, colored on its own. */
  readonly symbol: "✕" | "✓" | "○" | "⟳" | "+";
  /** Everything after the symbol and its one space. */
  readonly text: string;
  readonly tone: WorkDigestTone;
}

export interface WorkDigest {
  /** Every line, in display order; the screen folds all but the first five. */
  readonly lines: ReadonlyArray<WorkDigestLine>;
  /** The header's span, from the server's own clock. */
  readonly span: string;
  /** Events the server could not send because its 60-event cap filled. */
  readonly omitted: number;
}

export interface WorkDigestView {
  readonly lines: ReadonlyArray<WorkDigestLine>;
  readonly moreLabel: string | null;
}

const ms = DateTime.toEpochMillis;

const byNewest = (left: PersonalWorkEvent, right: PersonalWorkEvent) =>
  ms(right.at) - ms(left.at) || eventId(left).localeCompare(eventId(right));

const eventId = (event: PersonalWorkEvent): string =>
  event.kind === "goalOpened" || event.kind === "goalClosed" ? event.projectId : event.task.taskId;

const ofKind = <K extends PersonalWorkEvent["kind"]>(
  events: ReadonlyArray<PersonalWorkEvent>,
  kind: K,
): ReadonlyArray<Extract<PersonalWorkEvent, { kind: K }>> =>
  events.filter((event): event is Extract<PersonalWorkEvent, { kind: K }> => event.kind === kind);

/**
 * The Work tab's digest, grouped so failures are never folded away and every
 * start shares one line. A last visit with nothing to report gives null: the
 * screen shows no box at all.
 */
export function buildWorkDigest(input: {
  readonly events: ReadonlyArray<PersonalWorkEvent>;
  readonly omitted: number;
  readonly seenAt: string;
  readonly asOf: string;
  readonly chatTitles: ReadonlyMap<string, string>;
  readonly botName: (botId: string) => string;
}): WorkDigest | null {
  if (input.events.length === 0) return null;

  const title = (task: WorkTaskRef) => taskDisplayTitle(task, input.chatTitles);
  const bot = (task: WorkTaskRef) => input.botName(task.botId);
  const lines: Array<WorkDigestLine> = [];

  for (const event of ofKind(input.events, "taskFailed").toSorted(byNewest)) {
    lines.push({
      key: `failed:${event.task.taskId}`,
      symbol: "✕",
      text: `${title(event.task)} ${event.status === "interrupted" ? "stopped" : "failed"} · ${bot(event.task)}`,
      tone: "failure",
    });
  }
  for (const event of ofKind(input.events, "goalClosed").toSorted(byNewest)) {
    const done = event.outcome === "done";
    lines.push({
      key: `closed:${event.projectId}`,
      symbol: done ? "✓" : "○",
      text: done ? `${event.name} is done` : `${event.name} dropped`,
      tone: done ? "done" : "dropped",
    });
  }
  for (const event of ofKind(input.events, "taskDone").toSorted(byNewest)) {
    lines.push({
      key: `done:${event.task.taskId}`,
      symbol: "✓",
      text: `${title(event.task)} · ${bot(event.task)}`,
      tone: "done",
    });
  }
  for (const event of ofKind(input.events, "taskRestarted").toSorted(byNewest)) {
    lines.push({
      key: `restarted:${event.task.taskId}`,
      symbol: "⟳",
      text: `${title(event.task)} restarted after a stall · ${bot(event.task)}`,
      tone: "restarted",
    });
  }
  for (const event of ofKind(input.events, "goalOpened").toSorted(byNewest)) {
    lines.push({
      key: `opened:${event.projectId}`,
      symbol: "+",
      text: `New goal · ${event.name}`,
      tone: "started",
    });
  }
  const started = ofKind(input.events, "taskStarted").toSorted(byNewest);
  if (started.length > 0) {
    const names = started.map((event) => title(event.task)).join(", ");
    lines.push({
      key: "started",
      symbol: "+",
      text:
        started.length === 1
          ? `1 task started · ${names}`
          : `${started.length} tasks started · ${names}`,
      tone: "started",
    });
  }

  return {
    lines,
    span: formatSpan(Date.parse(input.asOf) - Date.parse(input.seenAt)),
    omitted: input.omitted,
  };
}

/** The first five lines, with the fold label, or every line once expanded. */
export function workDigestView(digest: WorkDigest, expanded: boolean): WorkDigestView {
  if (!expanded && digest.lines.length > WORK_DIGEST_VISIBLE) {
    return {
      lines: digest.lines.slice(0, WORK_DIGEST_VISIBLE),
      moreLabel: `+${digest.lines.length - WORK_DIGEST_VISIBLE} more`,
    };
  }
  return { lines: digest.lines, moreLabel: null };
}
