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

type ShellCreateBefore = {
  command: string;
  cwd: string;
  timeout: number;
  shell: string;
  env: Record<string, string | undefined>;
};

type EnvPluginModule = {
  readonly restoreOwnerEnvironment?: (event: ShellCreateBefore) => void;
  readonly default?: {
    readonly id: string;
    readonly setup: (ctx: {
      shell: {
        hook: (name: string, callback: (event: ShellCreateBefore) => void) => Promise<unknown>;
      };
    }) => Promise<void>;
  };
};

const writeOpenCodePluginStub = Effect.fn("writeOpenCodePluginStub")(function* (home: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stubDirectory = path.join(home, "node_modules", "@opencode", "plugin");
  yield* fileSystem.makeDirectory(stubDirectory, { recursive: true });
  yield* fileSystem.writeFileString(
    path.join(stubDirectory, "package.json"),
    '{"name":"@opencode/plugin","type":"module","exports":"./index.js"}\n',
  );
  yield* fileSystem.writeFileString(
    path.join(stubDirectory, "index.js"),
    "export const Plugin = { define: (definition) => definition };\n",
  );
});

const importTemplatePlugin = Effect.fn("importTemplatePlugin")(function* (home: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* writeOpenCodePluginStub(home);
  const templateDirectory = path.join(home, "template-plugin");
  yield* fileSystem.makeDirectory(templateDirectory, { recursive: true });
  yield* fileSystem.writeFileString(
    path.join(templateDirectory, "index.js"),
    PERSONAL_BOT_OPENCODE_ENV_PLUGIN,
  );
  return (yield* Effect.promise(
    () => import(NodeURL.pathToFileURL(path.join(templateDirectory, "index.js")).href),
  )) as EnvPluginModule;
});

const OWNER_VARIABLES = [
  "HBOTS_OWNER_XDG_DATA_HOME",
  "HBOTS_OWNER_XDG_CONFIG_HOME",
  "HBOTS_OWNER_XDG_CACHE_HOME",
  "HBOTS_OWNER_XDG_STATE_HOME",
] as const;

const readOwnerVariables = (): Record<string, string | undefined> =>
  Object.fromEntries(OWNER_VARIABLES.map((name) => [name, process.env[name]]));

const setOwnerVariables = (values: Record<string, string>): void => {
  for (const [name, value] of Object.entries(values)) process.env[name] = value;
};

