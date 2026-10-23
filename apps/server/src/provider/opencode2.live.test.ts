// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  OpenCodeSettings,
  ApprovalRequestId,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/unstable/http";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { makeOpenCode2Instance } from "./opencode2.ts";

const decodeSettings = Schema.decodeSync(OpenCodeSettings);
const encodeEnvironmentProof = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ key: Schema.Boolean, data: Schema.String })),
);
// Requires the owner's installed binary and subscription. Normal gates remain credential-free.
it.live.skipIf(!process.env.HBOTS_OPENCODE_V2_LIVE)(
  "real OpenCode 2 Go Plus answers, resumes, and streams under the app adapter",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "hbots-go-live-" });
      const instanceId = ProviderInstanceId.make("opencode-go-proof");
      const threadId = ThreadId.make("opencode-go-proof");
      const modelSelection = { instanceId, model: "opencode-go/deepseek-v4.1-flash" };
      const instance = yield* makeOpenCode2Instance({
        instanceId,
        displayName: "OpenCode proof",
        accentColor: undefined,
        config: decodeSettings({ enabled: true, binaryPath: process.env.HBOTS_OPENCODE_V2_LIVE! }),
        environment: process.env,
        version: "2.1.3",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            ServerConfig.layerTest(root, path.join(root, "app")),
            ServerSettingsService.layerTest(),
            Layer.mock(BackgroundPolicy.BackgroundPolicy)({
              shouldRunScopeWork: () => Effect.succeed(false),
            }),
          ),
        ),
      );
      const snapshot = yield* instance.snapshot.refresh;
      expect(snapshot.status).toBe("ready");
      expect(snapshot.models.some((model) => model.slug === modelSelection.model)).toBe(true);
      expect(snapshot.usageLimits?.windows.length).toBe(3);
      const events: ProviderRuntimeEvent[] = [];
      const shellCommand = `node -e "require('fs').writeFileSync('env-proof.txt', JSON.stringify({key:!!process.env.OPENCODE_API_KEY,data:process.env.XDG_DATA_HOME||''}));console.log('HBOTS_SHELL_TEST')"`;
      let permissionRequests = 0;
      yield* instance.adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            events.push(event);
            if (event.type === "request.opened" && event.requestId) {
              permissionRequests++;
              const request = event.raw?.payload as
                | { toolCall?: { rawInput?: { command?: string } } }
                | undefined;
              yield* instance.adapter.respondToRequest(
                threadId,
                ApprovalRequestId.make(event.requestId),
                request?.toolCall?.rawInput?.command === shellCommand ? "accept" : "cancel",
              );
            }
          }),
        ),
        Effect.forkChild,
      );
      const session = yield* instance.adapter.startSession({
        threadId,
        cwd: root,
        runtimeMode: "approval-required",
        modelSelection,
      });
      yield* instance.adapter.sendTurn({
        threadId,
        modelSelection,
        input:
          "Remember this harmless test marker: SKY-7319. Reply with exactly GO_PLUS_OK. Do not use tools.",
      });
      expect(
        events.some(
          (event) => event.type === "content.delta" && event.payload.delta.includes("GO_PLUS_OK"),
        ),
      ).toBe(true);
      yield* instance.adapter.stopSession(threadId);
      yield* instance.adapter.startSession({
        threadId,
        cwd: root,
        runtimeMode: "approval-required",
        modelSelection,
        resumeCursor: session.resumeCursor,
      });
      yield* instance.adapter.sendTurn({
        threadId,
        modelSelection,
        input: "What test marker did I give you? Reply with only the marker. Do not use tools.",
      });
      expect(
        events.some(
          (event) => event.type === "content.delta" && event.payload.delta.includes("SKY-7319"),
        ),
      ).toBe(true);
      expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(2);
      // Full-access bots run tools without a prompt. If the adapter failed to
      // auto-approve, nothing would answer this request and the turn would hang.
      yield* instance.adapter.stopSession(threadId);
      yield* instance.adapter.startSession({
        threadId,
        cwd: root,
        runtimeMode: "full-access",
        modelSelection,
      });
      yield* instance.adapter.sendTurn({
        threadId,
        modelSelection,
        input: `Use the shell tool once to run this exact harmless command, then reply with the output: ${shellCommand}. Do not run any other command.`,
      });
      expect(permissionRequests).toBe(0);
      const transcript = events
        .filter((event) => event.type === "content.delta")
        .map((event) => event.payload.delta)
        .join("");
      expect(yield* fs.exists(path.join(root, "env-proof.txt")), transcript).toBe(true);
      expect(yield* fs.readFileString(path.join(root, "env-proof.txt"))).toBe(
        encodeEnvironmentProof({ key: false, data: process.env.XDG_DATA_HOME || "" }),
      );
      yield* instance.adapter.stopAll();
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(FetchHttpClient.layer, NodeServices.layer)),
    ),
  120_000,
);
