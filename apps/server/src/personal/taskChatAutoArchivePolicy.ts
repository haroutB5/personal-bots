/**
 * Which finished delegated-task and routine-run chats archive themselves, and when. Pure (no
 * Effect, no clock), so every rule is testable alone and the read-only dry
 * run against a copy of the live database (qa script) imports the very same
 * SQL and decision. The service (`PersonalTaskChatArchiveService`) applies it.
 */

/**
 * A finished task chat archives once it has been idle and unopened this long:
 * 48 hours (Harout, 2 Oct; it was 30 minutes).
 */
export const TASK_CHAT_AUTO_ARCHIVE_IDLE_MS = 48 * 60 * 60_000;
/**
 * An unopened routine report stays visible this long from chat creation. Same
 * 48 hours, so an unread report never goes sooner than a read one.
 */
export const ROUTINE_CHAT_AUTO_ARCHIVE_UNREAD_MS = 48 * 60 * 60_000;
/** How often the sweep looks. It also runs once at startup. */
export const TASK_CHAT_AUTO_ARCHIVE_SWEEP_MS = 5 * 60_000;
/**
 * A chat's "last opened" time is written at most this often while it stays
 * open (the page reports every 10 s). Far below the idle time, so the clock
 * restarts in time.
 */
export const TASK_CHAT_VIEWED_WRITE_INTERVAL_MS = 60_000;
/** `personal_meta` key of the Settings toggle. Absent = on. */
export const TASK_CHAT_AUTO_ARCHIVE_META_KEY = "taskChatAutoArchive";

/**
 * Statuses a task never leaves on its own. Interrupted counts as finished: a
 * restart or a stop leaves it waiting for a retry nobody may ever ask for, and
 * a retry is a new turn, which unarchives the chat (unarchiveForTurn).
 */
export const TASK_TERMINAL_STATUSES = ["completed", "failed", "interrupted", "cancelled"] as const;
const TERMINAL_SQL_LIST = TASK_TERMINAL_STATUSES.map((status) => `'${status}'`).join(", ");

/**
 * Whether a chat still has unfinished work: one of its tasks, or a child task
 * one of them delegated, is open. Re-read for each candidate right before it
 * is archived, since a task can be reopened after the candidate list was read.
 */
export const TASK_CHAT_OPEN_WORK_SQL = `
  SELECT
    EXISTS (
      SELECT 1 FROM personal_tasks o
      WHERE o.thread_id = ?
        AND o.status NOT IN (${TERMINAL_SQL_LIST})
    )
    OR EXISTS (
      SELECT 1 FROM personal_tasks c
      JOIN personal_tasks parent ON parent.task_id = c.parent_task_id
      WHERE parent.thread_id = ?
        AND c.status NOT IN (${TERMINAL_SQL_LIST})
    ) AS "open"
`;

/**
 * Candidate chats: a chat created for a delegated task or routine run (the
 * thread came after the task), every task on it finished, none of its child tasks still
 * open, and it is not archived (now or ever by this sweep), pinned, a
 * routine's chat, a group member's thread or a deleted bot's chat. A chat
 * holding a user task is never eligible. Delegated-task behaviour stays the
 * same. Relay runs always create their own chat, but record the task after
 * posting its deterministic personal-relay message. These existing markers
 * also identify runs of deleted one-off routines, without a migration.
 *
 * Idle and liveness are decided per row by `decideTaskChatArchive`.
 */
