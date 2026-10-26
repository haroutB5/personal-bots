// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "@effect/platform-node/NodePath";
import { expect, it } from "@effect/vitest";
import { ThreadId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import {
  openCode2Environment,
  openCode2SessionFingerprint,
  configureOpenCode2Turn,
} from "./opencode2.ts";
import type * as AcpSessionRuntime from "./acp/AcpSessionRuntime.ts";
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));

for (const [name, auth, envKey, expected] of [
  [
    "reuses an existing Console key for Go",
    { opencode: { type: "api", key: "console-test-key" } },
    undefined,
    "console-test-key",
  ],
  [
    "keeps explicit Go credentials ahead of environment",
    { "opencode-go": { type: "api", key: "go-test-key" } },
    "env-test-key",
    "go-test-key",
  ],
  [
    "keeps an instance environment ahead of the Console fallback",
    { opencode: { type: "api", key: "console-test-key" } },
    "env-test-key",
    "env-test-key",
  ],
  [
    "does not use an OAuth access token as an API key",
    { opencode: { type: "oauth", access: "not-an-api-key" } },
    undefined,
    undefined,
  ],
] as const) {
  it.effect(name, () =>
    Effect.gen(function* () {
      const env = yield* openCode2Environment({
        base: {
          USERPROFILE: "/owner",
          OPENCODE_AUTH_CONTENT: encodeJson(auth),
          ...(envKey ? { OPENCODE_API_KEY: envKey } : {}),
          OPENCODE_CONFIG_CONTENT: '{"plugins":["owner-private-plugin"]}',
        },
        stateDir: "/bots/state",
        model: "opencode-go/deepseek-v4.1-flash",
      }).pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            readFileString: () => Effect.die("Inline credentials must not read another account"),
          }),
        ),
        Effect.provide(NodePath.layerPosix),
      );
      expect(env.OPENCODE_API_KEY).toBe(expected);
      expect(env.XDG_DATA_HOME).toBe("/bots/state/opencode-v2/data");
      expect(env.XDG_CONFIG_HOME).toBe("/bots/state/opencode-v2/config");
      expect(env.OPENCODE_AUTH_CONTENT).toBe("{}");
      expect(decodeJson(env.OPENCODE_CONFIG_CONTENT!)).toEqual({
        model: "opencode-go/deepseek-v4.1-flash",
        plugins: ["/bots/state/opencode-v2/config/opencode/plugins/restore-owner-env"],
        permissions: [{ action: "*", resource: "*", effect: "ask" }],
      });
      expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
    }),
  );
}

it.effect("adds the session instructions file to the agent config", () =>
  Effect.gen(function* () {
    const env = yield* openCode2Environment({
      base: { USERPROFILE: "/owner", OPENCODE_AUTH_CONTENT: "{}" },
      stateDir: "/bots/state",
      instructionsPath: "/bots/state/opencode-v2/instructions/thread-1.md",
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({})),
      Effect.provide(NodePath.layerPosix),
    );
    expect(decodeJson(env.OPENCODE_CONFIG_CONTENT!)).toMatchObject({
      instructions: ["/bots/state/opencode-v2/instructions/thread-1.md"],
    });
  }),
);

it.effect("fingerprints the auth content and the binary path", () =>
  Effect.gen(function* () {
    let auth = "key-one";
    const fingerprint = (binaryPath: string) =>
      openCode2SessionFingerprint({
        base: { USERPROFILE: "/owner" },
        stateDir: "/bots/state",
        binaryPath,
      }).pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({ readFileString: () => Effect.succeed(auth) }),
        ),
        Effect.provide(NodePath.layerPosix),
      );
    const first = yield* fingerprint("/bin/opencode-a");
    expect(yield* fingerprint("/bin/opencode-a")).toBe(first);
    expect(yield* fingerprint("/bin/opencode-b")).not.toBe(first);
    auth = "key-two";
    expect(yield* fingerprint("/bin/opencode-a")).not.toBe(first);
  }),
);

it.effect("malformed auth cannot leak into config or overwrite another account", () =>
  Effect.gen(function* () {
    let pathRead = "";
    const env = yield* openCode2Environment({
      base: { XDG_DATA_HOME: "/instance-data" },
      stateDir: "/test",
    }).pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          readFileString: (path) => {
            pathRead = path;
            return Effect.succeed("{malformed-secret-auth");
          },
        }),
      ),
      Effect.provide(NodePath.layerPosix),
    );
    expect(pathRead).toBe("/instance-data/opencode/auth.json");
    expect(env.OPENCODE_API_KEY).toBeUndefined();
    expect(env.OPENCODE_CONFIG_CONTENT).not.toContain("malformed-secret-auth");
  }),
);

const effortConfig = (values: ReadonlyArray<string>) => ({
  id: "effort",
  name: "Effort",
  category: "thought_level",
  type: "select" as const,
  currentValue: "default",
  options: values.map((value) => ({ value, name: value })),
});

it.effect("sets native plan mode and maps saved v1 variant selections to v2 effort", () =>
  Effect.gen(function* () {
    const calls: unknown[] = [];
    const runtime = {
      setMode: (mode) =>
        Effect.sync(() => {
          calls.push(["mode", mode]);
          return {};
        }),
      setConfigOption: (id, value) =>
        Effect.sync(() => {
          calls.push([id, value]);
          return { configOptions: [] };
        }),
      getConfigOptions: Effect.succeed([effortConfig(["low", "high", "max", "default"])]),
    } satisfies Pick<
      AcpSessionRuntime.AcpSessionRuntime["Service"],
      "setMode" | "setConfigOption" | "getConfigOptions"
    >;
    yield* configureOpenCode2Turn(runtime, {
      threadId: ThreadId.make("test"),
      interactionMode: "plan",
      modelSelection: {
        instanceId: ProviderInstanceId.make("opencode"),
        model: "opencode-go/deepseek-v4.1-flash",
        options: [{ id: "variant", value: "high" }],
      },
    });
    expect(calls).toEqual([
      ["mode", "plan"],
      ["effort", "high"],
    ]);
  }),
);

it.effect("leaves an effort the model does not offer unset instead of failing the turn", () =>
  Effect.gen(function* () {
    const calls: unknown[] = [];
    const runtime = {
      setMode: (mode) =>
        Effect.sync(() => {
          calls.push(["mode", mode]);
          return {};
        }),
      setConfigOption: (id, value) =>
        Effect.sync(() => {
          calls.push([id, value]);
          return { configOptions: [] };
        }),
      getConfigOptions: Effect.succeed([effortConfig(["low", "high", "max", "default"])]),
    } satisfies Pick<
      AcpSessionRuntime.AcpSessionRuntime["Service"],
      "setMode" | "setConfigOption" | "getConfigOptions"
    >;
    yield* configureOpenCode2Turn(runtime, {
      threadId: ThreadId.make("test"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("opencode"),
        model: "opencode-go/deepseek-v4.1-flash",
        options: [{ id: "effort", value: "medium" }],
      },
    });
    expect(calls).toEqual([["mode", "build"]]);
  }),
);
