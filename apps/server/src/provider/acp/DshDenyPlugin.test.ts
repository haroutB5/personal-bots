// @effect-diagnostics nodeBuiltinImport:off
/**
 * The bot-state deny plugin, driven through its own hook.
 *
 * The plugin ships as a plain `.mjs` beside the runtime pin and is loaded by a
 * launch row, so it is tested as the file the runtime loads: the test imports
 * it, wires a `tools/pre-execute` handler the way dsh's tools service does, and
 * asserts the decision for every protected path in both tool shapes (the
 * native file/shell tools, and the same tools reached from PTC `run_code`,
 * which go through the same pre-execute stage).
 *
 * From 1.66.66 the plugin resolves every candidate against the session cwd and
 * canonicalizes it first, so the spellings that used to slip past a raw string
 * comparison are part of the contract: relative, `./`, `..`, mixed slashes,
 * case, `\\?\`, duplicate separators and 8.3 short names.
 */
import * as NodeChild from "node:child_process";
import * as NodeURL from "node:url";

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

interface DenyDecision {
  readonly kind: "deny";
  readonly reason: string;
}

interface PluginContext {
  on(event: string, handler: (exec: unknown, next: () => unknown) => unknown): void;
  get?(name: string): unknown;
}

interface DenyPlugin {
  readonly name: string;
  readonly apply: (ctx: PluginContext, config: unknown) => void;
}

const pluginPath = NodeURL.fileURLToPath(
  new URL("../../../../../scripts/personal/dsh-runtime/hbots-deny-plugin.mjs", import.meta.url),
);

const STATE_DIR = "C:/Users/Ht/.personal-bots/dev/userdata";
const WORKSPACE = "C:/Users/Ht/.personal-bots/workspace";

