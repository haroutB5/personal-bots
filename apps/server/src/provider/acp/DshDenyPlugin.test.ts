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
 */
import * as NodeURL from "node:url";

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

interface DenyDecision {
  readonly kind: "deny";
  readonly reason: string;
}

interface PluginContext {
  on(event: string, handler: (exec: unknown, next: () => unknown) => unknown): void;
}

interface DenyPlugin {
  readonly name: string;
  readonly apply: (ctx: PluginContext, config: unknown) => void;
}

const pluginPath = NodeURL.fileURLToPath(
  new URL("../../../../../scripts/personal/dsh-runtime/hbots-deny-plugin.mjs", import.meta.url),
);

const STATE_DIR = "C:/Users/Ht/.personal-bots/dev/userdata";

const makeExecutor = async () => {
  const plugin = (await import(NodeURL.pathToFileURL(pluginPath).href)) as DenyPlugin;
  let handler: ((exec: unknown, next: () => unknown) => unknown) | undefined;
  plugin.apply(
    {
      on: (event, registered) => {
        if (event === "tools/pre-execute") handler = registered;
      },
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
    const result = handler!({ name, arguments: args }, () => {
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
    // A route that reaches the folder another way still names its tail.
    expect(run("pwsh", { command: "cat ../../userdata/secrets/store.json" }).kind).toBe("deny");
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
