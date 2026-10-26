/**
 * Text previews: a thread read the client opted into (`textPreviews`) sends
 * finished reasoning and long tool commands as a preview. In the 10-turn
 * window of the biggest chats on the 1.66.97 data those two are most of the
 * bytes: reasoning 126 KB and 350 KB, full heredoc commands 257 KB. The Bots
 * app never shows reasoning and shows each tool step as one line; the classic
 * timeline shows them only when a row is expanded, and then fetches the rest
 * through `personalBots.threadFullText`.
 *
 * Untouched: anything of a turn that is still running (the live progress note
 * reads its latest reasoning, and streaming deltas append to the text), and
 * any message still streaming. Live events always carry the whole text.
 *
 * Kill switch: PB_PERF_OFF=text-previews sends whole text again (perfFlags.ts).
 * The client side has its own switch of the same name.
 */
import type {
  OrchestrationMessage,
  OrchestrationThreadActivity,
  OrchestrationThreadDetailSnapshot,
  PersonalThreadFullTextInput,
  PersonalThreadFullTextResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { projectActivityPayload } from "../orchestration/ActivityPayloadProjection.ts";
import { serverPerfOptimizationOn } from "./perfFlags.ts";

export const REASONING_PREVIEW_CHARS = 400;
export const COMMAND_PREVIEW_CHARS = 1_000;

/** `text` cut to `max` UTF-16 units without splitting a surrogate pair. */
export function previewText(text: string, max: number): string {
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  // Copy, so the preview never keeps the whole string alive behind a slice.
  return `${text.slice(0, end)}…`.split("").join("");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function runningTurnId(snapshot: OrchestrationThreadDetailSnapshot): string | null {
  const thread = snapshot.thread;
  if (thread.latestTurn?.state === "running") return thread.latestTurn.turnId;
  const session = thread.session;
  if ((session?.status === "running" || session?.status === "starting") && session.activeTurnId) {
    return session.activeTurnId;
  }
  return null;
}

function previewMessage(message: OrchestrationMessage, running: string | null) {
  if (
    message.role !== "reasoning" ||
    message.streaming ||
    (running !== null && message.turnId === running) ||
    message.text.length <= REASONING_PREVIEW_CHARS
  ) {
    return message;
  }
  return {
    ...message,
    text: previewText(message.text, REASONING_PREVIEW_CHARS),
    textTruncated: true,
  };
}

/** `record` with a long string `key` cut to a preview, or null when nothing changes. */
function previewCommandField(
  record: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null {
  const value = record?.[key];
  if (typeof value !== "string" || value.length <= COMMAND_PREVIEW_CHARS) return null;
  return { ...record, [key]: previewText(value, COMMAND_PREVIEW_CHARS) };
}

function previewActivity(
  activity: OrchestrationThreadActivity,
  running: string | null,
): OrchestrationThreadActivity {
  if (running !== null && activity.turnId === running) return activity;
  const payload = asRecord(activity.payload);
  const data = asRecord(payload?.data);
  if (!payload || !data) return activity;

  let next: Record<string, unknown> = data;
  let changed = false;
  const command = previewCommandField(next, "command");
  if (command) {
    next = command;
    changed = true;
  }
  const item = asRecord(next.item);
  if (item) {
    let nextItem: Record<string, unknown> = item;
    const itemCommand = previewCommandField(nextItem, "command");
    if (itemCommand) nextItem = itemCommand;
    for (const nested of ["input", "result"] as const) {
      const cut = previewCommandField(asRecord(nextItem[nested]), "command");
      if (cut) nextItem = { ...nextItem, [nested]: cut };
    }
    if (nextItem !== item) {
      next = { ...next, item: nextItem };
      changed = true;
    }
  }
  if (!changed) return activity;
  return {
    ...activity,
    payload: { ...payload, data: { ...next, commandTruncated: true } },
  };
}

/** `snapshot` with previews in place of finished long text (see the file comment). */
export function applyThreadTextPreviews(
  snapshot: OrchestrationThreadDetailSnapshot,
): OrchestrationThreadDetailSnapshot {
  const running = runningTurnId(snapshot);
  let messagesChanged = false;
  const messages = snapshot.thread.messages.map((message) => {
    const next = previewMessage(message, running);
    if (next !== message) messagesChanged = true;
    return next;
  });
  let activitiesChanged = false;
  const activities = snapshot.thread.activities.map((activity) => {
    const next = previewActivity(activity, running);
    if (next !== activity) activitiesChanged = true;
    return next;
  });
  if (!messagesChanged && !activitiesChanged) return snapshot;
  return {
    ...snapshot,
    thread: {
      ...snapshot.thread,
      ...(messagesChanged ? { messages } : {}),
      ...(activitiesChanged ? { activities } : {}),
    },
  };
}

/** Applies previews when the client asked for them and the switch is on. */
export function maybeApplyThreadTextPreviews(
  snapshot: OrchestrationThreadDetailSnapshot,
  requested: boolean,
): OrchestrationThreadDetailSnapshot {
  return requested && serverPerfOptimizationOn("text-previews")
    ? applyThreadTextPreviews(snapshot)
    : snapshot;
}

/** The whole text behind the previews `input` names, from the projection tables. */
export const readThreadFullText = (input: PersonalThreadFullTextInput) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const messageIds = input.messageIds ?? [];
    const activityIds = input.activityIds ?? [];
    const messages =
      messageIds.length === 0
        ? []
        : yield* sql<{ readonly messageId: string; readonly text: string }>`
            SELECT message_id AS "messageId", text
            FROM projection_thread_messages
            WHERE thread_id = ${input.threadId} AND ${sql.in("message_id", messageIds)}
          `;
    const activityRows =
      activityIds.length === 0
        ? []
        : yield* sql<{
            readonly activityId: string;
            readonly kind: string;
            readonly payloadJson: string;
          }>`
            SELECT activity_id AS "activityId", kind, payload_json AS "payloadJson"
            FROM projection_thread_activities
            WHERE thread_id = ${input.threadId} AND ${sql.in("activity_id", activityIds)}
          `;
    const activities = activityRows.flatMap((row) => {
      let payload: unknown;
      try {
        payload = JSON.parse(row.payloadJson);
      } catch {
        return [];
      }
      const projected = projectActivityPayload({
        id: row.activityId,
        kind: row.kind,
        payload,
      } as unknown as OrchestrationThreadActivity);
      return [{ activityId: row.activityId, payload: projected.payload }];
    });
    return {
      messages: messages.map((row) => ({ messageId: row.messageId, text: row.text })),
      activities,
    } as unknown as PersonalThreadFullTextResult;
  });
