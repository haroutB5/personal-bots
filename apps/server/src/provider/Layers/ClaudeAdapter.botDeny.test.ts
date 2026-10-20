// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off - The fake CLI is a real child process, so the wait for its argv file runs on real time.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../../config.ts";
import { buildClaudeBotPermissionDeny } from "../../personal/secrets/botProtectedPaths.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";
import { makeClaudeAdapter } from "./ClaudeAdapter.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

class ClaudeAdapter extends Context.Service<ClaudeAdapter, ClaudeAdapterShape>()(
  "t3/provider/Layers/ClaudeAdapter.botDeny.test/ClaudeAdapter",
) {}

// Stands in for the Claude CLI: records the argv the real SDK builds, records
// the `initialize` control request (where the SDK registers in-process hooks),
// answers `initialize`, and idles until the adapter stops it. It cannot enforce
// anything; it proves what the real CLI is told.
const FAKE_CLI = [
  'import { writeFileSync } from "node:fs";',
  'import { createInterface } from "node:readline";',
  "writeFileSync(process.env.T3_BOT_DENY_INVOCATION_PATH, JSON.stringify({ args: process.argv.slice(2) }));",
  "const lines = createInterface({ input: process.stdin });",
  'lines.on("close", () => process.exit(0));',
  'lines.on("line", (line) => {',
  "  let message; try { message = JSON.parse(line); } catch { return; }",
  '  if (message.type !== "control_request") return;',
  '  if (message.request?.subtype === "initialize") {',
  "    writeFileSync(process.env.T3_BOT_DENY_INIT_PATH, JSON.stringify(message.request));",
  "    process.stdout.write(JSON.stringify({",
  '      type: "control_response",',
  '      response: { subtype: "success", request_id: message.request_id, response: { commands: [], agents: [], output_style: "default", available_output_styles: ["default"], models: [] } },',
  '    }) + "\\n");',
  "  }",
  "});",
  "setInterval(() => {}, 1_000);",
  "",
].join("\n");

const waitForFile = (filePath: string) =>
  Effect.promise(async () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (NodeFS.existsSync(filePath) && NodeFS.statSync(filePath).size > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`The fake CLI never wrote ${filePath}`);
  });

/** Starts a session through the real SDK against the recording CLI; returns the `--settings` JSON it saw. */
const startAndReadSettings = (personalBot: boolean) =>
  Effect.gen(function* () {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-bot-deny-"));
    const cliPath = NodePath.join(dir, "fake-claude.mjs");
    const invocationPath = NodePath.join(dir, "invocation.json");
    const initPath = NodePath.join(dir, "initialize.json");
    const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-bot-deny-cwd-"));
    NodeFS.writeFileSync(cliPath, FAKE_CLI);
    const layer = Layer.effect(
      ClaudeAdapter,
      makeClaudeAdapter(decodeClaudeSettings({ binaryPath: cliPath }), {
        environment: {
          ...process.env,
          T3_BOT_DENY_INVOCATION_PATH: invocationPath,
          T3_BOT_DENY_INIT_PATH: initPath,
        },
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(cwd, dir)),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    );
    return yield* Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const serverConfig = yield* ServerConfig;
      const threadId = ThreadId.make(`thread-bot-deny-e2e-${personalBot ? "bot" : "plain"}`);
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
        cwd,
        ...(personalBot ? { personalBot: true } : {}),
      });
      yield* waitForFile(invocationPath);
      yield* waitForFile(initPath);
      yield* adapter.stopSession(threadId);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const invocation = JSON.parse(NodeFS.readFileSync(invocationPath, "utf8")) as {
        readonly args: ReadonlyArray<string>;
      };
      const flag = invocation.args.indexOf("--settings");
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const settings = (flag >= 0 ? JSON.parse(invocation.args[flag + 1] ?? "{}") : undefined) as
        | {
            readonly permissions?: { readonly deny?: ReadonlyArray<string> };
            readonly skillOverrides?: Record<string, string>;
          }
        | undefined;
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const initialize = JSON.parse(NodeFS.readFileSync(initPath, "utf8")) as {
        readonly hooks?: Record<
          string,
          ReadonlyArray<{
            readonly matcher?: string;
            readonly hookCallbackIds?: ReadonlyArray<string>;
          }>
        >;
      };
      return { settings, args: invocation.args, serverConfig, initialize };
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(
        Effect.sync(() => {
          // The stopped CLI can still hold its cwd for a moment on Windows; an
          // empty temp folder left behind is not worth failing the test for.
          for (const target of [dir, cwd]) {
            try {
              NodeFS.rmSync(target, {
                recursive: true,
                force: true,
                maxRetries: 20,
                retryDelay: 250,
              });
            } catch {
              // ignored on purpose
            }
          }
        }),
      ),
    );
  });

describe("personal bot deny rules reach the Claude CLI", () => {
  it.live("passes the deny rules on --settings for a bot, and none for a normal thread", () =>
    Effect.gen(function* () {
      const bot = yield* startAndReadSettings(true);
      const deny = bot.settings?.permissions?.deny ?? [];
      assert.deepEqual(deny, buildClaudeBotPermissionDeny(bot.serverConfig));
      assert.ok(deny.length > 0);
      // Bots load no settings files, so the flag layer is the only carrier.
      assert.ok(bot.args.includes("--setting-sources="));
      // Bypass mode is on for a full-access bot: the rules must outlive it.
      assert.ok(bot.args.includes("--allow-dangerously-skip-permissions"));

      const plain = yield* startAndReadSettings(false);
      assert.equal(plain.settings?.permissions, undefined);
    }),
  );

  it.live(
    "trims the bot's tool list, skills list and whole-file reads, and leaves a normal thread alone",
    () =>
      Effect.gen(function* () {
        const bot = yield* startAndReadSettings(true);
        // The four tools no bot has called are gone from the CLI's tool schemas.
        const toolsArg = bot.args.find((arg) => arg.startsWith("--disallowedTools="));
        assert.ok(toolsArg !== undefined);
        assert.deepEqual(toolsArg.slice("--disallowedTools=".length).split(","), [
          "Workflow",
          "ReportFindings",
          "ScheduleWakeup",
          "AskUserQuestion",
        ]);
        // Bundled skills bots never call stay typable as /name but leave the model's list.
        assert.deepEqual(Object.keys(bot.settings?.skillOverrides ?? {}).sort(), [
          "code-review",
          "fewer-permission-prompts",
          "init",
          "keybindings-help",
          "loop",
          "plugin-authoring",
          "run",
          "schedule",
          "security-review",
          "simplify",
          "workflow-authoring",
        ]);
        assert.deepEqual(
          new Set(Object.values(bot.settings?.skillOverrides ?? {})),
          new Set(["user-invocable-only"]),
        );
        // The large-Read guard rides a PreToolUse hook registered with the CLI.
        const preToolUse = bot.initialize.hooks?.PreToolUse ?? [];
        assert.equal(preToolUse.length, 1);
        assert.equal(preToolUse[0]?.matcher, "Read");
        assert.equal(preToolUse[0]?.hookCallbackIds?.length, 1);

        const plain = yield* startAndReadSettings(false);
        assert.equal(plain.args.includes("--disallowedTools"), false);
        assert.equal(plain.settings?.skillOverrides, undefined);
        assert.equal(plain.initialize.hooks?.PreToolUse, undefined);
      }),
  );
});
