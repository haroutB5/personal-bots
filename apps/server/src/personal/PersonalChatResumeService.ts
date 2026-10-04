import {
  CommandId,
  ComposerContextId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationMessageContext,
  type OrchestrationSession,
  PERSONAL_CHAT_NOTICE_CONTEXT_KIND,
  type PersonalChatNoticeMarker,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../serverActivation.ts";
import * as PersonalBotRepository from "./PersonalBotRepository.ts";
import { botModelSelectionForThread } from "./botModelSelection.ts";
import {
  decideLimitHit,
  isPersonalResumeMessageId,
  pausedNoticeText,
  PERSONAL_CHAT_RESUME_BUSY_WAIT_MS,
  PERSONAL_CHAT_RESUME_PROMPT,
  PERSONAL_CHAT_RESUME_PROVIDER_GAP_MS,
  PERSONAL_CHAT_RESUME_SLOT_MAX_MS,
  PERSONAL_CHAT_RESUME_SWEEP_MS,
  PERSONAL_NOTICE_MESSAGE_ID_PREFIX,
  PERSONAL_RESUME_MESSAGE_ID_PREFIX,
  providerLabel,
} from "./personalChatResumePolicy.ts";
import { isPersonalGroupMessageId, isPersonalTaskMessageId } from "./personalThreadTitles.ts";
import * as PersonalTaskService from "./tasks/PersonalTaskService.ts";
import { withStallJob } from "../observability/stallJobs.ts";

/**
 * Continues a bot chat that stopped on a provider usage limit, once the limit
 * resets.
 *
 * Delegated tasks already wait for the reset (PersonalTaskService); a chat the
 * owner was talking in just stopped, and he had to come back and say
 * "continue". Here a chat turn that ends on a limit with a reported reset gets
 * a "Paused" row, and after the reset the server starts a turn in the same
 * chat with a short continue prompt, shown as a system row.
 *
 * Rules: one resume per limit hit (a row per hit, unique per thread and
 * turn); none when the owner wrote in the chat since, or it was deleted or
 * archived; none without a reported reset (notice only); resumes take a slot
 * from the task cap and start one after another. The schedule lives in
 * `personal_chat_resumes`, so a restart in between keeps it.
 *
 * Tasks and group rounds are left alone: both have their own rate-limit
 * handling, and a resume here would answer twice.
 */
export class PersonalChatResume extends Context.Service<
  PersonalChatResume,
  {
    /** Subscribes to domain events and starts the sweep. Park-aware. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Feeds one orchestration event in (the start() stream uses this). */
    readonly ingestDomainEvent: (event: OrchestrationEvent) => Effect.Effect<void>;
    /** Resolves when every queued event has been handled. */
    readonly drain: Effect.Effect<void>;
    /** Starts every resume that is due now. The start() loop runs it every 15 s. */
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/personal/PersonalChatResumeService/PersonalChatResume") {}

export type PersonalChatResumeShape = PersonalChatResume["Service"];

type ResumeStatus = "scheduled" | "resumed" | "skipped" | "notice_only";

interface ResumeRow {
  readonly resumeId: string;
  readonly threadId: ThreadId;
  readonly provider: string;
  readonly hitAt: string;
  readonly resumeAt: string | null;
}

/** A resumed chat holding a task slot until its turn ends. */
interface HeldSlot {
  readonly startedAtMs: number;
  /** The resumed turn has been seen running; its end gives the slot back. */
  sawBusy: boolean;
}

const slotKey = (threadId: string) => `chat-resume:${threadId}`;

const noticeContext = (marker: PersonalChatNoticeMarker): OrchestrationMessageContext => ({
  version: 1,
  records: [
    {
      version: 1,
      contextId: ComposerContextId.make(PERSONAL_CHAT_NOTICE_CONTEXT_KIND),
      label: "Chat notice",
      kind: PERSONAL_CHAT_NOTICE_CONTEXT_KIND,
      payload: marker,
    },
  ],
});

const isBusy = (session: OrchestrationSession | null | undefined) =>
  session?.status === "running" || session?.status === "starting";

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const personalBots = yield* PersonalBotRepository.PersonalBotRepository;
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  // Optional so this reactor stays testable alone; the server always has it.
  const tasks = yield* Effect.serviceOption(PersonalTaskService.PersonalTaskService);

  const held = new Map<string, HeldSlot>();
  /** Last resume start per provider, for the gap between them. */
  const lastStartByProvider = new Map<string, number>();

  const nowMs = Effect.map(DateTime.now, DateTime.toEpochMillis);
  const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

  const taskOwnsTurn = (threadId: ThreadId) =>
    Option.isNone(tasks) ? Effect.succeed(false) : tasks.value.ownsThreadTurn(threadId);

  const reserveSlot = (threadId: ThreadId) =>
    Option.isNone(tasks)
      ? Effect.succeed(true)
      : tasks.value.reserveExternalSlot(slotKey(threadId));

  const releaseSlot = (threadId: string) =>
    Effect.gen(function* () {
      if (!held.delete(threadId)) return;
      if (Option.isSome(tasks)) yield* tasks.value.releaseExternalSlot(slotKey(threadId));
    });

  /** The newest user-role message in a chat, the server's own continues aside. */
  const latestUserMessage = (threadId: string) =>
    sql<{ readonly messageId: string; readonly createdAt: string }>`
      SELECT message_id AS "messageId", created_at AS "createdAt"
      FROM projection_thread_messages
      WHERE thread_id = ${threadId} AND role = 'user'
        AND message_id NOT LIKE ${`${PERSONAL_RESUME_MESSAGE_ID_PREFIX}%`}
      ORDER BY created_at DESC
      LIMIT 1
    `.pipe(Effect.map((rows) => rows[0] ?? null));

  const setStatus = (
    resumeId: string,
    status: ResumeStatus,
    outcome: string | null,
    fromStatus: ResumeStatus = "scheduled",
  ) =>
    Effect.gen(function* () {
      const now = iso(yield* nowMs);
      yield* sql`
        UPDATE personal_chat_resumes
        SET status = ${status}, outcome = ${outcome}, resolved_at = ${now}
        WHERE resume_id = ${resumeId} AND status = ${fromStatus}
      `;
    });

  /** Drops every scheduled resume of a chat that moved on without it. */
  const skipScheduled = (threadId: string, outcome: string) =>
    Effect.gen(function* () {
      const now = iso(yield* nowMs);
      const rows = yield* sql<{ readonly resumeId: string }>`
        UPDATE personal_chat_resumes
        SET status = 'skipped', outcome = ${outcome}, resolved_at = ${now}
        WHERE thread_id = ${threadId} AND status = 'scheduled'
        RETURNING resume_id AS "resumeId"
      `;
      if (rows.length > 0) {
        yield* Effect.logInfo("personal chat resume skipped", { threadId, reason: outcome });
      }
    });

  const writeNotice = (
    threadId: ThreadId,
    resumeId: string,
    text: string,
    marker: PersonalChatNoticeMarker,
  ) =>
    Effect.gen(function* () {
      const messageId = MessageId.make(`${PERSONAL_NOTICE_MESSAGE_ID_PREFIX}${resumeId}`);
      const createdAt = iso(yield* nowMs);
      yield* engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make(`personal-chat-resume:${resumeId}:notice:delta`),
        threadId,
        messageId,
        delta: text,
        context: noticeContext(marker),
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make(`personal-chat-resume:${resumeId}:notice:complete`),
        threadId,
        messageId,
        createdAt,
      });
    });

  /** A chat turn ended on a limit: record the hit, say so, schedule the continue. */
  const onLimitHit = Effect.fn("PersonalChatResume.onLimitHit")(function* (
    threadId: ThreadId,
    session: OrchestrationSession,
  ) {
    const retry = session.providerRetry;
    if (retry?.kind !== "rate_limited") return;
    const link = yield* personalBots
      .getThreadLink({ threadId })
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(link)) return;
    // Tasks and group rounds wait for the reset their own way.
    const latest = yield* latestUserMessage(threadId);
    if (
      latest !== null &&
      (isPersonalTaskMessageId(latest.messageId) || isPersonalGroupMessageId(latest.messageId))
    ) {
      return;
    }
    if (yield* taskOwnsTurn(threadId)) return;

    const shell = yield* projections
      .getThreadShellById(threadId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(shell)) return;
    const hitKey = shell.value.latestTurn?.turnId ?? session.updatedAt;
    const now = yield* nowMs;
    const counted = yield* sql<{ readonly consecutive: number }>`
      SELECT count(*) AS consecutive FROM personal_chat_resumes
      WHERE thread_id = ${threadId} AND status = 'resumed'
        AND hit_at > ${latest?.createdAt ?? ""}
    `;
    const decision = decideLimitHit({
      retry,
      nowMs: now,
      consecutiveResumes: counted[0]?.consecutive ?? 0,
    });
    const resumeId = yield* crypto.randomUUIDv4;
    const status: ResumeStatus = decision.kind === "schedule" ? "scheduled" : "notice_only";
    const inserted = yield* sql<{ readonly resumeId: string }>`
      INSERT INTO personal_chat_resumes (
        resume_id, thread_id, hit_key, provider, limit_reason, hit_at, resume_at, status, outcome
      )
      VALUES (
        ${resumeId}, ${threadId}, ${hitKey}, ${session.providerName ?? "unknown"},
        ${retry.reason ?? null}, ${iso(now)},
        ${decision.kind === "schedule" ? iso(decision.resumeAtMs) : null}, ${status},
        ${decision.kind === "notice_only" ? decision.reason : null}
      )
      ON CONFLICT (thread_id, hit_key) DO NOTHING
      RETURNING resume_id AS "resumeId"
    `;
    // The same hit seen again (a replayed session event): already handled.
    if (inserted.length === 0) return;
    const provider = providerLabel(session.providerName);
    yield* writeNotice(
      threadId,
      resumeId,
      pausedNoticeText({ provider, reason: retry.reason, decision, nowMs: now }),
      {
        notice: "usage-limit-paused",
        provider,
        ...(decision.kind === "schedule" ? { resumeAt: iso(decision.resumeAtMs) } : {}),
      },
    ).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("personal chat resume could not write its notice", {
              threadId,
              cause: Cause.pretty(cause),
            }),
      ),
    );
    yield* Effect.logInfo("personal chat paused on a provider limit", {
      threadId,
      resumeId,
      provider: session.providerName,
      reason: retry.reason,
      resumeAt: decision.kind === "schedule" ? iso(decision.resumeAtMs) : null,
      noticeOnly: decision.kind === "notice_only" ? decision.reason : null,
    });
  });

  type DueOutcome =
    | { readonly kind: "skip"; readonly reason: string }
    | { readonly kind: "wait" }
    | { readonly kind: "go" };

  /** Whether a due resume should still run, re-checked against the chat as it is now. */
  const evaluateDue = Effect.fn("PersonalChatResume.evaluateDue")(function* (
    row: ResumeRow,
    now: number,
  ) {
    const shell = yield* projections
      .getThreadShellById(row.threadId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(shell)) return { kind: "skip", reason: "deleted" } satisfies DueOutcome;
    if (shell.value.archivedAt != null) {
      return { kind: "skip", reason: "archived" } satisfies DueOutcome;
    }
    const link = yield* personalBots
      .getThreadLink({ threadId: row.threadId })
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(link)) return { kind: "skip", reason: "deleted" } satisfies DueOutcome;
    if (link.value.archivedAt !== null) {
      return { kind: "skip", reason: "archived" } satisfies DueOutcome;
    }
    const latest = yield* latestUserMessage(row.threadId);
    if (latest !== null && latest.createdAt > row.hitAt) {
      return { kind: "skip", reason: "new_message" } satisfies DueOutcome;
    }
    if (yield* taskOwnsTurn(row.threadId)) {
      return { kind: "skip", reason: "task_turn" } satisfies DueOutcome;
    }
    if (isBusy(shell.value.session)) {
      const dueMs = row.resumeAt === null ? now : Date.parse(row.resumeAt);
      return now - dueMs > PERSONAL_CHAT_RESUME_BUSY_WAIT_MS
        ? ({ kind: "skip", reason: "busy" } satisfies DueOutcome)
        : ({ kind: "wait" } satisfies DueOutcome);
    }
    return { kind: "go" } satisfies DueOutcome;
  });

  const startResume = Effect.fn("PersonalChatResume.startResume")(function* (row: ResumeRow) {
    const shell = yield* projections.getThreadShellById(row.threadId);
    if (Option.isNone(shell)) return;
    const modelSelection = yield* botModelSelectionForThread(
      personalBots,
      row.threadId,
      shell.value.modelSelection,
    );
    const provider = providerLabel(row.provider);
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`personal-chat-resume:${row.resumeId}:turn.start`),
      threadId: row.threadId,
      ...(modelSelection !== undefined ? { modelSelection } : {}),
      message: {
        messageId: MessageId.make(`${PERSONAL_RESUME_MESSAGE_ID_PREFIX}${row.resumeId}`),
        role: "user",
        text: PERSONAL_CHAT_RESUME_PROMPT,
        attachments: [],
        context: noticeContext({ notice: "usage-limit-resumed", provider }),
      },
      runtimeMode: shell.value.runtimeMode,
      interactionMode: shell.value.interactionMode,
      createdAt: iso(yield* nowMs),
    });
  });

  /** One pass over the due resumes, oldest hit first. */
  const sweepOnce = Effect.fn("PersonalChatResume.sweep")(function* () {
    const now = yield* nowMs;
    // A resumed turn that never reported its end still gives its slot back.
    for (const [threadId, slot] of held) {
      if (now - slot.startedAtMs > PERSONAL_CHAT_RESUME_SLOT_MAX_MS) yield* releaseSlot(threadId);
    }
    const due = yield* sql<ResumeRow>`
      SELECT resume_id AS "resumeId", thread_id AS "threadId", provider,
             hit_at AS "hitAt", resume_at AS "resumeAt"
      FROM personal_chat_resumes
      WHERE status = 'scheduled' AND resume_at <= ${iso(now)}
      ORDER BY resume_at, hit_at
    `;
    for (const row of due) {
      const outcome = yield* evaluateDue(row, now);
      if (outcome.kind === "skip") {
        yield* setStatus(row.resumeId, "skipped", outcome.reason);
        yield* Effect.logInfo("personal chat resume skipped", {
          threadId: row.threadId,
          resumeId: row.resumeId,
          reason: outcome.reason,
        });
        continue;
      }
      if (outcome.kind === "wait") continue;
      // One after another per provider: the next one waits for a later pass.
      const last = lastStartByProvider.get(row.provider);
      if (last !== undefined && now - last < PERSONAL_CHAT_RESUME_PROVIDER_GAP_MS) continue;
      // Every slot busy: the rest wait, in order, for a later pass.
      if (!(yield* reserveSlot(row.threadId))) return;
      held.set(row.threadId, { startedAtMs: now, sawBusy: false });
      lastStartByProvider.set(row.provider, now);
      const started = yield* Effect.exit(startResume(row));
      if (started._tag === "Failure") {
        yield* releaseSlot(row.threadId);
        yield* setStatus(row.resumeId, "skipped", "dispatch_failed");
        yield* Effect.logWarning("personal chat resume could not start its turn", {
          threadId: row.threadId,
          resumeId: row.resumeId,
          cause: Cause.pretty(started.cause),
        });
        continue;
      }
      yield* setStatus(row.resumeId, "resumed", null);
      yield* Effect.logInfo("personal chat resumed after a provider limit", {
        threadId: row.threadId,
        resumeId: row.resumeId,
        provider: row.provider,
        resumeAt: row.resumeAt,
      });
    }
  });

  const sweep: PersonalChatResumeShape["sweep"] = sweepOnce().pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("personal chat resume sweep failed", { cause: Cause.pretty(cause) }),
    ),
  );

  const onSessionSet = (threadId: ThreadId, session: OrchestrationSession) =>
    Effect.gen(function* () {
      const slot = held.get(threadId);
      if (slot !== undefined) {
        if (isBusy(session)) slot.sawBusy = true;
        else if (slot.sawBusy && session.activeTurnId === null) yield* releaseSlot(threadId);
      }
      if (
        session.status === "error" &&
        session.activeTurnId === null &&
        session.providerRetry?.kind === "rate_limited"
      ) {
        yield* onLimitHit(threadId, session);
      }
    });

  const handleEvent = (event: OrchestrationEvent) => {
    switch (event.type) {
      case "thread.session-set":
        return onSessionSet(event.payload.threadId, event.payload.session);
      case "thread.turn-start-requested":
        // Anyone writing in the chat (the owner, a task, a group round) takes
        // it on from here; our own continue is the one exception.
        return isPersonalResumeMessageId(event.payload.messageId)
          ? Effect.void
          : skipScheduled(event.payload.threadId, "new_message");
      case "thread.deleted":
        return skipScheduled(event.payload.threadId, "deleted").pipe(
          Effect.andThen(releaseSlot(event.payload.threadId)),
        );
      case "thread.archived":
        return skipScheduled(event.payload.threadId, "archived");
      default:
        return Effect.void;
    }
  };

  const worker = yield* makeDrainableWorker((event: OrchestrationEvent) =>
    handleEvent(event).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("personal chat resume failed to handle an event", {
              eventType: event.type,
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );

  const start: PersonalChatResumeShape["start"] = Effect.fn("PersonalChatResume.start")(
    function* () {
      const events = yield* engine.subscribeDomainEvents;
      yield* forkParked(Stream.runForEach(events, (event) => worker.enqueue(event)));
      // Resumes due while the server was down run on the first pass.
      yield* forkParked(
        worker.drain.pipe(
          Effect.andThen(sweep),
          withStallJob("job:chat-resume-sweep"),
          Effect.repeat(Schedule.spaced(PERSONAL_CHAT_RESUME_SWEEP_MS)),
          Effect.asVoid,
        ),
      );
    },
  );

  return {
    start,
    ingestDomainEvent: (event) => worker.enqueue(event),
    drain: worker.drain,
    sweep: worker.drain.pipe(Effect.andThen(sweep)),
  } satisfies PersonalChatResumeShape;
});

export const layer = Layer.effect(PersonalChatResume, make);
