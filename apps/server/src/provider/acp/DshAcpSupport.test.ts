// @effect-diagnostics preferSchemaOverJson:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as YAML from "yaml";

import { ServerConfig } from "../../config.ts";
import { botProtectedPaths } from "../../personal/secrets/botProtectedPaths.ts";
import {
  buildDshEnvironment,
  buildDshLaunchPatch,
  parseDshResumeCursor,
  resolveDshDenyPlugin,
  resolveDshRuntime,
  resolveDshSessionMode,
  resolveDshSkillDirs,
  serializeDshLaunchPatch,
  escapeDshPersonaText,
  DSH_PLUGIN_INVENTORY_ROW_ID,
  DSH_SESSION_LOG_ROW_ID,
  DSH_TELEMETRY_ROW_ID,
  DSH_WEB_SEARCH_ROW_ID,
} from "./DshAcpSupport.ts";

const decodeResumeCursor = Schema.decodeUnknownSync(Schema.Unknown);

const layer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-dsh-support-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const rowIds = (patch: ReadonlyArray<Record<string, unknown>>): string[] =>
  patch.flatMap((row) => (typeof row.id === "string" ? [row.id] : []));

it.layer(layer)("DshAcpSupport", (it) => {
  it.effect("writes a patch that never uploads the session log", () =>
    Effect.sync(() => {
      const patch = buildDshLaunchPatch({
        personaSuffix: "hello",
        skillDirs: ["/skills"],
        mode: "standard",
      });
      const ids = rowIds(patch);
      expect(ids).toContain(DSH_SESSION_LOG_ROW_ID);
      expect(ids).toContain(DSH_TELEMETRY_ROW_ID);
      expect(ids).toContain(DSH_WEB_SEARCH_ROW_ID);
      // The plugin inventory dsh otherwise sends with every request.
      expect(ids).toContain(DSH_PLUGIN_INVENTORY_ROW_ID);
      const sessionLog = patch.find((row) => row.id === DSH_SESSION_LOG_ROW_ID);
      expect(sessionLog?.config).toEqual({ enabled: false });
      expect(patch.find((row) => row.id === DSH_TELEMETRY_ROW_ID)?.disabled).toBe(true);
      expect(patch.find((row) => row.id === DSH_WEB_SEARCH_ROW_ID)?.disabled).toBe(true);
      expect(patch.find((row) => row.id === DSH_PLUGIN_INVENTORY_ROW_ID)?.config).toEqual({
        enabled: false,
      });
      // Flash only: never Pro, never an alias that could resolve to it.
      const flashRows = patch.filter(
        (row) =>
          typeof row.config === "object" &&
          row.config !== null &&
          (row.config as Record<string, unknown>).model !== undefined,
      );
      expect(flashRows.length).toBe(2);
      for (const row of flashRows) {
        expect((row.config as Record<string, unknown>).model).toBe("deepseek-flash");
      }
      // `web_fetch` stays on, `web_search` off.
      expect(patch.find((row) => row.id === "tool-web")?.config).toEqual({
        search: false,
        fetch: true,
      });
    }),
  );

  it.effect("round-trips through a YAML loader, quotes and colons included", () =>
    Effect.sync(() => {
      const persona = 'Bot #1: "quoted" & <tags>\n- list: item\nkey: value # not a comment';
      const text = serializeDshLaunchPatch({
        personaSuffix: persona,
        skillDirs: ["C:/skills one", "C:/two"],
        mode: "standard",
      });
      const parsed = YAML.parse(text) as Array<Record<string, unknown>>;
      const systemPrompt = parsed.find((row) => row.id === "system-prompt");
      expect(systemPrompt?.config).toMatchObject({ personaSuffix: persona });
      const skills = parsed.find((row) => row.id === "skill-filesystem");
      expect(skills?.config).toMatchObject({
        includeDefaultRoots: false,
        customSkillDirs: ["C:/skills one", "C:/two"],
      });
    }),
  );

  it.effect("escapes every {{ a bot could write, so dsh never resolves it", () =>
    Effect.sync(() => {
      const escaped = escapeDshPersonaText("Use {{cwd}} and {{model}} here");
      expect(escaped).not.toContain("{{");
      expect(escaped).toContain("\u200b");
      // dsh's own placeholders in the prefix are untouched (they are ours).
      const patch = buildDshLaunchPatch({
        personaSuffix: "{{nope}}",
        skillDirs: [],
        mode: "standard",
      });
      const config = patch.find((row) => row.id === "system-prompt")?.config as Record<
        string,
        unknown
      >;
      expect(config.personaSuffix).toBe("{\u200b{nope}}");
      expect(config.personaPrefix).toContain("{{model}}");
    }),
  );

  it.effect("adds the mode rows only for the mode asked for", () =>
    Effect.sync(() => {
      const code = buildDshLaunchPatch({ personaSuffix: "", skillDirs: [], mode: "code" });
      expect(code.find((row) => row.id === "tools")?.config).toEqual({ mode: "ptc" });
      const minimal = buildDshLaunchPatch({ personaSuffix: "", skillDirs: [], mode: "minimal" });
      expect(minimal.find((row) => row.id === "tool-pwsh")?.disabled).toBe(true);
      expect(minimal.find((row) => row.id === "tool-skill")?.disabled).toBe(true);
      const inserted = minimal.find((row) => Array.isArray(row.insert))?.insert as Array<
        Record<string, unknown>
      >;
      expect(inserted.map((row) => row.id)).toEqual(["pty", "terminal-pwsh", "persistent-pwsh"]);
      const standard = buildDshLaunchPatch({
        personaSuffix: "",
        skillDirs: [],
        mode: "standard",
      });
      expect(rowIds(standard)).not.toContain("tools");
    }),
  );

  it.effect("loads the deny plugin in every mode, gated by the kill switch", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const deny = yield* resolveDshDenyPlugin({
        runtimeDir: path.resolve("C:/runtimes/dsh-0.2.0-rc.2"),
        paths: { secretsDir: "C:/root/userdata/secrets", dbPath: "C:/root/userdata/state.sqlite" },
        dshHome: "C:/root/userdata/dsh",
        enabled: true,
      });
      expect(deny?.pluginUrl.startsWith("file:///")).toBe(true);
      expect(deny?.pluginUrl).toContain("hbots-deny-plugin.mjs");
      expect(deny?.denyReadWrite).toEqual(["C:/root/userdata/secrets"]);
      expect(deny?.denyWrite).toEqual([
        "C:/root/userdata/state.sqlite",
        "C:/root/userdata/state.sqlite-wal",
        "C:/root/userdata/state.sqlite-shm",
        "C:/root/userdata/state.sqlite-journal",
        "C:/root/userdata/dsh",
      ]);
      const patch = buildDshLaunchPatch({
        personaSuffix: "",
        skillDirs: [],
        mode: "minimal",
        deny,
      });
      const inserted = patch.find((row) => Array.isArray(row.insert))?.insert as Array<
        Record<string, unknown>
      >;
      expect(inserted[0]).toMatchObject({ id: "hbots-deny", name: deny?.pluginUrl });
      expect(inserted.map((row) => row.id)).toEqual([
        "hbots-deny",
        "pty",
        "terminal-pwsh",
        "persistent-pwsh",
      ]);
      // The kill switch removes the row entirely.
      const disabled = yield* resolveDshDenyPlugin({
        runtimeDir: path.resolve("C:/runtimes/dsh-0.2.0-rc.2"),
        paths: { secretsDir: "C:/secrets", dbPath: "C:/state.sqlite" },
        dshHome: "C:/dsh",
        enabled: false,
      });
      expect(disabled).toBeUndefined();
      const noDeny = buildDshLaunchPatch({
        personaSuffix: "",
        skillDirs: [],
        mode: "standard",
      });
      expect(noDeny.some((row) => Array.isArray(row.insert))).toBe(false);
    }),
  );

  it.effect("strips every other provider's credential and keeps exactly one key", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const environment = yield* buildDshEnvironment({
        instanceEnv: {
          Path: "C:/Windows",
          PATH: "C:/Windows",
          ANTHROPIC_AUTH_TOKEN: "test-key-value",
          ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
          ANTHROPIC_MODEL: "deepseek-flash[1m]",
          CLAUDE_CODE_AUTO_COMPACT_WINDOW: "786432",
          CLAUDE_CONFIG_DIR: "C:/claude",
          DEEPSEEK_API_KEY: "stale",
          PB_SECRET_SOMETHING: "placeholder",
          OPENAI_API_KEY: "other-provider",
          CODEX_HOME: "C:/codex",
          T3_MCP_TOKEN: "mcp-token",
          DSH_HOME: "C:/elsewhere",
        },
        runtimeMode: "full-access",
        dshHome: "C:/root/userdata/dsh",
      }).pipe(Effect.provideService(Path.Path, path));
      const names = Object.keys(environment);
      expect(names.filter((name) => name.toUpperCase().startsWith("ANTHROPIC_"))).toEqual([]);
      expect(names.filter((name) => name.startsWith("PB_SECRET_"))).toEqual([]);
      expect(names.filter((name) => name.startsWith("CLAUDE"))).toEqual([]);
      expect(names.filter((name) => name.startsWith("DEEPSEEK_"))).toEqual(["DEEPSEEK_API_KEY"]);
      expect(names.filter((name) => name === "OPENAI_API_KEY")).toEqual([]);
      // Exactly one credential-shaped variable, and it is the instance's key.
      const credentialShaped = names.filter((name) => /KEY|PASSWORD|SECRET|TOKEN/i.test(name));
      expect(credentialShaped).toEqual(["DEEPSEEK_API_KEY"]);
      expect(environment.DEEPSEEK_API_KEY).toBe("test-key-value");
      // Case-insensitive de-duplication: one PATH, and never both spellings.
      expect(names.filter((name) => name.toUpperCase() === "PATH")).toHaveLength(1);
      expect(environment.DSH_HOME).toBe("C:/root/userdata/dsh");
      expect(environment.DSH_TELEMETRY_DISABLED).toBe("1");
      expect(environment.DSH_TELEMETRY_MODE).toBe("DISABLED");
      expect(environment.DSH_PERMISSION_MODE).toBe("danger-full-access");
      expect(environment.DSH_AGENTS_HOME).toBe(path.join("C:/root/userdata/dsh", "agents-home"));
      const sandboxed = yield* buildDshEnvironment({
        instanceEnv: {},
        runtimeMode: "auto",
        dshHome: "C:/root/userdata/dsh",
      }).pipe(Effect.provideService(Path.Path, path));
      expect(sandboxed.DSH_PERMISSION_MODE).toBe("workspace-write");
      expect(sandboxed.DEEPSEEK_API_KEY).toBeUndefined();
    }),
  );

  it.effect("an instance override spelled differently still wins, as one name", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      // Windows users write PATH in caps; the machine spells it Path. The
      // instance's value must not be dropped for spelling a name differently,
      // and the child must still see exactly one name.
      const environment = yield* buildDshEnvironment({
        instanceEnv: {
          Path: "C:/Windows",
          PATH: "C:/Windows;C:/tools",
          TEMP: "C:/machine-temp",
          Temp: "C:/instance-temp",
        },
        runtimeMode: "full-access",
        dshHome: "C:/root/userdata/dsh",
      }).pipe(Effect.provideService(Path.Path, path));
      const names = Object.keys(environment);
      expect(names.filter((name) => name.toUpperCase() === "PATH")).toEqual(["Path"]);
      expect(environment.Path).toBe("C:/Windows;C:/tools");
      expect(names.filter((name) => name.toUpperCase() === "TEMP")).toEqual(["TEMP"]);
      expect(environment.TEMP).toBe("C:/instance-temp");
      // Whatever else happens, no two names may differ only in case: that is
      // the shape PowerShell 5.1's environment provider refuses.
      const normalised = names.map((name) => name.toUpperCase());
      expect(new Set(normalised).size).toBe(normalised.length);
    }),
  );

  it.effect("reads a dsh cursor, and pins the mode a session was started in", () =>
    Effect.sync(() => {
      const cursor = decodeResumeCursor({
        schemaVersion: 1,
        engine: "dsh",
        resume: "abc",
        mode: "code",
      });
      const parsed = parseDshResumeCursor(cursor);
      expect(parsed._tag).toBe("Some");
      // A Claude cursor is not a dsh cursor, and never an error here.
      expect(parseDshResumeCursor({ resume: "b1ef3808" })._tag).toBe("None");
      expect(parseDshResumeCursor("b1ef3808")._tag).toBe("None");
      expect(parseDshResumeCursor(undefined)._tag).toBe("None");
      // A cursor's mode wins: a resumed Standard session cannot run as Code.
      expect(
        resolveDshSessionMode({
          cursor: { engine: "dsh", resume: "abc", mode: "standard" },
          requested: "code",
        }),
      ).toEqual({ mode: "standard", pinned: true });
      expect(
        resolveDshSessionMode({
          cursor: { engine: "dsh", resume: "abc" },
          requested: "minimal",
        }),
      ).toEqual({ mode: "minimal", pinned: false });
      expect(resolveDshSessionMode({ cursor: undefined, requested: undefined })).toEqual({
        mode: "standard",
        pinned: false,
      });
      expect(resolveDshSessionMode({ cursor: undefined, requested: "nonsense" })).toEqual({
        mode: "standard",
        pinned: false,
      });
    }),
  );

  it.effect("resolves the pinned runtime, and an instance's own path", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const pinned = yield* resolveDshRuntime({ dshRuntimePath: "" });
      expect(pinned.version).toBe("0.2.0-rc.2");
      expect(pinned.runtimeDir.replace(/\\/g, "/")).toContain(
        "/.personal-bots/runtimes/dsh-0.2.0-rc.2",
      );
      expect(
        pinned.binJs.replace(/\\/g, "/").endsWith("/node_modules/@deepseek-ai/dsh/lib/bin.js"),
      ).toBe(true);
      const custom = yield* resolveDshRuntime({ dshRuntimePath: "C:/runtimes/custom" });
      expect(custom.runtimeDir).toBe(path.resolve("C:/runtimes/custom"));
    }),
  );

  it.effect("names the bot's skill folders, and only the bot's", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-dsh-skills-" });
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-dsh-cwd-" });
      const shared = path.join(baseDir, "bot-plugins", "_shared", ".claude", "skills");
      const own = path.join(baseDir, "bot-plugins", "bot-one", ".claude", "skills");
      const other = path.join(baseDir, "bot-plugins", "bot-two", ".claude", "skills");
      const workspace = path.join(cwd, ".agents", "skills");
      for (const dir of [shared, own, other, workspace]) {
        yield* fileSystem.makeDirectory(dir, { recursive: true });
      }
      for (const [plugin, skills] of [
        ["_shared", "./.claude/skills/"],
        ["bot-one", "./.claude/skills/"],
        ["bot-two", "./.claude/skills/"],
      ] as const) {
        yield* fileSystem.makeDirectory(
          path.join(baseDir, "bot-plugins", plugin, ".claude-plugin"),
          { recursive: true },
        );
        yield* fileSystem.writeFileString(
          path.join(baseDir, "bot-plugins", plugin, ".claude-plugin", "plugin.json"),
          JSON.stringify({ name: plugin, skills }),
        );
      }
      const dirs = yield* resolveDshSkillDirs({ baseDir, botId: "bot-one", cwd });
      expect(dirs).toContain(path.resolve(shared));
      expect(dirs).toContain(path.resolve(own));
      expect(dirs).toContain(path.resolve(workspace));
      expect(dirs).not.toContain(path.resolve(other));
      // An unknown bot (or a bogus id) gets the shared folder only.
      const noBot = yield* resolveDshSkillDirs({ baseDir, botId: "../escape", cwd });
      expect(noBot).toContain(path.resolve(shared));
      expect(noBot).not.toContain(path.resolve(other));
    }),
  );

  it.effect("keeps the deny paths the server's own rule keeps", () =>
    Effect.sync(() => {
      const config = ServerConfig;
      void config;
      const protectedPaths = botProtectedPaths({
        stateDir: "C:/root/userdata",
        dbPath: "C:/root/userdata/state.sqlite",
        secretsDir: "C:/root/userdata/secrets",
        logsDir: "C:/root/userdata/logs",
      });
      expect(protectedPaths).toEqual([
        { path: "C:/root/userdata/secrets", kind: "dir", access: "read-write" },
        { path: "C:/root/userdata/state.sqlite", kind: "file", access: "write" },
        { path: "C:/root/userdata/state.sqlite-wal", kind: "file", access: "write" },
        { path: "C:/root/userdata/state.sqlite-shm", kind: "file", access: "write" },
        { path: "C:/root/userdata/state.sqlite-journal", kind: "file", access: "write" },
      ]);
    }),
  );
});
