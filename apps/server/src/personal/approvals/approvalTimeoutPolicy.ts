/**
 * Which personal-bot approval requests to decline because nobody answered
 * them in time, and what the bot is told. The service
 * (`PersonalApprovalTimeoutService.ts`) runs the query and dispatches.
 *
 * Why: under bypassPermissions the Claude Code CLI still forwards some Bash
 * calls as approval requests (its bypass-immune safety checks, such as a
 * command it cannot parse well enough to rule out a dangerous removal). A bot
 * then waits on a card until someone answers; on 22 Nov one waited 57 minutes.
 * After the timeout the request is declined with feedback that tells the bot
 * how to retry so the check does not fire again.
 */

/** Default wait before an unanswered approval is declined: 2 minutes. */
export const PERSONAL_APPROVAL_TIMEOUT_DEFAULT_MS = 2 * 60_000;

/** How often the sweep looks for overdue requests. */
export const PERSONAL_APPROVAL_TIMEOUT_SWEEP_MS = 10_000;

const OFF_VALUES = ["off", "0", "false", "no", "disabled"];

/**
 * The wait in ms, or 0 when the auto-decline is off.
 *
 * - `T3CODE_PERSONAL_APPROVAL_TIMEOUT=off` (0/false/no/disabled) is the kill
 *   switch: requests wait for a person as before.
 * - `T3CODE_PERSONAL_APPROVAL_TIMEOUT_MS` (the `PERSONAL_` spelling works too)
 *   takes a positive whole number of milliseconds; `off` / `0` also disable.
 *   Anything else falls back to the default. Read on every sweep.
 */
export const personalApprovalTimeoutMs = (env: NodeJS.ProcessEnv = process.env): number => {
  const killSwitch = (env.T3CODE_PERSONAL_APPROVAL_TIMEOUT ?? env.PERSONAL_APPROVAL_TIMEOUT)
    ?.trim()
    .toLowerCase();
  if (killSwitch !== undefined && OFF_VALUES.includes(killSwitch)) return 0;
  const raw = (env.T3CODE_PERSONAL_APPROVAL_TIMEOUT_MS ?? env.PERSONAL_APPROVAL_TIMEOUT_MS)
    ?.trim()
    .toLowerCase();
  if (raw === undefined || raw.length === 0) return PERSONAL_APPROVAL_TIMEOUT_DEFAULT_MS;
  if (OFF_VALUES.includes(raw)) return 0;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : PERSONAL_APPROVAL_TIMEOUT_DEFAULT_MS;
};

/** "2 minutes", "1 minute", "90 seconds". */
export const describeApprovalTimeout = (timeoutMs: number): string => {
  if (timeoutMs >= 60_000 && timeoutMs % 60_000 === 0) {
    const minutes = timeoutMs / 60_000;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
};

/** What the bot reads as the decline reason. */
export const approvalTimeoutFeedback = (timeoutMs: number): string =>
  `No one answered this approval within ${describeApprovalTimeout(timeoutMs)}. Retry as a simpler command: one plain command, no $VAR as the command name, no loops or chained steps; or write the steps to a script file and run bash <file>.`;

/** One approval request on a personal-bot chat, as the sweep query reads it. */
export interface PersonalApprovalRequestRow {
  readonly requestId: string;
  readonly threadId: string;
  readonly status: string;
  /** ISO time the request was opened. */
  readonly createdAt: string;
  /** The request is answered live and the provider takes a decline reason. */
  readonly supportsFeedback: boolean;
}

export interface ApprovalTimeoutDecline {
  readonly requestId: string;
  readonly threadId: string;
  /** Absent when the request cannot carry feedback; it is still declined. */
  readonly feedback?: string;
}

/**
 * The requests to decline now: still pending, opened at least `timeoutMs`
 * ago, and not declined by this server already. A request answered,
 * cancelled or timed out by the provider is no longer pending and is left
 * alone. `timeoutMs <= 0` declines nothing.
 */
export const dueApprovalDeclines = (input: {
  readonly rows: ReadonlyArray<PersonalApprovalRequestRow>;
  readonly nowMs: number;
  readonly timeoutMs: number;
  readonly alreadyDeclined: ReadonlySet<string>;
}): ReadonlyArray<ApprovalTimeoutDecline> => {
  if (input.timeoutMs <= 0) return [];
  const feedback = approvalTimeoutFeedback(input.timeoutMs);
  const due: ApprovalTimeoutDecline[] = [];
  for (const row of input.rows) {
    if (row.status !== "pending") continue;
    if (input.alreadyDeclined.has(row.requestId)) continue;
    const createdMs = Date.parse(row.createdAt);
    if (!Number.isFinite(createdMs)) continue;
    if (input.nowMs - createdMs < input.timeoutMs) continue;
    due.push({
      requestId: row.requestId,
      threadId: row.threadId,
      ...(row.supportsFeedback ? { feedback } : {}),
    });
  }
  return due;
};

/**
 * Pending approval requests (not questions, auth refreshes or dynamic tool
 * calls) on chats linked to a personal bot, answerable live.
 */
export const PENDING_PERSONAL_APPROVALS_SQL = `
  SELECT q.runtime_request_id AS "requestId",
    q.thread_id AS "threadId",
    q.status AS "status",
    q.created_at AS "createdAt",
    CASE WHEN json_extract(q.payload_json, '$.responseCapability.supportsFeedback') = 1
      THEN 1 ELSE 0 END AS "supportsFeedback"
  FROM orchestration_v2_projection_runtime_requests q
  JOIN personal_bot_threads l ON l.thread_id = q.thread_id
  WHERE q.status = 'pending'
    AND q.kind NOT IN ('user_input', 'auth_refresh', 'dynamic_tool_call')
    AND json_extract(q.payload_json, '$.responseCapability.type') = 'live'
  ORDER BY q.created_at
`;
