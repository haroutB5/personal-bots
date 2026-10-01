// @effect-diagnostics nodeBuiltinImport:off - writes notice files into the test server's inbox like notify-release.ps1 does.
// @effect-diagnostics preferSchemaOverJson:off - writes the notice JSON verbatim, as the script does.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  PERSONAL_CHAT_NOTICE_CONTEXT_KIND,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";

import * as ServerConfig from "../../config.ts";
import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import {
  PersonalReleaseNotices,
  RELEASE_NOTICE_DIR,
  layer as releaseNoticeLayer,
} from "./PersonalReleaseNoticeService.ts";

const CTO_CHAT = "thread-cto-chat";
const PLAIN_THREAD = "thread-not-a-bot";

const makeLayer = (dispatched: Array<OrchestrationCommand>) =>
  releaseNoticeLayer.pipe(
    Layer.provideMerge(PersonalBotRepository.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      Layer.succeed(OrchestrationEngine.OrchestrationEngineService, {
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length };
          }),
        streamDomainEvents: Stream.empty,
      } as unknown as OrchestrationEngine.OrchestrationEngineShape),
    ),
    Layer.provideMerge(
      Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getThreadShellById: (threadId: ThreadId) =>
          Effect.succeed(
            threadId === CTO_CHAT || threadId === PLAIN_THREAD
              ? Option.some({
                  id: threadId,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-5-5" },
                })
              : Option.none(),
          ),
      } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQueryShape),
    ),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-personal-release-notice-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

/** The CTO's chat is a bot chat; PLAIN_THREAD is an ordinary T3 thread. */
const linkCtoChat = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = DateTime.formatIso(yield* DateTime.now);
  yield* sql`
    INSERT INTO personal_bots (
      bot_id, name, description, instructions, avatar_shape, avatar_color,
      model_selection_json, enabled, sort_order, created_at, updated_at
    )
    VALUES ('bot-cto', 'CTO', '', '', 'blob', '#1A73E8', '{}', 1, 0, ${now}, ${now})
  `;
  yield* sql`
    INSERT INTO personal_bot_threads (thread_id, bot_id, created_at)
    VALUES (${CTO_CHAT}, 'bot-cto', ${now})
  `;
});

const inboxDir = Effect.map(ServerConfig.ServerConfig, (config) =>
  NodePath.join(config.baseDir, "personal", RELEASE_NOTICE_DIR),
);

/** What notify-release.ps1 writes. */
const writeNotice = (name: string, body: Record<string, unknown>) =>
  Effect.gen(function* () {
    const dir = yield* inboxDir;
    yield* Effect.promise(async () => {
      await NodeFSP.mkdir(dir, { recursive: true });
      // PowerShell's UTF-8 writer may add a BOM; the server must accept it.
      await NodeFSP.writeFile(NodePath.join(dir, name), `\uFEFF${JSON.stringify(body)}\n`);
    });
  });

const turnStarts = (dispatched: ReadonlyArray<OrchestrationCommand>) =>
  dispatched.filter(
    (command): command is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
      command.type === "thread.turn.start",
  );