const restoreOwnerVariables = (previous: Record<string, string | undefined>): void => {
  for (const name of OWNER_VARIABLES) {
    const value = previous[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
};

const clearOwnerVariables = (): void => {
  for (const name of OWNER_VARIABLES) delete process.env[name];
};

it.layer(NodeServices.layer)("opencodeBotIsolation", (it) => {
  it("layers the bots home, the disable flags and the per-session config over the base env", () => {
    const env = personalBotOpenCodeEnvironment({
      base: {
        PATH: "p",
        PB_SECRET_GITHUB_TOKEN: "s",
        OPENCODE_CONFIG_CONTENT: '{"mcp":{}}',
        XDG_DATA_HOME: "/home/harout/.local/share",
        XDG_CONFIG_HOME: "/home/harout/.config",
        XDG_CACHE_HOME: "/home/harout/.cache",
        XDG_STATE_HOME: "/home/harout/.local/state",
      },
      configHome: "/state/opencode-bots",
      pluginDirectory: "/state/opencode-bots/opencode/plugins/restore-owner-env",
      model: "opencode/muse-spark-1.3-contributor-free",
    });
    assert.strictEqual(env.PATH, "p");
    assert.strictEqual(env.PB_SECRET_GITHUB_TOKEN, "s");
    assert.strictEqual(env.XDG_CONFIG_HOME, "/state/opencode-bots");
    assert.strictEqual(env.HBOTS_OWNER_XDG_DATA_HOME, "/home/harout/.local/share");
    assert.strictEqual(env.HBOTS_OWNER_XDG_CONFIG_HOME, "/home/harout/.config");
    assert.strictEqual(env.HBOTS_OWNER_XDG_CACHE_HOME, "/home/harout/.cache");
    assert.strictEqual(env.HBOTS_OWNER_XDG_STATE_HOME, "/home/harout/.local/state");
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
      plugins: ["/state/opencode-bots/opencode/plugins/restore-owner-env"],
    });
  });

  it("remembers each of the owner's XDG folders for shell commands", () => {
    const env = personalBotOpenCodeEnvironment({
      base: {
        XDG_DATA_HOME: "/owner/data",
        XDG_CONFIG_HOME: "/owner/config",
        XDG_CACHE_HOME: "/owner/cache",
        XDG_STATE_HOME: "/owner/state",
      },
      configHome: "/state/opencode-bots",
      pluginDirectory: "/state/opencode-bots/opencode/plugins/restore-owner-env",
    });
    assert.strictEqual(env.XDG_CONFIG_HOME, "/state/opencode-bots");
    assert.strictEqual(env.HBOTS_OWNER_XDG_DATA_HOME, "/owner/data");
    assert.strictEqual(env.HBOTS_OWNER_XDG_CONFIG_HOME, "/owner/config");
    assert.strictEqual(env.HBOTS_OWNER_XDG_CACHE_HOME, "/owner/cache");
    assert.strictEqual(env.HBOTS_OWNER_XDG_STATE_HOME, "/owner/state");
  });

  it("an unset owner XDG value becomes empty, never the bots home", () => {
    const env = personalBotOpenCodeEnvironment({
      base: {},
      configHome: "/state/opencode-bots",
      pluginDirectory: "/state/opencode-bots/opencode/plugins/restore-owner-env",
    });
    assert.strictEqual(env.HBOTS_OWNER_XDG_CONFIG_HOME, "");
    assert.strictEqual(env.HBOTS_OWNER_XDG_DATA_HOME, "");
    assert.strictEqual(env.HBOTS_OWNER_XDG_CACHE_HOME, "");
    assert.strictEqual(env.HBOTS_OWNER_XDG_STATE_HOME, "");
  });

  it("never denies tools, and skips a model that is not provider/model", () => {
    assert.deepStrictEqual(
      JSON.parse(
        personalBotOpenCodeConfigContent({
          model: "bare",
          pluginDirectory: "/state/opencode-bots/opencode/plugins/restore-owner-env",
        }),
      ),
      {
        share: "disabled",
        autoupdate: false,
        plugins: ["/state/opencode-bots/opencode/plugins/restore-owner-env"],
      },
    );
    // A deny-everything session is what OpenCode's free tier answers with a
    // 403 "can only be used from within OpenCode", so nothing produces one.
    assert.deepStrictEqual(
      JSON.parse(
        personalBotOpenCodeConfigContent({
          model: "a/b",
          pluginDirectory: "/state/opencode-bots/opencode/plugins/restore-owner-env",
        }),
      ),
      {
        share: "disabled",
        autoupdate: false,
        small_model: "a/b",
        plugins: ["/state/opencode-bots/opencode/plugins/restore-owner-env"],
      },
    );
  });

  it.effect("writes the v2 plugin and its package.json, and rewrites them when drifted", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-oc-bots-" });
      const home = yield* ensurePersonalBotOpenCodeHome(stateDir);
      assert.strictEqual(home.configHome, path.join(stateDir, "opencode-bots"));
      assert.strictEqual(
        home.pluginDirectory,
        path.join(stateDir, "opencode-bots", "opencode", "plugins", "restore-owner-env"),
      );
      const pluginPath = path.join(home.pluginDirectory, "index.js");
      const packagePath = path.join(home.pluginDirectory, "package.json");
      const pluginSource = yield* fileSystem.readFileString(pluginPath);
      assert.include(pluginSource, 'import { Plugin } from "@opencode/plugin";');
      assert.include(pluginSource, 'ctx.shell.hook("create.before", restoreOwnerEnvironment)');
      assert.strictEqual(
        yield* fileSystem.readFileString(packagePath),
        '{"name":"hbots-restore-owner-env","type":"module","exports":"./index.js"}\n',
      );

      yield* fileSystem.writeFileString(pluginPath, "// stale");
      yield* fileSystem.writeFileString(packagePath, "{}");
      yield* ensurePersonalBotOpenCodeHome(stateDir);
      assert.strictEqual(
        yield* fileSystem.readFileString(pluginPath),
        PERSONAL_BOT_OPENCODE_ENV_PLUGIN,
      );
      assert.strictEqual(
        yield* fileSystem.readFileString(packagePath),
        '{"name":"hbots-restore-owner-env","type":"module","exports":"./index.js"}\n',
      );

      const legacyPath = path.join(
        home.configHome,
        "opencode",
        "plugin",
        "t3-restore-owner-env.js",
      );
      yield* fileSystem.makeDirectory(path.dirname(legacyPath), { recursive: true });
      yield* fileSystem.writeFileString(legacyPath, "// dead 1.x plugin");
      yield* ensurePersonalBotOpenCodeHome(stateDir);
      assert.isFalse(yield* fileSystem.exists(legacyPath));
    }).pipe(Effect.scoped),
  );

  it.effect("the plugin registers create.before and restores all four owner XDG folders", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-oc-bots-" });
      const home = yield* ensurePersonalBotOpenCodeHome(stateDir);
      yield* writeOpenCodePluginStub(home.configHome);
      const module = (yield* Effect.promise(
        // The temp dir is unique per run, so the module cache never serves a stale copy.
        () => import(NodeURL.pathToFileURL(path.join(home.pluginDirectory, "index.js")).href),
      )) as EnvPluginModule;

      assert.strictEqual(module.default?.id, "hbots.restore-owner-environment");
      const registrations: { name: string; callback: unknown }[] = [];
      yield* Effect.promise(() =>
        module.default!.setup({
          shell: {
            hook: async (name, callback) => {
              registrations.push({ name, callback });
            },
          },
        }),
      );
      assert.deepStrictEqual(
        registrations.map((registration) => registration.name),
        ["create.before"],
      );

      const hook = module.restoreOwnerEnvironment;
      assert.isFunction(hook);
      const previous = readOwnerVariables();
      const event: ShellCreateBefore = {
        command: 'echo "$XDG_CONFIG_HOME"',
        cwd: "/work",
        timeout: 30_000,
        shell: "/bin/bash",
        env: {
          XDG_DATA_HOME: "/state/opencode-bots/data",
          XDG_CONFIG_HOME: "/state/opencode-bots/config",
          XDG_CACHE_HOME: "/state/opencode-bots/cache",
          XDG_STATE_HOME: "/state/opencode-bots/state",
          HBOTS_OWNER_XDG_DATA_HOME: "/owner/data",
          HBOTS_OWNER_XDG_CONFIG_HOME: "/owner/config",
          HBOTS_OWNER_XDG_CACHE_HOME: "/owner/cache",
          HBOTS_OWNER_XDG_STATE_HOME: "/owner/state",
        },
      };
      try {
        setOwnerVariables({
          HBOTS_OWNER_XDG_DATA_HOME: "/owner/data",
          HBOTS_OWNER_XDG_CONFIG_HOME: "/owner/config",
          HBOTS_OWNER_XDG_CACHE_HOME: "/owner/cache",
          HBOTS_OWNER_XDG_STATE_HOME: "/owner/state",
        });
        hook!(event);
      } finally {
        restoreOwnerVariables(previous);
      }
      assert.deepStrictEqual(event.env, {
        XDG_DATA_HOME: "/owner/data",
        XDG_CONFIG_HOME: "/owner/config",
        XDG_CACHE_HOME: "/owner/cache",
        XDG_STATE_HOME: "/owner/state",
        HBOTS_OWNER_XDG_DATA_HOME: "",
        HBOTS_OWNER_XDG_CONFIG_HOME: "",
        HBOTS_OWNER_XDG_CACHE_HOME: "",
        HBOTS_OWNER_XDG_STATE_HOME: "",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("the hook empties an owner XDG value that was unset", () =>
    Effect.gen(function* () {
      const module = yield* importTemplatePlugin(
        yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({ prefix: "t3-oc-bots-" }),
      );
      const hook = module.restoreOwnerEnvironment;
      assert.isFunction(hook);
      const previous = readOwnerVariables();
      const event: ShellCreateBefore = {
        command: "env",
        cwd: "/work",
        timeout: 30_000,
        shell: "/bin/bash",
        env: { XDG_CONFIG_HOME: "/state/opencode-bots" },
      };
      try {
        clearOwnerVariables();
        hook!(event);
      } finally {
        restoreOwnerVariables(previous);
      }
      assert.deepStrictEqual(event.env, {
        XDG_CONFIG_HOME: "",
        XDG_DATA_HOME: "",
        XDG_CACHE_HOME: "",
        XDG_STATE_HOME: "",
        HBOTS_OWNER_XDG_CONFIG_HOME: "",
        HBOTS_OWNER_XDG_DATA_HOME: "",
        HBOTS_OWNER_XDG_CACHE_HOME: "",
        HBOTS_OWNER_XDG_STATE_HOME: "",
      });
    }).pipe(Effect.scoped),
  );
});
