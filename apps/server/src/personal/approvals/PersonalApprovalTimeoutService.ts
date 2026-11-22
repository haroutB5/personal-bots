import { CommandId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { withStallJob } from "../../observability/stallJobs.ts";
import { forkParked } from "../../serverActivation.ts";
import {
  dueApprovalDeclines,
  PENDING_PERSONAL_APPROVALS_SQL,
  PERSONAL_APPROVAL_TIMEOUT_SWEEP_MS,
  personalApprovalTimeoutMs,
  type PersonalApprovalRequestRow,
} from "./approvalTimeoutPolicy.ts";

/**
 * Declines a personal bot's approval request nobody answered within the
 * timeout (2 minutes by default), with feedback telling the bot how to retry,
 * so a bot never sits on a card nobody sees. Policy and env switches:
 * `approvalTimeoutPolicy.ts`.
 */
export class PersonalApprovalTimeout extends Context.Service<
  PersonalApprovalTimeout,
  {
    /** Starts the sweep loop (now, then every 10 s). Park-aware. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** One sweep. Returns how many requests it declined. */
    readonly sweep: Effect.Effect<number>;
  }
>()("t3/personal/approvals/PersonalApprovalTimeoutService/PersonalApprovalTimeout") {}

interface PendingRow {
  readonly requestId: string;
  readonly threadId: string;
  readonly status: string;
  readonly createdAt: string;
  readonly supportsFeedback: number | boolean;
}

export const make = (options?: { readonly env?: NodeJS.ProcessEnv }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const lock = yield* Semaphore.make(1);
    // Each request is declined once; ids leave the set when they stop being pending.
    const declined = new Set<string>();

    const sweepOnce = Effect.gen(function* () {
      const timeoutMs = personalApprovalTimeoutMs(options?.env ?? process.env);
      if (timeoutMs <= 0) return 0;
      const raw = yield* sql.unsafe<PendingRow>(PENDING_PERSONAL_APPROVALS_SQL);
      const rows: PersonalApprovalRequestRow[] = raw.map((row) => ({
        requestId: row.requestId,
        threadId: row.threadId,
        status: row.status,
        createdAt: row.createdAt,
        supportsFeedback: row.supportsFeedback === 1 || row.supportsFeedback === true,
      }));
      const pendingIds = new Set(rows.map((row) => row.requestId));
      for (const id of declined) if (!pendingIds.has(id)) declined.delete(id);
      const nowMs = yield* Clock.currentTimeMillis;
      const due = dueApprovalDeclines({ rows, nowMs, timeoutMs, alreadyDeclined: declined });
      let count = 0;
      for (const decline of due) {
        declined.add(decline.requestId);
        const sent = yield* threads
          .dispatch({
            type: "runtime-request.respond",
            threadId: ThreadId.make(decline.threadId),
            commandId: CommandId.make(`approval-timeout:${decline.requestId}`),
            requestId: RuntimeRequestId.make(decline.requestId),
            decision: "decline",
            ...(decline.feedback === undefined ? {} : { feedback: decline.feedback }),
          })
          .pipe(
            Effect.as(true),
            // Answered or withdrawn between the read and the dispatch: nothing to do.
            Effect.catchCause((cause) =>
              Effect.logInfo("personal approval timeout: decline not delivered", {
                requestId: decline.requestId,
                threadId: decline.threadId,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as(false)),
            ),
          );
        if (sent) {
          count += 1;
          yield* Effect.logWarning("personal approval timed out and was declined", {
            requestId: decline.requestId,
            threadId: decline.threadId,
            timeoutMs,
          });
        }
      }
      return count;
    });

    const sweep = lock
      .withPermits(1)(sweepOnce)
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("personal approval timeout sweep failed", {
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(0)),
        ),
      );

    const start = Effect.fn("PersonalApprovalTimeout.start")(function* () {
      yield* forkParked(
        sweep.pipe(
          withStallJob("job:approval-timeout-sweep"),
          Effect.repeat(Schedule.spaced(PERSONAL_APPROVAL_TIMEOUT_SWEEP_MS)),
          Effect.asVoid,
        ),
      );
    });

    return PersonalApprovalTimeout.of({ start, sweep });
  });

export const layer = Layer.effect(PersonalApprovalTimeout, make());