describe("PersonalReleaseNotices", () => {
  it.effect("a successful release posts exactly one turn into the requesting chat", () => {
    const dispatched: Array<OrchestrationCommand> = [];
    return Effect.gen(function* () {
      yield* linkCtoChat;
      yield* writeNotice("20261001T230000Z-live.json", {
        threadId: CTO_CHAT,
        version: "1.60.18",
        release: "abc123def456",
        outcome: "live",
        smokeExit: 0,
        rollbackRelease: "5531a1f12aeb",
        logPath: "C:\\Users\\Ht\\.personal-bots\\logs\\restart-1.60.18.log",
      });
      const service = yield* PersonalReleaseNotices;
      const first = yield* service.sweep;
      const second = yield* service.sweep;

      expect(first).toEqual([{ status: "posted", threadId: CTO_CHAT }]);
      expect(second).toEqual([]);
      const turns = turnStarts(dispatched);
      expect(turns).toHaveLength(1);
      const turn = turns[0]!;
      expect(turn.threadId).toBe(CTO_CHAT);
      expect(turn.message.messageId).toBe("personal-notice-release-20261001T230000Z-live");
      expect(turn.message.text).toContain(
        "Release landed: hbots 1.60.18 (release abc123def456) is live. Smoke exit 0. No rollback.",
      );
      expect(turn.message.text).toContain("restart-1.60.18.log");
      expect(turn.message.text).toContain("start QA now");
      expect(turn.message.context?.records[0]).toMatchObject({
        kind: PERSONAL_CHAT_NOTICE_CONTEXT_KIND,
        payload: { notice: "release-landed" },
      });
      // The chat's own modes: a changed runtime mode would restart its session.
      expect(turn.runtimeMode).toBe("full-access");
      expect(turn.interactionMode).toBe("default");
      const dir = yield* inboxDir;
      const posted = yield* Effect.promise(() => NodeFSP.readdir(NodePath.join(dir, "posted")));
      expect(posted).toEqual(["20261001T230000Z-live.json"]);
    }).pipe(Effect.provide(makeLayer(dispatched)));
  });

  it.effect("a rollback posts exactly one turn with the rollback status", () => {
    const dispatched: Array<OrchestrationCommand> = [];
    return Effect.gen(function* () {
      yield* linkCtoChat;
      yield* writeNotice("20261001T231500Z-rollback.json", {
        threadId: CTO_CHAT,
        version: "1.60.18",
        release: "abc123def456",
        outcome: "rolled_back",
        smokeExit: 1,
        rollbackRelease: "5531a1f12aeb",
        rollbackExit: 0,
        rollbackSmokeExit: 0,
        logPath: "C:\\logs\\restart-1.60.18.log",
        detail: "FAIL  /version.txt mismatch",
      });
      const service = yield* PersonalReleaseNotices;
      yield* service.sweep;
      yield* service.sweep;

      const turns = turnStarts(dispatched);
      expect(turns).toHaveLength(1);
      expect(turns[0]!.message.text).toContain(
        "failed its smoke (exit 1) and was rolled back to 5531a1f12aeb: rollback exit 0, rollback smoke exit 0.",
      );
      expect(turns[0]!.message.text).toContain("Detail: FAIL  /version.txt mismatch");
    }).pipe(Effect.provide(makeLayer(dispatched)));
  });

  it.effect("no thread id, a plain thread or a broken file posts nothing", () => {
    const dispatched: Array<OrchestrationCommand> = [];
    return Effect.gen(function* () {
      yield* linkCtoChat;
      const base = { version: "1.60.18", release: "abc123def456", outcome: "live", smokeExit: 0 };
      yield* writeNotice("a-no-thread.json", base);
      yield* writeNotice("b-empty-thread.json", { ...base, threadId: "  " });
      yield* writeNotice("c-plain-thread.json", { ...base, threadId: PLAIN_THREAD });
      yield* writeNotice("d-unknown-thread.json", { ...base, threadId: "thread-gone" });
      yield* writeNotice("e-bad-outcome.json", { ...base, threadId: CTO_CHAT, outcome: "maybe" });
      const service = yield* PersonalReleaseNotices;
      const outcomes = yield* service.sweep;

      expect(outcomes.map((outcome) => outcome.status)).toEqual([
        "rejected",
        "rejected",
        "rejected",
        "rejected",
        "rejected",
      ]);
      expect(dispatched).toEqual([]);
      const dir = yield* inboxDir;
      const rejected = yield* Effect.promise(() => NodeFSP.readdir(NodePath.join(dir, "rejected")));
      expect(rejected).toHaveLength(5);
      expect(yield* service.sweep).toEqual([]);
    }).pipe(Effect.provide(makeLayer(dispatched)));
  });

  it.effect("an empty or missing inbox is a quiet no-op", () => {
    const dispatched: Array<OrchestrationCommand> = [];
    return Effect.gen(function* () {
      const service = yield* PersonalReleaseNotices;
      expect(yield* service.sweep).toEqual([]);
      expect(dispatched).toEqual([]);
    }).pipe(Effect.provide(makeLayer(dispatched)));
  });
});
