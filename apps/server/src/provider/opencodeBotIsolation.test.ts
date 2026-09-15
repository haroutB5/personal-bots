import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeURL from "node:url";

import {
  ensurePersonalBotOpenCodeHome,
  PERSONAL_BOT_OPENCODE_ENV_PLUGIN,
  personalBotOpenCodeConfigContent,
  personalBotOpenCodeEnvironment,
} from "./opencodeBotIsolation.ts";

type ShellEnvHook = (input: unknown, output: { env: Record<string, string> }) => Promise<void>;

it.layer(NodeServices.layer)("opencodeBotIsolation", (it) => {
  it("layers the bots home, the disable flags and the per-session config over the base env", () => {
    const env = personalBotOpenCodeEnvironment({
      base: { PATH: "p", PB_SECRET_GITHUB_TOKEN: "s", OPENCODE_CONFIG_CONTENT: '{"mcp":{}}' },
      configHome: "C:/state/opencode-bots",
      model: "opencode/muse-spark-1.3-contributor-free",
    });
    assert.strictEqual(env.PATH, "p");
    assert.strictEqual(env.PB_SECRET_GITHUB_TOKEN, "s");
    assert.strictEqual(env.XDG_CONFIG_HOME, "C:/state/opencode-bots");
    assert.strictEqual(env.T3_OWNER_XDG_CONFIG_HOME, "");
    for (const flag of [
      "OPENCODE_DISABLE_CLAUDE_CODE",
      "OPENCODE_DISABLE_EXTERNAL_SKILLS",
      "OPENCODE_DISABLE_PROJECT_CONFIG",
      "OPENCODE_DISABLE_AUTOUPDATE",
      "OPENCODE_DISABLE_SHARE",
    ]) {
      assert.strictEqual(env[flag], "1", flag);
    }
    // The owner's own config content never survives into a bot session.
    assert.deepStrictEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? ""), {
      share: "disabled",
      autoupdate: false,
      small_model: "opencode/muse-spark-1.3-contributor-free",
    });
  });

  it("remembers the owner's own XDG_CONFIG_HOME for shell commands", () => {
    const env = personalBotOpenCodeEnvironment({
      base: { XDG_CONFIG_HOME: "C:/owner/config" },
      configHome: "C:/state/opencode-bots",
    });
    assert.strictEqual(env.XDG_CONFIG_HOME, "C:/state/opencode-bots");
    assert.strictEqual(env.T3_OWNER_XDG_CONFIG_HOME, "C:/owner/config");
  });

  it("denies tools only when asked and skips a model that is not provider/model", () => {
    assert.deepStrictEqual(JSON.parse(personalBotOpenCodeConfigContent({ model: "bare" })), {
      share: "disabled",
      autoupdate: false,
    });
    assert.deepStrictEqual(
      JSON.parse(personalBotOpenCodeConfigContent({ model: "a/b", denyTools: true })).permission,
      { "*": "deny" },
    );
  });

  it.effect("writes the env plugin once and rewrites it when it drifted", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-oc-bots-" });
      const home = yield* ensurePersonalBotOpenCodeHome(stateDir);
      assert.strictEqual(home, path.join(stateDir, "opencode-bots"));
      const pluginPath = path.join(home, "opencode", "plugin", "t3-restore-owner-env.js");
      assert.strictEqual(
        yield* fileSystem.readFileString(pluginPath),
        PERSONAL_BOT_OPENCODE_ENV_PLUGIN,
      );

      yield* fileSystem.writeFileString(pluginPath, "// stale");
      yield* ensurePersonalBotOpenCodeHome(stateDir);
      assert.strictEqual(
        yield* fileSystem.readFileString(pluginPath),
        PERSONAL_BOT_OPENCODE_ENV_PLUGIN,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("the plugin hands shell commands the owner's value, or empty when unset", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-oc-bots-" });
      const home = yield* ensurePersonalBotOpenCodeHome(stateDir);
      const pluginPath = path.join(home, "opencode", "plugin", "t3-restore-owner-env.js");
      const module = (yield* Effect.promise(
        // The temp dir is unique per run, so the module cache never serves a stale copy.
        () => import(NodeURL.pathToFileURL(pluginPath).href),
      )) as { T3RestoreOwnerEnv: () => Promise<Record<string, ShellEnvHook>> };
      const hooks = yield* Effect.promise(() => module.T3RestoreOwnerEnv());
      const hook = hooks["shell.env"];
      assert.isDefined(hook);

      const previous = process.env.T3_OWNER_XDG_CONFIG_HOME;
      try {
        delete process.env.T3_OWNER_XDG_CONFIG_HOME;
        const unset = { env: {} as Record<string, string> };
        yield* Effect.promise(() => hook!({}, unset));
        assert.strictEqual(unset.env.XDG_CONFIG_HOME, "");

        process.env.T3_OWNER_XDG_CONFIG_HOME = "C:/owner/config";
        const owned = { env: {} as Record<string, string> };
        yield* Effect.promise(() => hook!({}, owned));
        assert.strictEqual(owned.env.XDG_CONFIG_HOME, "C:/owner/config");
      } finally {
        if (previous === undefined) delete process.env.T3_OWNER_XDG_CONFIG_HOME;
        else process.env.T3_OWNER_XDG_CONFIG_HOME = previous;
      }
    }).pipe(Effect.scoped),
  );
});
