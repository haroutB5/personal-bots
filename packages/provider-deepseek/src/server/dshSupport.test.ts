import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { botProtectedPaths } from "@t3tools/provider-core/server/botProtectedPaths";

import {
  buildDshEnvironment,
  buildDshLaunchPatch,
  buildDshPersona,
  escapeDshPersonaText,
  makeDshColonStubber,
  makeDshReplyStripper,
  parseDshResumeCursor,
  resolveDshEffort,
  resolveDshSessionMode,
  serializeDshLaunchPatch,
  DSH_COLON_STUB_MAX_LENGTH,
  DSH_PINNED_VERSION,
  DSH_PLUGIN_INVENTORY_ROW_ID,
  DSH_SESSION_LOG_ROW_ID,
  DSH_TELEMETRY_ROW_ID,
  DSH_WEB_DEEPSEEK_API_ROW_ID,
  DSH_WEB_SEARCH_ROW_ID,
  DSH_WORKING_DIRECTORY_TOOL_ROW_ID,
} from "./dshSupport.ts";
import { resolveDshDenyPlugin, resolveDshRuntime, resolveDshSkillDirs } from "./dshRuntime.ts";

const rowIds = (patch: ReadonlyArray<Record<string, unknown>>): string[] =>
  patch.flatMap((row) => (typeof row.id === "string" ? [row.id] : []));