export const TASK_CHAT_AUTO_ARCHIVE_CANDIDATES_SQL = `
  SELECT
    bt.thread_id AS "threadId",
    bt.bot_id AS "botId",
    b.name AS "botName",
    p.title AS "title",
    bt.created_at AS "createdAt",
    CASE WHEN EXISTS (
      SELECT 1 FROM personal_tasks r
      WHERE r.thread_id = bt.thread_id AND r.source = 'routine'
    ) THEN 'routine' ELSE 'delegation' END AS "chatKind",
    (
      SELECT max(COALESCE(o.completed_at, o.updated_at))
      FROM personal_tasks o
      WHERE o.thread_id = bt.thread_id
    ) AS "taskEndedAt",
    (
      SELECT max(m.created_at)
      FROM projection_thread_messages m
      WHERE m.thread_id = bt.thread_id
    ) AS "lastMessageAt",
    (
      SELECT max(m.created_at)
      FROM projection_thread_messages m
      WHERE m.thread_id = bt.thread_id
        AND m.role = 'user'
        AND m.message_id NOT LIKE 'personal-%'
    ) AS "lastOwnerMessageAt",
    bt.last_viewed_at AS "lastViewedAt",
    s.status AS "sessionStatus",
    s.active_turn_id AS "activeTurnId",
    p.pending_approval_count + p.pending_user_input_count AS "pendingRequests"
  FROM personal_bot_threads bt
  JOIN personal_bots b ON b.bot_id = bt.bot_id
  JOIN projection_threads p ON p.thread_id = bt.thread_id
  LEFT JOIN projection_thread_sessions s ON s.thread_id = bt.thread_id
  WHERE bt.archived_at IS NULL
    AND bt.auto_archived_at IS NULL
    AND b.deleted_at IS NULL
    AND p.archived_at IS NULL
    AND p.deleted_at IS NULL
    AND p.pinned_at IS NULL
    AND (p.settled_override IS NULL OR p.settled_override <> 'active')
    AND EXISTS (
      SELECT 1 FROM personal_tasks d
      WHERE d.thread_id = bt.thread_id
        AND (
          (d.source = 'delegation' AND d.created_at <= bt.created_at AND NOT EXISTS (
            SELECT 1 FROM personal_tasks other
            WHERE other.thread_id = bt.thread_id AND other.source <> 'delegation'
          ))
          OR (d.source = 'routine' AND d.created_at <= bt.created_at)
          OR (d.source = 'routine' AND EXISTS (
            SELECT 1 FROM projection_thread_messages relay
            WHERE relay.thread_id = bt.thread_id
              AND relay.role = 'assistant' AND relay.message_id LIKE 'personal-relay-%'
          ))
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM personal_tasks o
      WHERE o.thread_id = bt.thread_id
        AND (o.source NOT IN ('delegation', 'routine') OR o.status NOT IN (${TERMINAL_SQL_LIST}))
    )
    AND NOT EXISTS (
      SELECT 1 FROM personal_tasks c
      JOIN personal_tasks parent ON parent.task_id = c.parent_task_id
      WHERE parent.thread_id = bt.thread_id
        AND c.status NOT IN (${TERMINAL_SQL_LIST})
    )
    AND NOT EXISTS (SELECT 1 FROM personal_routines r WHERE r.thread_id = bt.thread_id)
    AND NOT EXISTS (SELECT 1 FROM personal_group_members gm WHERE gm.thread_id = bt.thread_id)
  ORDER BY bt.created_at ASC, bt.thread_id ASC
`;

/**
 * Archived bot chats that are working anyway: a turn started after the chat
 * was archived and is still running. A reopened or steered task, a routine
 * run and the owner's own message all start a turn, and the turn-start
 * listener unarchives the chat then; this catches one it missed (a turn that
 * began before this release, or while the listener was down). A turn older
 * than the archive is the one the archive is stopping, so it never counts.
 * Group relays stay hidden either way.
 */
export const ARCHIVED_BUSY_CHATS_SQL = `
  SELECT bt.thread_id AS "threadId"
  FROM personal_bot_threads bt
  JOIN projection_thread_sessions s ON s.thread_id = bt.thread_id
  JOIN projection_turns t ON t.thread_id = s.thread_id AND t.turn_id = s.active_turn_id
  WHERE bt.archived_at IS NOT NULL
    AND s.status IN ('running', 'starting')
    AND t.requested_at > bt.archived_at
    AND NOT EXISTS (SELECT 1 FROM personal_group_members gm WHERE gm.thread_id = bt.thread_id)
  ORDER BY bt.thread_id ASC
`;

