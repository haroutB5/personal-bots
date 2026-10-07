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

// Stands in for the Claude CLI: records the argv the real SDK builds, answers
// `initialize`, and idles until the adapter stops it. It cannot enforce
// anything; it proves the deny rules arrive on the CLI's `--settings` flag.
const FAKE_CLI = [
  'import { writeFileSync } from "node:fs";',
  'import { createInterface } from "node:readline";',
  "writeFileSync(process.env.T3_BOT_DENY_INVOCATION_PATH, JSON.stringify({ args: process.argv.slice(2) }));",
  "const lines = createInterface({ input: process.stdin });",
  'lines.on("line", (line) => {',
  "  let message; try { message = JSON.parse(line); } catch { return; }",
  '  if (message.type !== "control_request") return;',
  '  if (message.request?.subtype === "initialize") {',
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
    const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-bot-deny-cwd-"));
    NodeFS.writeFileSync(cliPath, FAKE_CLI);
    const layer = Layer.effect(
      ClaudeAdapter,
      makeClaudeAdapter(decodeClaudeSettings({ binaryPath: cliPath }), {
        environment: { ...process.env, T3_BOT_DENY_INVOCATION_PATH: invocationPath },
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
      yield* adapter.stopSession(threadId);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const invocation = JSON.parse(NodeFS.readFileSync(invocationPath, "utf8")) as {
        readonly args: ReadonlyArray<string>;
      };
      const flag = invocation.args.indexOf("--settings");
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const settings = (flag >= 0 ? JSON.parse(invocation.args[flag + 1] ?? "{}") : undefined) as
        | { readonly permissions?: { readonly deny?: ReadonlyArray<string> } }
        | undefined;
      return { settings, args: invocation.args, serverConfig };
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
  it.effect("passes the deny rules on --settings for a bot, and none for a normal thread", () =>
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
});
