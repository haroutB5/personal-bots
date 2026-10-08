// @effect-diagnostics nodeBuiltinImport:off - a plain directory inbox written by scripts/personal/notify-release.ps1; renames are the whole protocol.
/**
 * Release-landed wake-up: tells the chat that asked for an hbots release how
 * it went, the moment the release waiter knows.
 *
 * The waiter that activates a release (backup, restart.ps1, smoke.ps1, and a
 * rollback when the smoke fails) runs outside the server and restarts it, so
 * it cannot call a tool. When it finishes it runs
 * `scripts/personal/notify-release.ps1 -ThreadId <chat>`, which writes one
 * JSON notice into `<baseDir>/personal/release-notices/`. This service reads
 * that folder at startup and every few seconds, and posts each notice as one
 * turn in the named bot chat: the requesting bot (the CTO) wakes up with the
 * version, smoke result, rollback status and log path, and carries on (QA)
 * without guessing a timer.
 *
 * Exactly one post per notice: the file is moved out of the inbox before the
 * turn is dispatched, so a crash or a second sweep can never post it twice
 * (a crash in between loses the post, and the log says so). A notice with no
 * thread id, an unreadable one, or one naming a chat that is not a bot chat is
 * moved to `rejected/` and posts nothing.
 *
 * A notice never brings back an archived chat (1.66.8). When the chat it names
 * is archived or deleted, it goes to the same bot's open chat with the same
 * title (else its most recently active open chat; a new chat only when the bot
 * has none open), and the archived chat keeps its place and its name
 * (`resolveDeliveryThread`). The log line says which chat took it.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  CommandId,
  ComposerContextId,
  MessageId,
  PERSONAL_CHAT_NOTICE_CONTEXT_KIND,
  ThreadId,
  type OrchestrationMessageContext,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../../config.ts";
import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../../serverActivation.ts";
import { resolveDeliveryThread } from "../automaticDelivery.ts";
import { botModelSelectionForThread } from "../botModelSelection.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import * as PersonalBotService from "../PersonalBotService.ts";
import { withStallJob } from "../../observability/stallJobs.ts";

export const RELEASE_NOTICE_DIR = "release-notices";
export const RELEASE_NOTICE_SWEEP_MS = 5_000;
export const RELEASE_NOTICE_MESSAGE_ID_PREFIX = "personal-notice-release-";
/** A notice file is a few hundred bytes; anything this big is not one. */
const NOTICE_MAX_BYTES = 16_384;
const DETAIL_MAX_CHARS = 2_000;

const ExitCode = Schema.NullOr(Schema.Number);
const Text = Schema.NullOr(Schema.String);

export const ReleaseNotice = Schema.Struct({
  threadId: Schema.optional(Text),
  version: Schema.String,
  release: Schema.String,
  /**
   * live: activated and smoke passed. rolled_back: the smoke failed and the
   * previous release is back and passed its smoke. rollback_failed: the smoke
   * failed and so did the rollback. failed: stopped before activating.
   */
  outcome: Schema.Literals(["live", "rolled_back", "rollback_failed", "failed"]),
  smokeExit: Schema.optional(ExitCode),
  rollbackRelease: Schema.optional(Text),
  rollbackExit: Schema.optional(ExitCode),
  rollbackSmokeExit: Schema.optional(ExitCode),
  logPath: Schema.optional(Text),
  detail: Schema.optional(Text),
  writtenAt: Schema.optional(Text),
});
export type ReleaseNotice = typeof ReleaseNotice.Type;

const decodeNotice = Schema.decodeUnknownOption(Schema.fromJsonString(ReleaseNotice));

const exitText = (code: number | null | undefined) =>
  code === null || code === undefined ? "not run" : `exit ${code}`;