/** One row of `TASK_CHAT_AUTO_ARCHIVE_CANDIDATES_SQL`. */
export interface TaskChatArchiveCandidate {
  readonly threadId: string;
  readonly botId: string;
  readonly botName: string;
  readonly title: string;
  readonly createdAt: string;
  readonly chatKind: "delegation" | "routine";
  readonly taskEndedAt: string | null;
  readonly lastMessageAt: string | null;
  readonly lastOwnerMessageAt: string | null;
  readonly lastViewedAt: string | null;
  readonly sessionStatus: string | null;
  readonly activeTurnId: string | null;
  readonly pendingRequests: number;
}

/** What the live projection adds at sweep time (the dry run has no live server). */
export interface TaskChatLiveState {
  /** The session has background work (a command, a subagent) still running. */
  readonly backgroundWork: boolean;
  /** Completion of the chat's latest turn, when known. */
  readonly latestTurnCompletedAt: string | null;
}

export type TaskChatArchiveDecision =
  | { readonly kind: "archive"; readonly idleSinceMs: number }
  | {
      readonly kind: "keep";
      readonly reason: "live_turn" | "background_work" | "pending_request" | "recent";
      /** When it becomes due, for `recent`. */
      readonly dueAtMs?: number;
    };

const parseMs = (value: string | null | undefined): number | null => {
  if (value == null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

/**
 * The idle clock starts at the latest of: the task finishing, the chat's last
 * message (the bot's or Harout's) and Harout last having it open. Opening or
 * writing in it restarts the clock.
 */
export function taskChatIdleSinceMs(
  candidate: Pick<TaskChatArchiveCandidate, "taskEndedAt" | "lastMessageAt" | "lastViewedAt">,
  live?: Pick<TaskChatLiveState, "latestTurnCompletedAt">,
): number | null {
  const times = [
    candidate.taskEndedAt,
    candidate.lastMessageAt,
    candidate.lastViewedAt,
    live?.latestTurnCompletedAt ?? null,
  ]
    .map(parseMs)
    .filter((ms): ms is number => ms !== null);
  return times.length === 0 ? null : Math.max(...times);
}

export function decideTaskChatArchive(
  candidate: TaskChatArchiveCandidate,
  nowMs: number,
  live?: TaskChatLiveState,
): TaskChatArchiveDecision {
  if (
    candidate.sessionStatus === "running" ||
    candidate.sessionStatus === "starting" ||
    candidate.activeTurnId !== null
  ) {
    return { kind: "keep", reason: "live_turn" };
  }
  if (live?.backgroundWork === true) return { kind: "keep", reason: "background_work" };
  if (candidate.pendingRequests > 0) return { kind: "keep", reason: "pending_request" };
  // Owner messages are also proof the report has been read, even if the
  // viewed heartbeat did not arrive. Opened chats keep the ordinary idle clock.
  if (
    candidate.chatKind === "routine" &&
    parseMs(candidate.lastViewedAt) === null &&
    parseMs(candidate.lastOwnerMessageAt) === null
  ) {
    const createdMs = parseMs(candidate.createdAt);
    if (createdMs === null) return { kind: "keep", reason: "recent" };
    const dueAtMs = createdMs + ROUTINE_CHAT_AUTO_ARCHIVE_UNREAD_MS;
    return nowMs < dueAtMs
      ? { kind: "keep", reason: "recent", dueAtMs }
      : { kind: "archive", idleSinceMs: createdMs };
  }
  const idleSinceMs = taskChatIdleSinceMs(candidate, live);
  // Every finished task has an updated_at, so this only guards bad data.
  if (idleSinceMs === null) return { kind: "keep", reason: "recent" };
  const dueAtMs = idleSinceMs + TASK_CHAT_AUTO_ARCHIVE_IDLE_MS;
  if (nowMs < dueAtMs) return { kind: "keep", reason: "recent", dueAtMs };
  return { kind: "archive", idleSinceMs };
}

/** The Settings toggle as stored: anything but "off" (or no row) is on. */
export const taskChatAutoArchiveEnabled = (stored: string | null | undefined): boolean =>
  stored !== "off";
