/**
 * Runtime-level steer regression (1.66.28): a message sent while a turn runs
 * goes out as `turn/steer` against the active turn; a refused steer (the turn
 * just ended, a non-steerable turn, or an app-server that predates the call)
 * falls back to `turn/start` so the message is never lost; a `followUp`
 * "queue" send never steers and starts a turn of its own.
 *
 * Boots the real CodexSessionRuntime against the scripted mock app-server peer
 * (codexCollabMockPeer), which records turn/start and turn/steer requests.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ThreadId, TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { assert, describe } from "vite-plus/test";

import wireFixture from "../testFixtures/codexMultiAgentWire.json" with { type: "json" };
import { makeCodexSessionRuntime } from "./CodexSessionRuntime.ts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

const ROOT = wireFixture.rootThreadId;
const scriptPath = NodePath.join(import.meta.dirname, "../testFixtures/.steer-script.json");
// Windows cannot run the shebang wrapper; the .cmd sibling does the same job.
const peerPath = NodePath.join(
  import.meta.dirname,
  `../testFixtures/codexCollabMockPeer.${HostProcessPlatform.defaultValue() === "win32" ? "cmd" : "sh"}`,
);

function readRecordedRequests() {
  return NodeFS.readFileSync(`${scriptPath}.requests`, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
}

function startRuntime(script: Record<string, unknown>) {
  return Effect.gen(function* () {
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
    NodeFS.rmSync(`${scriptPath}.requests`, { force: true });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        NodeFS.rmSync(scriptPath, { force: true });
        NodeFS.rmSync(`${scriptPath}.requests`, { force: true });
      }),
    );
    const runtime = yield* makeCodexSessionRuntime({
      threadId: ThreadId.make("thread-steer"),
      binaryPath: peerPath,
      cwd: NodeOS.tmpdir(),
      runtimeMode: "full-access",
      environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
    });
    yield* runtime.start();
    return runtime;
  });
}

describe("Codex turn steering", () => {
  it.effect("steers a mid-turn send into the active turn instead of queueing a turn", () =>
    Effect.gen(function* () {
      const runtime = yield* startRuntime({
        rootThreadId: ROOT,
        notifications: [],
        recordTurnStarts: true,
        turnIds: ["turn-a"],
        holdTurnOpen: true,
      });
      const first = yield* runtime.sendTurn({ input: "first" });
      assert.equal(first.turnId, TurnId.make("turn-a"));

      const steered = yield* runtime.sendTurn({
        input: "steer me",
        clientUserMessageId: "message-steer-1",
      });
      // The steer lands in the already-running turn: delivery is immediate
      // (the turn has started), unlike a queued turn of its own.
      assert.equal(steered.turnId, TurnId.make("turn-a"));

      const requests = readRecordedRequests();
      assert.deepEqual(
        requests.map((request) => request.method),
        ["turn/start", "turn/steer"],
      );
      assert.deepEqual(requests[1]!.params, {
        threadId: ROOT,
        expectedTurnId: "turn-a",
        input: [{ type: "text", text: "steer me" }],
        clientUserMessageId: "message-steer-1",
      });

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("falls back to turn/start when the steer is refused", () =>
    Effect.gen(function* () {
      const runtime = yield* startRuntime({
        rootThreadId: ROOT,
        notifications: [],
        recordTurnStarts: true,
        turnIds: ["turn-a", "turn-b"],
        holdTurnOpen: true,
        failSteer: "expected active turn id turn-a",
      });
      const first = yield* runtime.sendTurn({ input: "first" });
      assert.equal(first.turnId, TurnId.make("turn-a"));

      // The steer is refused (the turn just ended): the same message must go
      // out as a new turn rather than be lost.
      const second = yield* runtime.sendTurn({ input: "after the turn died" });
      assert.equal(second.turnId, TurnId.make("turn-b"));

      const requests = readRecordedRequests();
      assert.deepEqual(
        requests.map((request) => request.method),
        ["turn/start", "turn/steer", "turn/start"],
      );
      assert.deepEqual(requests[2]!.params.input, [{ type: "text", text: "after the turn died" }]);

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("a queued send never steers while a turn is running", () =>
    Effect.gen(function* () {
      const runtime = yield* startRuntime({
        rootThreadId: ROOT,
        notifications: [],
        recordTurnStarts: true,
        turnIds: ["turn-a", "turn-b"],
        holdTurnOpen: true,
      });
      const first = yield* runtime.sendTurn({ input: "first" });
      assert.equal(first.turnId, TurnId.make("turn-a"));

      const queued = yield* runtime.sendTurn({ input: "queued", followUp: "queue" });
      // Its own turn, not the active one.
      assert.equal(queued.turnId, TurnId.make("turn-b"));

      const requests = readRecordedRequests();
      assert.deepEqual(
        requests.map((request) => request.method),
        ["turn/start", "turn/start"],
      );

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
