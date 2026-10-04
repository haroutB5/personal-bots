// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics preferSchemaOverJson:off
// Replays every real reopen of a task in the live chats (read-only copy) as if a fresh session
// seeded with the work record had started it, and compares the context it would have carried with
// the one the resumed session did, and what the first reply after it refers to.
//
//   HBOTS_REOPEN_DB=<state.sqlite> HBOTS_REOPEN_OUT=<folder> \
//     vp test run src/personal/tasks/reopenFresh.measure.test.ts
//
// The database is opened read-only and nothing is written to it.
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

import type { PersonalTaskWorkRecord } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { buildChatHandoff } from "../sessionHandoff.ts";
import { FRESH_SESSION_NOTE } from "./PersonalTaskService.ts";
import {
  emptyWorkRecord,
  estimateTokens,
  evidenceFromText,
  recordAttemptEnd,
  recordSteer,
  renderWorkRecord,
  reopenFreshTokens,
} from "./workRecord.ts";

const LIVE_DB = process.env.HBOTS_REOPEN_DB;
const OUT_DIR = process.env.HBOTS_REOPEN_OUT;
const TAIL_CHARS = 6_000;

interface Message {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly at: string;
}

/** Identifiers a reply can refer back to: versions, hashes, paths, `code`, CONSTANTS. */
const identifiersOf = (text: string): ReadonlySet<string> => {
  const found = new Set<string>();
  for (const match of text.matchAll(/\b\d+\.\d+\.\d+\b/g)) found.add(match[0]);
  for (const match of text.matchAll(/\b[0-9a-f]{7,40}\b/g)) {
    if (/[a-f]/.test(match[0]) && /\d/.test(match[0])) found.add(match[0]);
  }
  for (const match of text.matchAll(/[A-Za-z]:[\\/][^\s)`'",;]{4,}/g)) found.add(match[0]);
  for (const match of text.matchAll(/`([^`\n]{3,60})`/g)) found.add(match[1]!);
  for (const match of text.matchAll(/\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+){1,}\b/g)) found.add(match[0]);
  return found;
};

const percentile = (values: ReadonlyArray<number>, share: number) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? 0;
};
const mean = (values: ReadonlyArray<number>) =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

