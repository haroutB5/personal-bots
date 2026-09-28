import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  formatResumeTime,
  limitWord,
  providerLabel,
  type LimitHitDecision,
} from "../personalChatResumePolicy.ts";

/**
 * Group rounds cut off by a provider usage limit, carried on after the reset
 * (the group counterpart of `PersonalChatResumeService`). This file is the
 * table and the wording; `PersonalGroupService` decides what a hit means for a
 * round and runs the resume inside its own sweep, under its own lock.
 */

/** A due resume whose round is still busy waits at most this long, then is dropped. */
export const GROUP_LIMIT_RESUME_BUSY_WAIT_MS = 30 * 60_000;

export type GroupLimitResumeKind = "members" | "verdict";

export interface GroupLimitResumeRow {
  readonly resumeId: string;
  readonly groupId: string;
  readonly roundId: string;
  readonly kind: GroupLimitResumeKind;
  readonly botIds: ReadonlyArray<string>;
  readonly provider: string;
  readonly hitAt: string;
  readonly resumeAt: string;
}

interface StoredRow {
  readonly resumeId: string;
  readonly groupId: string;
  readonly roundId: string;
  readonly kind: GroupLimitResumeKind;
  readonly botIdsJson: string;
  readonly provider: string;
  readonly hitAt: string;
  readonly resumeAt: string;
}

const parseBotIds = (json: string): ReadonlyArray<string> => {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
};

const toRow = (row: StoredRow): GroupLimitResumeRow => ({
  resumeId: row.resumeId,
  groupId: row.groupId,
  roundId: row.roundId,
  kind: row.kind,
  botIds: parseBotIds(row.botIdsJson),
  provider: row.provider,
  hitAt: row.hitAt,
  resumeAt: row.resumeAt,
});

export const makeGroupLimitResumeStore = (sql: SqlClient.SqlClient) => {
  /**
   * Records a hit. Members cut off in the same round before its reset share one
   * scheduled row: their names join the list and the later reset wins.
   */
  const schedule = (input: {
    readonly resumeId: string;
    readonly groupId: string;
    readonly roundId: string;
    readonly kind: GroupLimitResumeKind;
    readonly botId: string;
    readonly provider: string;
    readonly reason: string | null;
    readonly hitAt: string;
    readonly resumeAt: string;
  }) =>
    Effect.gen(function* () {
      const existing = yield* sql<{
        readonly resumeId: string;
        readonly botIdsJson: string;
        readonly resumeAt: string;
      }>`
        SELECT resume_id AS "resumeId", bot_ids_json AS "botIdsJson", resume_at AS "resumeAt"
        FROM personal_group_limit_resumes
        WHERE round_id = ${input.roundId} AND kind = ${input.kind} AND status = 'scheduled'
      `;
      const row = existing[0];
      if (row === undefined) {
        yield* sql`
          INSERT INTO personal_group_limit_resumes (
            resume_id, group_id, round_id, kind, bot_ids_json, provider, limit_reason,
            hit_at, resume_at, status
          )
          VALUES (
            ${input.resumeId}, ${input.groupId}, ${input.roundId}, ${input.kind},
            ${JSON.stringify([input.botId])}, ${input.provider}, ${input.reason},
            ${input.hitAt}, ${input.resumeAt}, 'scheduled'
          )
        `;
        return input.resumeAt;
      }
      const botIds = parseBotIds(row.botIdsJson);
      const merged = botIds.includes(input.botId) ? botIds : [...botIds, input.botId];
      const resumeAt = row.resumeAt > input.resumeAt ? row.resumeAt : input.resumeAt;
      yield* sql`
        UPDATE personal_group_limit_resumes
        SET bot_ids_json = ${JSON.stringify(merged)}, resume_at = ${resumeAt}
        WHERE resume_id = ${row.resumeId} AND status = 'scheduled'
      `;
      return resumeAt;
    });

  const listDue = (nowIso: string) =>
    sql<StoredRow>`
      SELECT resume_id AS "resumeId", group_id AS "groupId", round_id AS "roundId", kind,
             bot_ids_json AS "botIdsJson", provider, hit_at AS "hitAt", resume_at AS "resumeAt"
      FROM personal_group_limit_resumes
      WHERE status = 'scheduled' AND resume_at <= ${nowIso}
      ORDER BY resume_at, hit_at
    `.pipe(Effect.map((rows) => rows.map(toRow)));

  /**
   * Moves a scheduled row to its final status. True only for the caller that
   * moved it, so a hit resumes once however often the sweep looks at it.
   */
  const resolve = (
    resumeId: string,
    status: "resumed" | "skipped",
    outcome: string | null,
    nowIso: string,
  ) =>
    sql<{ readonly resumeId: string }>`
      UPDATE personal_group_limit_resumes
      SET status = ${status}, outcome = ${outcome}, resolved_at = ${nowIso}
      WHERE resume_id = ${resumeId} AND status = 'scheduled'
      RETURNING resume_id AS "resumeId"
    `.pipe(Effect.map((rows) => rows.length > 0));

  /** Automatic continues in a group since its owner last wrote. */
  const countResumedSince = (groupId: string, sinceIso: string) =>
    sql<{ readonly n: number }>`
      SELECT count(*) AS n FROM personal_group_limit_resumes
      WHERE group_id = ${groupId} AND status = 'resumed' AND resolved_at > ${sinceIso}
    `.pipe(Effect.map((rows) => Number(rows[0]?.n ?? 0)));

  /** When the owner last wrote in the group; empty string when never. */
  const latestOwnerMessageAt = (groupId: string) =>
    sql<{ readonly createdAt: string | null }>`
      SELECT MAX(created_at) AS "createdAt" FROM personal_group_messages
      WHERE group_id = ${groupId} AND speaker_kind = 'user'
    `.pipe(Effect.map((rows) => rows[0]?.createdAt ?? ""));

  return { schedule, listDue, resolve, countResumedSince, latestOwnerMessageAt };
};

export type GroupLimitResumeStore = ReturnType<typeof makeGroupLimitResumeStore>;

const joinNames = (names: ReadonlyArray<string>): string =>
  names.length <= 1
    ? (names[0] ?? "The group")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/** The "Paused" row of a group: who is cut off, and when they continue. */
export function groupPausedText(input: {
  readonly provider: string | null | undefined;
  readonly reason: string | undefined;
  readonly names: ReadonlyArray<string>;
  readonly decision: LimitHitDecision;
  readonly nowMs: number;
}): string {
  const head = `Paused: ${providerLabel(input.provider)} ${limitWord(input.reason)}.`;
  const who = joinNames(input.names);
  if (input.decision.kind === "schedule") {
    const verb = input.names.length > 1 ? "continue" : "continues";
    return `${head} ${who} ${verb} at ${formatResumeTime(input.decision.resumeAtMs, input.nowMs)}.`;
  }
  return `${head} ${who} already continued on its own, so send a message to continue.`;
}

export const GROUP_RESUMED_NOTICE_TEXT = "Auto-continue after usage reset";