it.layer(NodeServices.layer)("DshSupport", (it) => {
  it.effect("writes the whole launch patch, privacy rows and order included", () =>
    Effect.sync(() => {
      const patch = buildDshLaunchPatch({
        personaSuffix: "p",
        skillDirs: ["/s"],
        mode: "standard",
      });
      // One literal, in order: a missing privacy row fails here instead of
      // shipping a launch that uploads the session log.
      expect(patch).toEqual([
        {
          id: "acp",
          config: { provider: "deepseek-official", model: "deepseek-flash" },
        },
        {
          id: "agent-default-model",
          config: {
            provider: "deepseek-official",
            model: "deepseek-flash",
            reasoningEffort: "high",
          },
        },
        {
          id: "system-prompt",
          config: {
            personaPrefix: "You are a coding agent powered by the {{model}} model.",
            personaSuffix: "p",
          },
        },
        {
          id: "skill-filesystem",
          config: { includeDefaultRoots: false, customSkillDirs: ["/s"] },
        },
        { id: DSH_TELEMETRY_ROW_ID, disabled: true },
        { id: DSH_SESSION_LOG_ROW_ID, config: { enabled: false } },
        { id: DSH_WEB_SEARCH_ROW_ID, disabled: true },
        { id: DSH_WEB_DEEPSEEK_API_ROW_ID, disabled: true },
        { id: DSH_WORKING_DIRECTORY_TOOL_ROW_ID, disabled: true },
        { id: DSH_PLUGIN_INVENTORY_ROW_ID, config: { enabled: false } },
        { id: "web", config: { fetchProvider: "http" } },
        { id: "tool-web", config: { search: false, fetch: true } },
      ]);
      // The five rows the whole privacy story rests on, named from the patch.
      expect(patch[5]).toEqual({ id: "session-log-deepseek", config: { enabled: false } });
      expect(patch[6]).toEqual({ id: "web-search-deepseek", disabled: true });
      expect(patch[7]).toEqual({ id: "web-deepseek-api", disabled: true });
      expect(patch[8]).toEqual({ id: "tool-working-directory", disabled: true });
      expect(patch[9]).toEqual({
        id: "plugin-package-inventory-deepseek",
        config: { enabled: false },
      });
      // `web_fetch` stays on, `web_search` off.
      expect(patch.find((row) => row.id === "tool-web")?.config).toEqual({
        search: false,
        fetch: true,
      });
    }),
  );

  it.effect("round-trips a persona through JSON, quotes and backslashes included", () =>
    Effect.sync(() => {
      const persona =
        'Bot #1: "quoted" path C:\\skills\\one and a \\ alone; key: value # not a comment';
      const text = serializeDshLaunchPatch({
        personaSuffix: persona,
        skillDirs: ["C:/skills one", "C:/two"],
        mode: "standard",
      });
      const parsed = JSON.parse(text) as Array<Record<string, unknown>>;
      const systemPrompt = parsed.find((row) => row.id === "system-prompt");
      expect(systemPrompt?.config).toEqual({
        personaPrefix: "You are a coding agent powered by the {{model}} model.",
        personaSuffix: persona,
      });
      const skills = parsed.find((row) => row.id === "skill-filesystem");
      expect(skills?.config).toEqual({
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

  it.effect("carries the dsh-only reply style, then the bot's own block", () =>
    Effect.sync(() => {
      const runtimeInstructions = "You are Builder.\n\n# Runtime\nWork in the repo.";
      const persona = buildDshPersona("Be brief.", runtimeInstructions);
      expect(persona.startsWith(runtimeInstructions)).toBe(true);
      expect(persona).toContain("<reply_style>");
      expect(persona).toContain("Your thinking is hidden from the user");
      expect(persona).toContain(
        "Before a tool call, write one complete sentence saying what you found or what you are about to do",
      );
      expect(persona).toContain("Never end a message with a colon");
      // The bot's own block still comes last, after the reply style.
      expect(persona.indexOf("<reply_style>")).toBeLessThan(persona.indexOf("<bot_instructions>"));
      expect(persona).toContain("<bot_instructions>Be brief.</bot_instructions>");
      // A bot with no instructions still gets it, and it appears once.
      expect(buildDshPersona(undefined, runtimeInstructions)).toContain("<reply_style>");
      expect(persona.split("<reply_style>")).toHaveLength(2);
    }),
  );

  it.effect("adds the mode rows only for the mode asked for", () =>
    Effect.sync(() => {
      const code = buildDshLaunchPatch({ personaSuffix: "", skillDirs: [], mode: "code" });
      expect(code).toHaveLength(13);
      expect(code.slice(0, 12)).toEqual(
        buildDshLaunchPatch({ personaSuffix: "", skillDirs: [], mode: "standard" }),
      );
      expect(code[12]).toEqual({ id: "tools", config: { mode: "ptc" } });

      const minimal = buildDshLaunchPatch({ personaSuffix: "", skillDirs: [], mode: "minimal" });
      expect(rowIds(minimal)).toEqual([
        "acp",
        "agent-default-model",
        "system-prompt",
        "skill-filesystem",
        "session-telemetry-otel",
        "session-log-deepseek",
        "web-search-deepseek",
        "web-deepseek-api",
        "tool-working-directory",
        "plugin-package-inventory-deepseek",
        "web",
        "tool-web",
        "tool-pwsh",
        "tool-bash",
        "tool-fs",
        "tool-fs-search",
        "tool-jobs",
        "tool-skill",
        "tool-subagent",
        "tool-subagent-fork",
        "tool-subagent-control",
        "tool-subagent-list-agents",
        "tool-workflow",
        "tool-goal",
        "tool-todo",
        "tool-web",
        "plan-mode",
      ]);
      // The 15 named rows, in order, each one disabled.
      expect(minimal.slice(12, 27)).toEqual([
        { id: "tool-pwsh", disabled: true },
        { id: "tool-bash", disabled: true },
        { id: "tool-fs", disabled: true },
        { id: "tool-fs-search", disabled: true },
        { id: "tool-jobs", disabled: true },
        { id: "tool-skill", disabled: true },
        { id: "tool-subagent", disabled: true },
        { id: "tool-subagent-fork", disabled: true },
        { id: "tool-subagent-control", disabled: true },
        { id: "tool-subagent-list-agents", disabled: true },
        { id: "tool-workflow", disabled: true },
        { id: "tool-goal", disabled: true },
        { id: "tool-todo", disabled: true },
        { id: "tool-web", disabled: true },
        { id: "plan-mode", disabled: true },
      ]);
      // The three pty rows ride in one insert row, in order.
      expect(minimal[27]).toEqual({
        insert: [
          { id: "pty", name: "@deepseek-ai/dsh-terminal" },
          {
            id: "terminal-pwsh",
            name: "@deepseek-ai/dsh-terminal-bash",
            config: { shellDialect: "pwsh", timeoutMs: 300000 },
          },
          {
            id: "persistent-pwsh",
            name: "@deepseek-ai/dsh-tool-pwsh-persistent",
            config: { timeoutMs: 300000 },
          },
        ],
      });
      // The cwd tool is off in every mode, Minimal included.
      for (const mode of ["standard", "code", "minimal"] as const) {
        const patch = buildDshLaunchPatch({ personaSuffix: "", skillDirs: [], mode });
        expect(patch.find((row) => row.id === DSH_WORKING_DIRECTORY_TOOL_ROW_ID)?.disabled).toBe(
          true,
        );
      }
    }),
  );

  it.effect("loads the deny plugin in every mode, gated by the kill switch", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const deny = yield* resolveDshDenyPlugin({
        runtimeDir: path.resolve("C:/runtimes/dsh-0.2.1-rc.3"),
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
      expect(inserted[0]).toEqual({
        id: "hbots-deny",
        name: deny?.pluginUrl,
        config: {
          denyReadWrite: ["C:/root/userdata/secrets"],
          denyWrite: [
            "C:/root/userdata/state.sqlite",
            "C:/root/userdata/state.sqlite-wal",
            "C:/root/userdata/state.sqlite-shm",
            "C:/root/userdata/state.sqlite-journal",
            "C:/root/userdata/dsh",
          ],
        },
      });
      expect(inserted.map((row) => row.id)).toEqual([
        "hbots-deny",
        "pty",
        "terminal-pwsh",
        "persistent-pwsh",
      ]);
      // The kill switch removes the row entirely.
      const disabled = yield* resolveDshDenyPlugin({
        runtimeDir: path.resolve("C:/runtimes/dsh-0.2.1-rc.3"),
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
      });
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
      });
      expect(sandboxed.DSH_PERMISSION_MODE).toBe("workspace-write");
      expect(sandboxed.DEEPSEEK_API_KEY).toBeUndefined();
    }),
  );

  it.effect("an instance override spelled differently still wins, as one name", () =>
    Effect.gen(function* () {
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
      });
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
      const cursor = parseDshResumeCursor({
        schemaVersion: 1,
        engine: "dsh",
        resume: "abc",
        mode: "code",
      });
      expect(cursor._tag).toBe("Some");
      // The literal round trip the adapter reads: `r`, in `code` mode.
      const literal = parseDshResumeCursor({ engine: "dsh", resume: "r", mode: "code" });
      if (Option.isNone(literal)) throw new Error("expected a dsh cursor");
      expect(literal.value.resume).toBe("r");
      expect(literal.value.mode).toBe("code");
      // A Claude cursor is not a dsh cursor, and never an error here.
      expect(parseDshResumeCursor({ engine: "claude", resume: "x" })._tag).toBe("None");
      expect(parseDshResumeCursor({ resume: "b1ef3808" })._tag).toBe("None");
      expect(parseDshResumeCursor("b1ef3808")._tag).toBe("None");
      expect(parseDshResumeCursor(undefined)._tag).toBe("None");
      // A cursor's mode wins: a resumed Standard session cannot run as Code.
      expect(
        resolveDshSessionMode({
          cursor: { engine: "dsh", resume: "r", mode: "code" },
          requested: "standard",
        }),
      ).toEqual({ mode: "code", pinned: true });
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

  it.effect("maps the selection's effort onto dsh's four values", () =>
    Effect.sync(() => {
      expect(resolveDshEffort({ options: [{ id: "effort", value: "xhigh" }] })).toBe("max");
      expect(resolveDshEffort({ options: [{ id: "effort", value: "low" }] })).toBe("low");
      expect(resolveDshEffort({ options: [{ id: "effort", value: "medium" }] })).toBe("high");
      expect(resolveDshEffort({ options: [{ id: "effort", value: "max" }] })).toBe("max");
      expect(resolveDshEffort({ options: [] })).toBe("high");
      expect(resolveDshEffort(undefined)).toBe("high");
      expect(resolveDshEffort({ options: [{ id: "model", value: "xhigh" }] })).toBe("high");
    }),
  );

  it.effect("resolves the pinned runtime, and an instance's own path", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const pinned = yield* resolveDshRuntime({ dshRuntimePath: "" });
      expect(pinned.version).toBe(DSH_PINNED_VERSION);
      expect(pinned.runtimeDir.replace(/\\/g, "/")).toContain(
        `/.personal-bots/runtimes/dsh-${DSH_PINNED_VERSION}`,
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

  /**
   * The live leaked sample: a normal reply followed by three stray closing
   * tags at thread f32abe85, 2026-10-15T23:32:59Z. The opening tags and
   * arguments had already been consumed.
   */
  const DSML_MARKER = "\uFF5C\uFF5CDSML\uFF5C\uFF5C";
  const leakedMarkup = [
    `</${DSML_MARKER} parameter>`,
    `</${DSML_MARKER} invoke>`,
    `</${DSML_MARKER} calls>`,
  ].join("\n");
  const leakedBody = [
    "I could not place a real call or open a live Gemini socket.",
    "",
    "```choices",
    "Fold S1-S3 into 1.66.54 before ship",
    "Carry S1-S3 into the next release",
    "Give me S1's one-line fix in the notes",
    "```",
  ].join("\n");
  const leakedReply = `${leakedBody}\n\n${leakedMarkup}\n`;

  const openTag = (name: string): string => `<${DSML_MARKER} ${name}>`;
  const closeTag = (name: string): string => `</${DSML_MARKER} ${name}>`;

  /** Feeds a reply to one stripper and collects what a chat would have seen. */
  const stripReply = (
    chunks: ReadonlyArray<string>,
  ): { readonly text: string; readonly tools: ReadonlyArray<string> } => {
    const stripper = makeDshReplyStripper();
    let text = "";
    const tools: string[] = [];
    for (const chunk of chunks) {
      const piece = stripper.push(chunk);
      text += piece.text;
      tools.push(...piece.tools);
    }
    const rest = stripper.flush();
    return { text: text + rest.text, tools: [...tools, ...rest.tools] };
  };

  it("strips the leaked sample, and leaves the reply it was hiding behind", () => {
    // The sample really is the DB row's string: `<`, `/`, then the bars.
    expect(leakedMarkup.split("\n")[0]).toBe(
      "\u003C\u002F\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter\u003E",
    );
    const { text, tools } = stripReply([leakedReply]);
    expect(text).toBe(`${leakedBody}\n`);
    expect(text).not.toContain("DSML");
    expect(text).toContain("```choices");
    // Stray closing tags named no tool.
    expect(tools).toEqual([]);
  });

  it("strips a tag split across two or three deltas, whatever the boundary", () => {
    const whole = stripReply([leakedReply]).text;
    for (let cut = 1; cut < leakedReply.length; cut += 1) {
      expect(stripReply([leakedReply.slice(0, cut), leakedReply.slice(cut)]).text).toBe(whole);
    }
    const compact = `Done.\n\n${leakedMarkup}\n`;
    const compactWhole = stripReply([compact]).text;
    for (let first = 1; first < compact.length; first += 1) {
      for (let second = first + 1; second < compact.length; second += 1) {
        const chunks = [
          compact.slice(0, first),
          compact.slice(first, second),
          compact.slice(second),
        ];
        expect(stripReply(chunks).text).toBe(compactWhole);
      }
    }
  });

  it("removes a whole block, keeps the text around it and reports the tool", () => {
    const reply =
      `Before.${openTag("tool_calls")}\n` +
      `${openTag('invoke name="web_search"')}\n` +
      `${openTag('parameter name="query"')}tennis scores${closeTag("parameter")}\n` +
      `${closeTag("invoke")}\n${closeTag("tool_calls")}After.`;
    const inline = stripReply([reply]);
    expect(inline.text).toBe("Before.After.");
    // The tool the block carried is named once; its arguments never are.
    expect(inline.tools).toEqual(["web_search"]);
    expect(inline.text).not.toContain("tennis scores");
    expect(inline.text).not.toContain("DSML");

    const multiline = stripReply([
      `Before.\n${openTag("tool_calls")}\n${openTag('invoke name="read_file"')}\n` +
        `${openTag('parameter name="path"')}C:/secrets/key.txt${closeTag("parameter")}\n` +
        `${closeTag("invoke")}\n${closeTag("tool_calls")}\nAfter.\n`,
    ]);
    expect(multiline.text).not.toContain("DSML");
    expect(multiline.text).not.toContain("secrets/key.txt");
    expect(multiline.text).toContain("Before.");
    expect(multiline.text).toContain("After.");
  });

  it("drops an opening tag whose block never closed, and still names its tool", () => {
    const reply =
      `Before.\n${openTag("tool_calls")}\n${openTag('invoke name="read_file"')}\n` +
      `${openTag('parameter name="path"')}C:/secrets/key.txt\n`;
    const { text, tools } = stripReply([reply]);
    expect(text).toBe("Before.\n");
    expect(tools).toEqual(["read_file"]);
    expect(text).not.toContain("key.txt");
  });

  it("leaves code fences, lookalikes and the bot's own angle brackets alone", () => {
    const reply = [
      "The adapter strips DSML tags out of a dsh reply (see `DeepSeekDshAdapter`).",
      "",
      "```text",
      "<||DSML|| parameter>",
      "<| DSML | parameter>",
      `<${"\uFF5C\uFF5C"}DSML parameter>`,
      "a < b and a > b, <bot_instructions>x</bot_instructions>",
      "```",
      "",
      "Done.",
    ].join("\n");
    const { text, tools } = stripReply([reply]);
    expect(text).toBe(reply);
    expect(tools).toEqual([]);
  });

  it("passes a reply with no markup through byte for byte, at any chunk size", () => {
    const reply =
      'Line one.\n\n```ts\nconst small = 1 < 2;\nconst tag = "<reply_style>";\n```\n\n' +
      "<reply_style>Done.</reply_style>\n";
    expect(stripReply([reply]).text).toBe(reply);
    for (const size of [1, 2, 3, 5, 7, 13, 64]) {
      const chunks: string[] = [];
      for (let at = 0; at < reply.length; at += size) chunks.push(reply.slice(at, at + size));
      expect(stripReply(chunks).text).toBe(reply);
    }
  });

  it("lets a trailing `<` through, and drops a marker cut short at the turn's end", () => {
    expect(stripReply(["a <"]).text).toBe("a <");
    expect(stripReply(["a </"]).text).toBe("a </");
    expect(stripReply([`a <${DSML_MARKER}`]).text).toBe("a ");
  });

  /**
   * Feeds visible text to one stubber, settling the step at `toolCallAfter`
   * ("every" by default). The turn's end shows whatever is still held.
   */
  const stubReply = (
    chunks: ReadonlyArray<string>,
    toolCallAfter: number | "every" | "none" = "every",
  ): { readonly shown: string; readonly atTurnEnd: string } => {
    const stubber = makeDshColonStubber();
    let shown = "";
    chunks.forEach((chunk, index) => {
      shown += stubber.push(chunk);
      const settles =
        toolCallAfter === "every" || (toolCallAfter !== "none" && index === toolCallAfter);
      if (settles) shown += stubber.closeByToolCall();
    });
    return { shown, atTurnEnd: shown + stubber.flush() };
  };

  it("turns a stub line's colon into a full stop when a tool call closes the step", () => {
    // The live shapes from the 2026-10-16 re-measure: a short step that ends
    // with `:` immediately before a call ("Now the provider:").
    for (const stub of ["Now the provider:", "Let me read the file:", "Checking the tests:"]) {
      expect(stubReply([stub]).shown).toBe(`${stub.slice(0, -1)}.`);
    }
    // Only the step's last colon goes, and the blanks after it stay put.
    expect(stubReply(["Wait: really:"]).shown).toBe("Wait: really.");
    expect(stubReply(["Now the provider:\n"]).shown).toBe("Now the provider.\n");
  });

  it("settles a colon that arrives alone in its own delta, at any boundary", () => {
    const whole = "Now the provider:";
    expect(stubReply(["Now the provider", ":"]).shown).toBe("Now the provider.");
    for (let cut = 1; cut < whole.length; cut += 1) {
      expect(stubReply([whole.slice(0, cut), whole.slice(cut)], 1).shown).toBe("Now the provider.");
    }
    // The colon can be the whole delta, one character on its own.
    expect(stubReply([...whole], whole.length - 1).shown).toBe("Now the provider.");
  });

  it("keeps the colon when the turn ends on it, or when more text follows", () => {
    // A list intro or a line that ends the turn keeps its colon.
    expect(stubReply(["Options:"], "none")).toEqual({
      shown: "Options",
      atTurnEnd: "Options:",
    });
    // A colon with text after it was never a stub line's ending.
    expect(stubReply(["Options:", " a, b"], "none").shown).toBe("Options: a, b");
  });

  it("leaves a colon that is not a stub line's ending alone", () => {
    // A colon inside the line: a time, a URL, an ordinary intro.
    for (const line of ["Started at 10:30", "See https://example.com/x", "Options: a, b"]) {
      expect(stubReply([line]).shown).toBe(line);
    }
    // A step too long to be a stub keeps its own punctuation; one character
    // shorter is still a stub.
    const tooLong = `${"x".repeat(DSH_COLON_STUB_MAX_LENGTH)}:`;
    expect(stubReply([tooLong]).shown).toBe(tooLong);
    const atLimit = `${"x".repeat(DSH_COLON_STUB_MAX_LENGTH - 1)}:`;
    expect(atLimit).toHaveLength(DSH_COLON_STUB_MAX_LENGTH);
    expect(stubReply([atLimit]).shown).toBe(`${"x".repeat(DSH_COLON_STUB_MAX_LENGTH - 1)}.`);
  });

  it("leaves a colon inside a code fence alone, at any chunk boundary", () => {
    for (const fence of ["```", "~~~"]) {
      const reply = `${fence}yaml\nname:`;
      expect(stubReply([reply]).shown).toBe(reply);
      for (let cut = 1; cut < reply.length; cut += 1) {
        expect(stubReply([reply.slice(0, cut), reply.slice(cut)], 1).shown).toBe(reply);
      }
    }
    // A closed fence is not a fence any more: the stub line after it is settled.
    expect(stubReply(["```\ncode\n```\nNow the provider:"]).shown).toBe(
      "```\ncode\n```\nNow the provider.",
    );
    // One or two backticks, or a run that is not at the line's start, open
    // nothing.
    expect(stubReply(["`a` and ``b``\nNow the provider:"]).shown).toBe(
      "`a` and ``b``\nNow the provider.",
    );
    expect(stubReply(["text ```\nNow the provider:"]).shown).toBe("text ```\nNow the provider.");
  });

  it("holds only the one colon, and never delays any other text", () => {
    const stubber = makeDshColonStubber();
    expect(stubber.push("Now the provider:")).toBe("Now the provider");
    // Everything after the held colon is shown straight away, on the next delta.
    expect(stubber.push(" Running the test now.")).toBe(": Running the test now.");
    expect(stubber.closeByToolCall()).toBe("");
  });

  it("ends the step at a tool call even when the colon was left alone", () => {
    const tooLong = `${"x".repeat(DSH_COLON_STUB_MAX_LENGTH)}:`;
    const stubber = makeDshColonStubber();
    expect(stubber.push(tooLong)).toBe(tooLong);
    expect(stubber.closeByToolCall()).toBe("");
    // The next step is read on its own, from its own start.
    expect(stubber.push("Short:")).toBe("Short");
    expect(stubber.closeByToolCall()).toBe(".");
    expect(stubber.push("Last part:")).toBe("Last part");
    expect(stubber.flush()).toBe(":");
  });
});