describe.skipIf(LIVE_DB === undefined)("a fresh session on every real reopen", () => {
  it("measures the context saved and what the next reply needed", () => {
    const db = new NodeSqlite.DatabaseSync(LIVE_DB!, { readOnly: true });
    db.exec("PRAGMA query_only=1");
    const reopens = db
      .prepare(
        `SELECT n.task_id AS taskId, n.created_at AS at, t.thread_id AS threadId, t.title, t.objective
         FROM personal_task_resume_notes n JOIN personal_tasks t ON t.task_id = n.task_id
         WHERE n.note_id LIKE 'reopen:%' AND t.thread_id IS NOT NULL
         ORDER BY n.created_at`,
      )
      .all() as Array<{
      taskId: string;
      at: string;
      threadId: string;
      title: string;
      objective: string;
    }>;
    const messagesOf = db.prepare(
      `SELECT message_id AS id, role, text, created_at AS at FROM projection_thread_messages
       WHERE thread_id = ? AND role IN ('user','assistant') AND is_streaming = 0 ORDER BY created_at`,
    );
    const usedBefore = db.prepare(
      `SELECT json_extract(payload_json,'$.usedTokens') AS used FROM projection_thread_activities
       WHERE thread_id = ? AND kind = 'context-window.updated' AND created_at < ?
       ORDER BY created_at DESC LIMIT 1`,
    );
    const firstUsed = db.prepare(
      `SELECT json_extract(payload_json,'$.usedTokens') AS used FROM projection_thread_activities
       WHERE thread_id = ? AND kind = 'context-window.updated' ORDER BY created_at LIMIT 1`,
    );
    const toolsBetween = db.prepare(
      `SELECT COUNT(*) AS n FROM projection_thread_activities
       WHERE thread_id = ? AND kind = 'tool.started' AND created_at >= ? AND created_at < ?`,
    );
    const notesOf = db.prepare(
      `SELECT text, created_at AS at FROM personal_task_resume_notes
       WHERE task_id = ? AND note_id LIKE 'steer:%' AND created_at <= ? ORDER BY created_at`,
    );
    const cache = new Map<string, Array<Message>>();
    const threadMessages = (threadId: string) => {
      const cached = cache.get(threadId);
      if (cached !== undefined) return cached;
      const rows = messagesOf.all(threadId) as unknown as Array<Message>;
      cache.set(threadId, rows);
      return rows;
    };
    const threshold = reopenFreshTokens();
    const rows: Array<Record<string, unknown>> = [];
    for (const reopen of reopens) {
      const all = threadMessages(reopen.threadId);
      const before = all.filter((message) => message.at < reopen.at);
      const after = all.filter((message) => message.at >= reopen.at);
      const reply = after.find((message) => message.role === "assistant");
      if (before.length === 0 || reply === undefined) continue;
      const used = (
        usedBefore.get(reopen.threadId, reopen.at) as { used: number | null } | undefined
      )?.used;
      if (typeof used !== "number") continue;
      const base =
        (firstUsed.get(reopen.threadId) as { used: number | null } | undefined)?.used ?? 0;
      // The continuation turn: from the user-role message the reopen started to the next one.
      // A model step is a tool call plus the final answer (usage is reported once a turn, so its
      // updates cannot be counted as steps).
      const continuation = after.find((message) => message.role === "user");
      const turnEnd =
        after.find((message) => message.role === "user" && message.at > (continuation?.at ?? ""))
          ?.at ?? "9999";
      const tools = (
        toolsBetween.get(reopen.threadId, continuation?.at ?? reopen.at, turnEnd) as { n: number }
      ).n;
      const steps = tools + 1;
      // The record as it would have been at the reopen: its objective, the last reply as the
      // result, the evidence that names, and the updates it was steered with. (The bot's own
      // update_work_record calls did not exist yet, so decisions and outstanding work are empty.)
      const lastReply = [...before].reverse().find((message) => message.role === "assistant");
      const updates = (
        notesOf.all(reopen.taskId, reopen.at) as Array<{ text: string; at: string }>
      ).slice(-5);
      let record: PersonalTaskWorkRecord = emptyWorkRecord(reopen.objective, reopen.at);
      if (lastReply !== undefined) {
        record = recordAttemptEnd(
          record,
          { status: "completed", summary: lastReply.text, message: null },
          reopen.at,
        );
      }
      for (const update of updates) record = recordSteer(record, update.text, update.at);
      const seed = `${FRESH_SESSION_NOTE}\n\n${renderWorkRecord(record)}`;
      const tail =
        buildChatHandoff({
          messages: before.map((message) => ({
            id: message.id as never,
            role: message.role,
            text: message.text,
            attachments: [],
          })),
          maxChars: TAIL_CHARS,
        }) ?? "";
      const seedText = `${seed}\n\n${tail}\n\n${reopen.objective}\n\n${updates.map((u) => u.text).join("\n")}`;
      const earlier = before.map((message) => message.text).join("\n");
      const wanted = [...identifiersOf(reply.text)];
      let inSeed = 0;
      let lost = 0;
      for (const id of wanted) {
        if (seedText.includes(id)) inSeed += 1;
        else if (earlier.includes(id)) lost += 1;
      }
      const seedTokens = estimateTokens(seed) + estimateTokens(tail);
      const freshStart = base + seedTokens;
      rows.push({
        task: reopen.title.slice(0, 50),
        thread: reopen.threadId,
        at: reopen.at,
        contextBefore: used,
        startsFresh: threshold > 0 && used >= threshold,
        steps,
        base,
        seedTokens,
        freshStart,
        savedPerStep: Math.max(0, used - freshStart),
        chatMessages: before.length,
        chatChars: earlier.length,
        tailShare: Math.min(1, tail.length / Math.max(1, earlier.length)),
        wanted: wanted.length,
        inSeed,
        lost,
        recall: inSeed + lost === 0 ? null : inSeed / (inSeed + lost),
      });
    }
    db.close();

    const fresh = rows.filter((row) => row.startsFresh === true);
    const num = (key: string, subset = fresh) => subset.map((row) => row[key] as number);
    const recalls = fresh.flatMap((row) => (row.recall === null ? [] : [row.recall as number]));
    const withLoss = fresh.filter((row) => (row.lost as number) > 0);
    const summary = {
      threshold,
      reopens: rows.length,
      startFresh: fresh.length,
      resumeAsBefore: rows.length - fresh.length,
      contextBefore: {
        mean: Math.round(mean(num("contextBefore"))),
        median: percentile(num("contextBefore"), 0.5),
        p90: percentile(num("contextBefore"), 0.9),
      },
      freshStartTokens: {
        mean: Math.round(mean(num("freshStart"))),
        median: percentile(num("freshStart"), 0.5),
      },
      seedTokens: {
        mean: Math.round(mean(num("seedTokens"))),
        median: percentile(num("seedTokens"), 0.5),
        p90: percentile(num("seedTokens"), 0.9),
      },
      stepsPerReopen: {
        mean: Number(mean(num("steps")).toFixed(1)),
        median: percentile(num("steps"), 0.5),
      },
      savedPerStep: {
        mean: Math.round(mean(num("savedPerStep"))),
        median: percentile(num("savedPerStep"), 0.5),
      },
      inputTokensSavedTotal: Math.round(
        fresh.reduce(
          (total, row) => total + (row.savedPerStep as number) * (row.steps as number),
          0,
        ),
      ),
      inputTokensResumedTotal: Math.round(
        fresh.reduce(
          (total, row) => total + (row.contextBefore as number) * (row.steps as number),
          0,
        ),
      ),
      quality: {
        reopensWithAReply: recalls.length,
        recallMean: Number(mean(recalls).toFixed(3)),
        recallMedian: percentile(recalls, 0.5),
        recallP10: percentile(recalls, 0.1),
        reopensWithAnyLostReference: withLoss.length,
        lostReferencesTotal: fresh.reduce((total, row) => total + (row.lost as number), 0),
        referencesTotal: fresh.reduce((total, row) => total + (row.wanted as number), 0),
      },
    };
    if (OUT_DIR !== undefined) {
      NodeFS.writeFileSync(`${OUT_DIR}/reopen-rows.json`, JSON.stringify(rows, null, 1));
      NodeFS.writeFileSync(`${OUT_DIR}/reopen-summary.json`, JSON.stringify(summary, null, 2));
    }
    expect(rows.length).toBeGreaterThan(0);
  }, 300_000);
});