const WIN_STATE = STATE_DIR.replace(/\//g, "\\");

/** The 8.3 form of a path, when the volume has short names enabled. */
const shortPath = (value: string): string => {
  try {
    const out = NodeChild.spawnSync(
      "cmd.exe",
      ["/d", "/c", `for %I in ("${value.replace(/\//g, "\\")}") do @echo %~sI`],
      { encoding: "utf8", windowsHide: true },
    );
    const text = String(out.stdout ?? "")
      .trim()
      .replace(/^"|"$/g, "");
    return text.length > 0 ? text : value;
  } catch {
    return value;
  }
};

interface ExecutorOptions {
  /** 0.2.0 shape: the session header holds the directory. */
  readonly cwd?: string;
  /** 0.2.1 shape: the workingDirectory projection holds the current directory. */
  readonly projectedCwd?: string;
}

const makeExecutor = async (options: ExecutorOptions = {}) => {
  const plugin = (await import(NodeURL.pathToFileURL(pluginPath).href)) as DenyPlugin;
  let handler: ((exec: unknown, next: () => unknown) => unknown) | undefined;
  plugin.apply(
    {
      on: (event, registered) => {
        if (event === "tools/pre-execute") handler = registered;
      },
      get: (service: string) =>
        service === "workingDirectory" && options.projectedCwd !== undefined
          ? { get: () => options.projectedCwd }
          : undefined,
    },
    {
      denyReadWrite: [`${STATE_DIR}/secrets`],
      denyWrite: [
        `${STATE_DIR}/state.sqlite`,
        `${STATE_DIR}/state.sqlite-wal`,
        `${STATE_DIR}/state.sqlite-shm`,
        `${STATE_DIR}/state.sqlite-journal`,
        `${STATE_DIR}/dsh`,
      ],
    },
  );
  if (handler === undefined) throw new Error("The deny plugin registered no pre-execute handler");
  const run = (name: string, args: Record<string, unknown>) => {
    let passed = false;
    const agent =
      options.cwd === undefined ? undefined : { session: { header: { cwd: options.cwd } } };
    const result = handler!({ name, arguments: args, agent }, () => {
      passed = true;
      return { kind: "allow" };
    }) as DenyDecision | { kind: "allow" };
    return passed ? { kind: "allow" as const } : result;
  };
  return { run };
};

it.effect("denies reading and writing the secret store, from every tool", () =>
  Effect.promise(async () => {
    const { run } = await makeExecutor();
    const secretFile = `${STATE_DIR}/secrets/data-encryption-key.json`;
    // Native file tools.
    expect(run("read", { file_path: secretFile }).kind).toBe("deny");
    expect(run("read_image", { file_path: secretFile }).kind).toBe("deny");
    expect(run("edit", { file_path: secretFile }).kind).toBe("deny");
    expect(run("write", { file_path: secretFile }).kind).toBe("deny");
    // Search tools name the folder, not the file.
    expect(run("glob", { path: `${STATE_DIR}/secrets` }).kind).toBe("deny");
    expect(run("grep", { path: `${STATE_DIR}/secrets/**` }).kind).toBe("deny");
    // Shell tools, in the spellings a command could carry.
    expect(run("pwsh", { command: `Get-Content ${STATE_DIR}/secrets/store.json` }).kind).toBe(
      "deny",
    );
    expect(
      run("bash", { command: `cat "${STATE_DIR.toUpperCase()}/secrets/store.json"` }).kind,
    ).toBe("deny");
    // A route that reaches the folder another way still names its tail, and
    // duplicate or `.` separators collapse before the comparison.
    expect(run("pwsh", { command: "cat ../../userdata/secrets/store.json" }).kind).toBe("deny");
    expect(run("pwsh", { command: "cat ..\\userdata\\\\secrets\\\\store.json" }).kind).toBe("deny");
    expect(run("pwsh", { command: "cat ..\\userdata\\.\\secrets/store.json" }).kind).toBe("deny");
    // A workspace folder that happens to be called secrets is not bot state.
    expect(run("pwsh", { command: "Get-Content src/secrets/app.json" }).kind).toBe("allow");
    expect(
      run("read", {
        file_path: "//localhost/c$/Users/Ht/.personal-bots/dev/userdata/secrets/store.json",
      }).kind,
    ).toBe("deny");
    // PTC reaches the same tools through the same pre-execute stage.
    expect(
      run("run_code", { code: 'await tools.read({file_path: "C:/x/userdata/secrets/k"})' }).kind,
    ).toBe("allow");
  }),
);

it.effect("resolves relative paths against the session working directory", () =>
  Effect.promise(async () => {
    const { run } = await makeExecutor({ cwd: WORKSPACE });
    // The 1.66.66 blocker: a data-root cwd plus a protected name.
    expect(
      run("read", { file_path: "..\\dev\\userdata\\secrets\\data-encryption-key.bin" }).kind,
    ).toBe("deny");
    expect(run("read", { file_path: "../dev/userdata/secrets/data-encryption-key.bin" }).kind).toBe(
      "deny",
    );
    expect(run("edit", { file_path: ".\\..\\dev\\userdata\\secrets\\x" }).kind).toBe("deny");
    expect(run("write", { file_path: "..\\DEV\\USERDATA\\SECRETS\\x" }).kind).toBe("deny");
    expect(run("glob", { path: "..\\dev\\userdata\\secrets\\**" }).kind).toBe("deny");
    expect(run("grep", { path: "..\\dev\\userdata\\secrets" }).kind).toBe("deny");
    // Database reads stay open; writes are denied.
    expect(run("read", { file_path: "..\\dev\\userdata\\state.sqlite" }).kind).toBe("allow");
    expect(run("write", { file_path: "..\\dev\\userdata\\state.sqlite" }).kind).toBe("deny");
    expect(run("edit", { file_path: "..\\dev\\userdata\\state.sqlite-wal" }).kind).toBe("deny");
    // Ordinary workspace files still pass.
    expect(run("read", { file_path: "README.md" }).kind).toBe("allow");
    expect(run("write", { file_path: "..\\dev\\notes.txt" }).kind).toBe("allow");
    expect(run("read", { file_path: "..\\dev\\workspace\\secrets.md" }).kind).toBe("allow");
  }),
);

it.effect("uses the workingDirectory projection when 0.2.1 moved the cwd", () =>
  Effect.promise(async () => {
    const { run } = await makeExecutor({ cwd: "C:/elsewhere", projectedCwd: STATE_DIR });
    expect(run("read", { file_path: "secrets\\data-encryption-key.bin" }).kind).toBe("deny");
    expect(run("write", { file_path: "secrets\\x" }).kind).toBe("deny");
    // A moved cwd still allows ordinary files.
    expect(run("read", { file_path: "notes.txt" }).kind).toBe("allow");
  }),
);

it.effect("canonicalizes spellings the raw string comparison missed", () =>
  Effect.promise(async () => {
    const { run } = await makeExecutor();
    expect(run("read", { file_path: `\\\\?\\${WIN_STATE}\\secrets\\x` }).kind).toBe("deny");
    expect(run("read", { file_path: `${WIN_STATE}\\\\secrets\\\\x` }).kind).toBe("deny");
    const short = shortPath(STATE_DIR);
    expect(run("read", { file_path: `${short}\\secrets\\x` }).kind).toBe("deny");
    expect(run("read", { file_path: `${short}\\state.sqlite` }).kind).toBe("allow");
  }),
);

it.effect("denies a relative protected name when the session cwd is missing", () =>
  Effect.promise(async () => {
    const { run } = await makeExecutor();
    expect(run("read", { file_path: "secrets\\data-encryption-key.bin" }).kind).toBe("deny");
    expect(run("read", { file_path: "userdata\\secrets\\x" }).kind).toBe("deny");
    expect(run("read", { file_path: "..\\..\\secrets\\x" }).kind).toBe("deny");
    // A file whose name only contains the word is not the folder.
    expect(run("read", { file_path: "notes\\secrets.md" }).kind).toBe("allow");
    expect(run("read", { file_path: "docs\\my-secrets.md" }).kind).toBe("allow");
  }),
);

it.effect("denies a shell or worked cwd inside bot state", () =>
  Effect.promise(async () => {
    const { run } = await makeExecutor();
    const dataRoot = STATE_DIR;
    expect(run("pwsh", { command: "Get-ChildItem", workdir: dataRoot }).kind).toBe("deny");
    expect(run("bash", { command: "ls", cwd: `${dataRoot}/secrets` }).kind).toBe("deny");
    expect(run("pwsh", { command: "Get-Content secrets\\key", workdir: dataRoot }).kind).toBe(
      "deny",
    );
    expect(run("pwsh", { command: "Get-ChildItem", workdir: "C:/Claude/AI" }).kind).toBe("allow");
    // The cwd-changing tool is disabled by the launch patch; the hook still
    // refuses a move into bot state so a runtime that offers it cannot.
    expect(run("working_directory", { path: dataRoot }).kind).toBe("deny");
    expect(run("working_directory", { path: `${dataRoot}/secrets` }).kind).toBe("deny");
    expect(run("working_directory", { path: "C:/Claude/AI" }).kind).toBe("allow");
  }),
);

it.effect("denies writing the database and the harness home, and leaves reads open", () =>
  Effect.promise(async () => {
    const { run } = await makeExecutor();
    // Reading the database stays open on purpose: the dev team reads it.
    expect(run("read", { file_path: `${STATE_DIR}/state.sqlite` }).kind).toBe("allow");
    expect(run("glob", { path: `${STATE_DIR}/state.sqlite-wal` }).kind).toBe("allow");
    for (const target of [
      `${STATE_DIR}/state.sqlite`,
      `${STATE_DIR}/state.sqlite-wal`,
      `${STATE_DIR}/state.sqlite-shm`,
      `${STATE_DIR}/state.sqlite-journal`,
    ]) {
      expect(run("write", { file_path: target }).kind).toBe("deny");
      expect(run("edit", { file_path: target }).kind).toBe("deny");
    }
    // The harness home: a bot must not edit the next launch's patch.
    expect(run("write", { file_path: `${STATE_DIR}/dsh/profiles/acp/cordis.patch.yml` }).kind).toBe(
      "deny",
    );
    expect(run("edit", { file_path: `${STATE_DIR}/dsh/launch/thread.json` }).kind).toBe("deny");
    expect(run("read", { file_path: `${STATE_DIR}/dsh/launch/thread.json` }).kind).toBe("allow");
    // A sibling folder whose name merely starts the same way is not protected.
    expect(run("write", { file_path: `${STATE_DIR}/dsh-backup/x` }).kind).toBe("allow");
    expect(run("write", { file_path: `${STATE_DIR}/state.sqlite.bak` }).kind).toBe("allow");
  }),
);

it.effect("leaves ordinary workspace paths alone, and never throws", () =>
  Effect.promise(async () => {
    const { run } = await makeExecutor();
    expect(run("read", { file_path: "C:/Claude/AI/personal-bots/README.md" }).kind).toBe("allow");
    expect(run("write", { file_path: "C:/Claude/AI/_wt/x/src/index.ts" }).kind).toBe("allow");
    expect(run("pwsh", { command: "Get-ChildItem Env: | Measure-Object" }).kind).toBe("allow");
    expect(run("pwsh", {}).kind).toBe("allow");
    expect(run("bash", { command: "" }).kind).toBe("allow");
    // An odd payload is a pass, not a crash: a throwing guardrail would break
    // the tool it guards.
    const { run: oddRun } = await makeExecutor();
    expect(oddRun("read", { file_path: 42 }).kind).toBe("allow");
    expect(oddRun("glob", { path: null }).kind).toBe("allow");
    expect(oddRun("unknown-tool", { file_path: `${STATE_DIR}/secrets/x` }).kind).toBe("allow");
  }),
);