/** The turn the requesting bot reads. Plain, and says what to do next. */
export function releaseNoticeText(notice: ReleaseNotice): string {
  const name = `hbots ${notice.version} (release ${notice.release})`;
  const rollbackTo = notice.rollbackRelease ?? "the previous release";
  const head =
    notice.outcome === "live"
      ? `Release landed: ${name} is live. Smoke ${exitText(notice.smokeExit)}. No rollback.`
      : notice.outcome === "rolled_back"
        ? `Release failed: ${name} failed its smoke (${exitText(notice.smokeExit)}) and was rolled back to ${rollbackTo}: rollback ${exitText(notice.rollbackExit)}, rollback smoke ${exitText(notice.rollbackSmokeExit)}.`
        : notice.outcome === "rollback_failed"
          ? `Release failed and the rollback failed too: ${name} smoke ${exitText(notice.smokeExit)}; rollback to ${rollbackTo} ${exitText(notice.rollbackExit)}, rollback smoke ${exitText(notice.rollbackSmokeExit)}. The server may be down or on the wrong release.`
          : `Release not activated: ${name} stopped before the restart. Nothing changed on the live server.`;
  const next =
    notice.outcome === "live"
      ? "Confirm the live release and start QA now."
      : notice.outcome === "rollback_failed"
        ? "Check status.ps1 and the log now and tell Harout plainly."
        : "Read the log, fix the cause and re-arm.";
  const detail = (notice.detail ?? "").trim();
  return [
    "Release notice from the app's release waiter (the user did not type this).",
    head,
    detail.length > 0 ? `Detail: ${detail.slice(0, DETAIL_MAX_CHARS)}` : "",
    notice.logPath ? `Log: ${notice.logPath}` : "",
    next,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

const noticeContext: OrchestrationMessageContext = {
  version: 1,
  records: [
    {
      version: 1,
      contextId: ComposerContextId.make(PERSONAL_CHAT_NOTICE_CONTEXT_KIND),
      label: "Chat notice",
      kind: PERSONAL_CHAT_NOTICE_CONTEXT_KIND,
      payload: { notice: "release-landed", provider: "Release" },
    },
  ],
};

/** File name without `.json`, reduced to what a message id may carry. */
const noticeIdOf = (fileName: string) =>
  fileName
    .slice(0, -".json".length)
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .slice(0, 80);

export type ReleaseNoticeOutcome =
  | { readonly status: "posted"; readonly threadId: ThreadId }
  | { readonly status: "rejected"; readonly reason: string };

export class PersonalReleaseNotices extends Context.Service<
  PersonalReleaseNotices,
  {
    /** Sweeps the inbox at startup and every 5 seconds. Park-aware. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** One sweep: every notice in the inbox, oldest name first. */
    readonly sweep: Effect.Effect<ReadonlyArray<ReleaseNoticeOutcome>>;
  }
>()("t3/personal/releaseNotices/PersonalReleaseNoticeService/PersonalReleaseNotices") {}

const errorCode = (cause: unknown) => String((cause as { readonly code?: string }).code ?? cause);

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const bots = yield* PersonalBotRepository.PersonalBotRepository;
  const botService = yield* PersonalBotService.PersonalBotService;
  const inbox = NodePath.join(config.baseDir, "personal", RELEASE_NOTICE_DIR);
  const lock = yield* Semaphore.make(1);

  /** Moves a notice out of the inbox; null when it moved. */
  const moveTo = (fileName: string, folder: "posted" | "rejected") =>
    Effect.promise(async () => {
      try {
        await NodeFSP.mkdir(NodePath.join(inbox, folder), { recursive: true });
        await NodeFSP.rename(
          NodePath.join(inbox, fileName),
          NodePath.join(inbox, folder, fileName),
        );
        return null;
      } catch (cause) {
        return errorCode(cause);
      }
    });

  const reject = (fileName: string, reason: string) =>
    Effect.gen(function* () {
      yield* moveTo(fileName, "rejected");
      yield* Effect.logWarning("release notice not posted", { file: fileName, reason });
      return { status: "rejected", reason } as const;
    });

  const handle = (fileName: string) =>
    Effect.gen(function* () {
      const path = NodePath.join(inbox, fileName);
      const text = yield* Effect.promise(() =>
        NodeFSP.stat(path).then(
          (stat) => (stat.size > NOTICE_MAX_BYTES ? null : NodeFSP.readFile(path, "utf8")),
          () => null,
        ),
      );
      if (text === null) return yield* reject(fileName, "unreadable or too large");
      const decoded = decodeNotice(text.replace(/^﻿/, ""));
      if (Option.isNone(decoded)) return yield* reject(fileName, "not a release notice");
      const notice = decoded.value;
      const rawThreadId = (notice.threadId ?? "").trim();
      if (rawThreadId.length === 0) return yield* reject(fileName, "no thread id");
      const requestedThreadId = ThreadId.make(rawThreadId);
      // Only a bot chat: the inbox is local, but it still never reaches an
      // ordinary T3 thread or a chat nobody can trace to a bot.
      const target = yield* resolveDeliveryThread(
        { repository: bots, projections },
        requestedThreadId,
      );
      if (target.kind === "unknown") {
        return yield* reject(fileName, `thread ${rawThreadId} is not a bot chat`);
      }
      if (target.kind === "open") {
        const gone = yield* projections
          .getThreadShellById(requestedThreadId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isNone(gone)) {
          return yield* reject(fileName, `thread ${rawThreadId} is not a bot chat`);
        }
      }
      // Out of the inbox first: a second sweep or a restart never posts it again.
      const moved = yield* moveTo(fileName, "posted");
      if (moved !== null) {
        yield* Effect.logWarning("release notice could not be claimed; will retry", {
          file: fileName,
          reason: moved,
        });
        return { status: "rejected", reason: `claim failed (${moved})` } as const;
      }
      const noticeId = noticeIdOf(fileName);
      // The bot has no open chat at all: the one chat made for it, named like
      // the one it replaces.
      const threadId =
        target.kind === "new-chat"
          ? yield* botService
              .createThread({
                botId: target.botId,
                threadId: ThreadId.make(NodeCrypto.randomUUID()),
                ...(target.title !== null ? { title: target.title } : {}),
              })
              .pipe(Effect.map((created) => created.threadId))
          : target.threadId;
      if (target.kind === "redirect") {
        yield* Effect.logInfo("release notice sent to the bot's open chat instead", {
          file: fileName,
          requestedThreadId,
          threadId,
          reason: target.reason,
        });
      } else if (target.kind === "new-chat") {
        yield* Effect.logInfo("release notice sent to a new chat: the bot has none open", {
          file: fileName,
          requestedThreadId,
          threadId,
        });
      }
      const shell = yield* projections
        .getThreadShellById(threadId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      const modelSelection = yield* botModelSelectionForThread(
        bots,
        threadId,
        Option.getOrUndefined(shell)?.modelSelection,
      );
      // The chat is open (or new), so its turn start has nothing to unarchive.
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`personal-release-notice:${noticeId}:turn.start`),
        threadId,
        ...(modelSelection !== undefined ? { modelSelection } : {}),
        message: {
          messageId: MessageId.make(`${RELEASE_NOTICE_MESSAGE_ID_PREFIX}${noticeId}`),
          role: "user",
          text: releaseNoticeText(notice),
          attachments: [],
          context: noticeContext,
        },
        runtimeMode: Option.getOrUndefined(shell)?.runtimeMode ?? "full-access",
        interactionMode: Option.getOrUndefined(shell)?.interactionMode ?? "default",
        createdAt: DateTime.formatIso(yield* DateTime.now),
      });
      yield* Effect.logInfo("release notice posted", {
        file: fileName,
        threadId,
        version: notice.version,
        outcome: notice.outcome,
      });
      return { status: "posted", threadId } as const;
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("release notice failed", {
              file: fileName,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as({ status: "rejected", reason: "post failed" } as const)),
      ),
    );

  const sweep: PersonalReleaseNotices["Service"]["sweep"] = lock.withPermit(
    Effect.gen(function* () {
      const names = yield* Effect.promise(() =>
        NodeFSP.readdir(inbox, { withFileTypes: true }).then(
          (entries) =>
            entries
              .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
              .map((entry) => entry.name)
              .sort(),
          () => [] as Array<string>,
        ),
      );
      return yield* Effect.forEach(names, handle);
    }),
  );

  const start: PersonalReleaseNotices["Service"]["start"] = () =>
    forkParked(
      sweep.pipe(
        withStallJob("job:release-notice-sweep"),
        Effect.repeat(Schedule.spaced(RELEASE_NOTICE_SWEEP_MS)),
        Effect.asVoid,
      ),
    ).pipe(Effect.asVoid);

  return { start, sweep } satisfies PersonalReleaseNotices["Service"];
});

export const layer = Layer.effect(PersonalReleaseNotices, make);
