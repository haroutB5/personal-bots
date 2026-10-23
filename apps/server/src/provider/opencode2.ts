import {
  OpenCodeSettings,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderSessionStartInput,
  type ProviderSendTurnInput,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/unstable/process";
import { HttpClient } from "effect/unstable/http";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as McpProviderSession from "../mcp/McpProviderSession.ts";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import { makeOpenCode2TextGeneration } from "../textGeneration/OpenCode2TextGeneration.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderDriverError,
} from "./Errors.ts";
import * as AcpSessionRuntime from "./acp/AcpSessionRuntime.ts";
import { mapAcpToAdapterError } from "./acp/AcpAdapterSupport.ts";
import { makeNativeAcpAdapter } from "./Layers/NativeAcpAdapter.ts";
import { buildRuntimeInstructions, withBotInstructions } from "./RuntimeInstructions.ts";
import { buildRegistryModels } from "./catalog/registryModels.ts";
import { readOpenCodeGoUsageLimits } from "./Layers/openCodeUsageLimits.ts";
import { makePendingOpenCodeProvider } from "./Layers/OpenCodeProvider.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "./providerMaintenance.ts";
import { makeManagedServerProvider } from "./makeManagedServerProvider.ts";
import { buildSelectOptionDescriptor, buildServerProvider } from "./providerSnapshot.ts";
import { defaultProviderContinuationIdentity, type ProviderInstance } from "./ProviderDriver.ts";
import { withInstanceIdentity } from "./Drivers/instanceIdentity.ts";
import {
  makeProviderSnapshotSettingsSource,
  haveProviderSnapshotSettingsChanged,
} from "./providerUpdateSettings.ts";

const DRIVER = ProviderDriverKind.make("opencode");
const decodeAuth = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      "opencode-go": Schema.optionalKey(Schema.Unknown),
      opencode: Schema.optionalKey(Schema.Unknown),
    }),
  ),
);
const decodeApiAuth = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.Literal("api"), key: Schema.String }),
);
const encodeConfig = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      model: Schema.optionalKey(Schema.String),
      /** Files the agent reads into its system prompt once, at session start. */
      instructions: Schema.optionalKey(Schema.Array(Schema.String)),
      plugins: Schema.Array(Schema.String),
      permissions: Schema.Array(
        Schema.Struct({
          action: Schema.String,
          resource: Schema.String,
          effect: Schema.Literal("ask"),
        }),
      ),
    }),
  ),
);
const OWNER_XDG = ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"] as const;
const ENV_PLUGIN = `import { Plugin } from "@opencode/plugin";
export default Plugin.define({
  id: "hbots.restore-owner-environment",
  async setup(ctx) {
    await ctx.shell.hook("create.before", event => {
      for (const name of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) {
        const value = process.env["HBOTS_OWNER_" + name];
        if (value) event.env[name] = value;
        else event.env[name] = "";
        event.env["HBOTS_OWNER_" + name] = "";
      }
      event.env.OPENCODE_API_KEY = "";
      event.env.OPENCODE_AUTH_CONTENT = "";
    });
  },
});\n`;

/** Console keys serve both Zen and Go. Keep credentials in the child environment, never in config. */
export const openCode2Environment = Effect.fn("openCode2Environment")(function* (input: {
  readonly base: NodeJS.ProcessEnv;
  readonly stateDir: string;
  readonly model?: string;
  /**
   * A file the agent reads into its session context at start, instead of the
   * adapter repeating the instructions in every turn's prompt. OpenCode 2 keeps
   * the file's content for the life of the session, so it is a persona-sized
   * block, not something that changes per turn.
   */
  readonly instructionsPath?: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let key = input.base.OPENCODE_API_KEY;
  {
    const dataHome =
      input.base.XDG_DATA_HOME ||
      path.join(input.base.HOME || input.base.USERPROFILE || "", ".local", "share");
    const content =
      input.base.OPENCODE_AUTH_CONTENT ||
      (yield* fs
        .readFileString(path.join(dataHome, "opencode", "auth.json"))
        .pipe(Effect.orElseSucceed(() => "{}")));
    const auth = yield* decodeAuth(content).pipe(
      Effect.orElseSucceed(() => ({ "opencode-go": undefined, opencode: undefined })),
    );
    const go = decodeApiAuth(auth["opencode-go"]);
    const consoleAuth = decodeApiAuth(auth.opencode);
    key = Option.isSome(go)
      ? go.value.key
      : key || (Option.isSome(consoleAuth) ? consoleAuth.value.key : undefined);
  }
  return {
    ...input.base,
    ...Object.fromEntries(OWNER_XDG.map((name) => [`HBOTS_OWNER_${name}`, input.base[name] ?? ""])),
    XDG_DATA_HOME: path.join(input.stateDir, "opencode-v2", "data"),
    XDG_CONFIG_HOME: path.join(input.stateDir, "opencode-v2", "config"),
    OPENCODE_CONFIG_DIR: path.join(input.stateDir, "opencode-v2", "config", "opencode"),
    XDG_CACHE_HOME: path.join(input.stateDir, "opencode-v2", "cache"),
    XDG_STATE_HOME: path.join(input.stateDir, "opencode-v2", "state"),
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_SHARE: "1",
    OPENCODE_AUTH_CONTENT: "{}",
    OPENCODE_CONFIG_CONTENT: encodeConfig({
      ...(input.model ? { model: input.model } : {}),
      ...(input.instructionsPath ? { instructions: [input.instructionsPath] } : {}),
      plugins: [
        path.join(
          input.stateDir,
          "opencode-v2",
          "config",
          "opencode",
          "plugins",
          "restore-owner-env",
        ),
      ],
      // The private config home contains only the app's environment hook.
      permissions: [{ action: "*", resource: "*", effect: "ask" }],
    }),
    ...(key ? { OPENCODE_API_KEY: key } : {}),
  } satisfies NodeJS.ProcessEnv;
});

export const configureOpenCode2Turn = (
  runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "setMode" | "setConfigOption" | "getConfigOptions"
  >,
  input: ProviderSendTurnInput,
) =>
  Effect.gen(function* () {
    yield* runtime.setMode(input.interactionMode === "plan" ? "plan" : "build");
    for (const option of input.modelSelection?.options ?? []) {
      const id = option.id === "variant" ? "effort" : option.id;
      if (id === "effort") {
        // Older bot selections (and the form before 1.66.84) could name an
        // effort this model does not offer, e.g. "medium" on DeepSeek, which
        // the agent refuses. Leaving it unset runs the model's own default
        // instead of failing the whole turn.
        const configOptions = yield* runtime.getConfigOptions;
        const effort = configOptions.find((candidate) => candidate.id === "effort");
        if (effort?.type === "select") {
          const offered = effort.options.some((entry) =>
            "value" in entry
              ? entry.value === option.value
              : entry.options.some((nested) => nested.value === option.value),
          );
          if (!offered) {
            yield* Effect.logWarning("OpenCode model does not offer this effort", {
              model: input.modelSelection?.model,
              effort: option.value,
            });
            continue;
          }
        }
      }
      yield* runtime.setConfigOption(id, option.value);
    }
  }).pipe(
    Effect.mapError((cause) =>
      mapAcpToAdapterError(DRIVER, input.threadId, "session/set_config_option", cause),
    ),
  );

export const makeOpenCode2Instance = Effect.fn("makeOpenCode2Instance")(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string | undefined;
  readonly accentColor: string | undefined;
  readonly config: OpenCodeSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly version: string;
}) {
  const config = yield* ServerConfig;
  const settings = yield* ServerSettingsService;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  // Lives where OpenCode 2 looks for global plugins, so auto-discovery loads it
  // without a config entry (a path outside the config home is ignored).
  const pluginPath = path.join(
    config.stateDir,
    "opencode-v2",
    "config",
    "opencode",
    "plugins",
    "restore-owner-env",
    "index.js",
  );
  yield* fs.makeDirectory(path.dirname(pluginPath), { recursive: true });
  const oldPlugin = yield* fs.readFileString(pluginPath).pipe(Effect.orElseSucceed(() => ""));
  if (oldPlugin !== ENV_PLUGIN) yield* fs.writeFileString(pluginPath, ENV_PLUGIN);
  yield* fs.writeFileString(
    path.join(path.dirname(pluginPath), "package.json"),
    '{"name":"hbots-restore-owner-env","type":"module","exports":"./index.js"}\n',
  );
  const identity = defaultProviderContinuationIdentity({
    driverKind: DRIVER,
    instanceId: input.instanceId,
  });
  const stamp = withInstanceIdentity({
    instanceId: input.instanceId,
    driverKind: DRIVER,
    displayName: input.displayName,
    accentColor: input.accentColor,
    continuationGroupKey: identity.continuationKey,
  });
  const instructionsDir = path.join(config.stateDir, "opencode-v2", "instructions");
  const environmentFor = (model?: string, instructionsPath?: string) =>
    openCode2Environment({
      base: input.environment,
      stateDir: config.stateDir,
      ...(model ? { model } : {}),
      ...(instructionsPath ? { instructionsPath } : {}),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  /**
   * The persona and runtime notes go into a file OpenCode 2 reads at session
   * start, so a long chat does not pay for them in every prompt (and its prompt
   * prefix stays stable, which keeps DeepSeek's context cache hitting).
   */
  const prepareInstructions = (
    session: Pick<ProviderSessionStartInput, "threadId" | "modelSelection" | "systemInstructions">,
  ) =>
    Effect.gen(function* () {
      const text = withBotInstructions(
        buildRuntimeInstructions({
          harness: "OpenCode ACP",
          ...(session.modelSelection?.model ? { model: session.modelSelection.model } : {}),
        }),
        session.systemInstructions,
      );
      const file = path.join(instructionsDir, `${session.threadId}.md`);
      yield* fs.makeDirectory(instructionsDir, { recursive: true });
      const previous = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
      if (previous !== text) yield* fs.writeFileString(file, text);
      return file;
    });
  const runtimeOptions = (
    session: Pick<
      ProviderSessionStartInput,
      "cwd" | "threadId" | "runtimeMode" | "modelSelection" | "resumeCursor" | "systemInstructions"
    >,
  ) =>
    Effect.gen(function* () {
      const instructionsPath = yield* prepareInstructions(session);
      const environment = yield* environmentFor(session.modelSelection?.model, instructionsPath);
      const mcp = McpProviderSession.readMcpProviderSession(session.threadId);
      const cursor = session.resumeCursor;
      const resumeSessionId =
        typeof cursor === "object" &&
        cursor !== null &&
        "engine" in cursor &&
        cursor.engine === "acp" &&
        "sessionId" in cursor &&
        typeof cursor.sessionId === "string"
          ? cursor.sessionId
          : undefined;
      return {
        spawn: {
          command: input.config.binaryPath,
          // `acp` takes no approval flag; full access is approved by the adapter.
          args: ["acp"],
          cwd: session.cwd || config.cwd,
          env: McpProviderSession.withAgentDeviceEnvironment(environment, mcp),
        },
        cwd: session.cwd || config.cwd,
        authMethodId: null,
        clientInfo: { name: "hbots", version: "1" },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        ...(resumeSessionId ? { resumeSessionId, resumeMethod: "resume" as const } : {}),
        ...(mcp
          ? {
              mcpServers: [
                {
                  type: "http" as const,
                  name: "t3-code",
                  url: mcp.endpoint,
                  headers: [{ name: "Authorization", value: mcp.authorizationHeader }],
                },
              ],
            }
          : {}),
      } satisfies AcpSessionRuntime.AcpSessionRuntimeOptions;
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterProcessError({
            provider: DRIVER,
            threadId: session.threadId,
            detail: "Could not prepare OpenCode 2.",
            cause,
          }),
      ),
    );
  const makeRuntime = (cwd: string, model?: string) =>
    Effect.gen(function* () {
      const environment = yield* environmentFor(model);
      return yield* AcpSessionRuntime.make({
        spawn: { command: input.config.binaryPath, args: ["acp"], cwd, env: environment },
        cwd,
        authMethodId: null,
        clientInfo: { name: "hbots-helper", version: "1" },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(Crypto.Crypto, crypto),
      );
    });
  const adapter = yield* makeNativeAcpAdapter({
    instanceId: input.instanceId,
    provider: DRIVER,
    displayName: "OpenCode",
    instructionsInSession: true,
    needsFreshContext: (session) =>
      session.freshSession !== true &&
      session.resumeCursor != null &&
      !(
        typeof session.resumeCursor === "object" &&
        "engine" in session.resumeCursor &&
        session.resumeCursor.engine === "acp"
      ),
    runtimeOptions,
    configureTurn: configureOpenCode2Turn,
    promptAttachments: (turn) =>
      Effect.forEach(turn.attachments ?? [], (attachment) =>
        Effect.gen(function* () {
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: config.attachmentsDir,
            attachment,
          });
          if (!attachmentPath)
            return yield* new ProviderAdapterRequestError({
              provider: DRIVER,
              method: "session/prompt",
              detail: "Invalid attachment.",
            });
          if (attachment.type !== "image")
            return [{ type: "text" as const, text: `Attached file: ${attachmentPath}` }];
          const bytes = yield* fs.readFile(attachmentPath).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: DRIVER,
                  method: "session/prompt",
                  detail: "Could not read the image attachment.",
                  cause,
                }),
            ),
          );
          return [
            {
              type: "image" as const,
              data: Buffer.from(bytes).toString("base64"),
              mimeType: attachment.mimeType,
            },
          ];
        }),
      ).pipe(Effect.map((parts) => parts.flat())),
  });
  const probe = Effect.gen(function* () {
    const runtime = yield* makeRuntime(config.cwd);
    const started = yield* runtime.start();
    const options = started.sessionSetupResult.configOptions ?? [];
    const descriptorsFor = (configOptions: typeof options) =>
      configOptions
        .filter(
          (option) =>
            option.category !== "model" && option.category !== "mode" && option.type === "select",
        )
        .flatMap((option) => {
          if (option.type !== "select") return [];
          return [
            buildSelectOptionDescriptor({
              id: option.id,
              label: option.name,
              options: option.options.flatMap((entry) =>
                "value" in entry
                  ? [
                      {
                        value: entry.value,
                        label: entry.name,
                        isDefault: entry.value === option.currentValue,
                      },
                    ]
                  : entry.options.map((nested) => ({
                      value: nested.value,
                      label: nested.name,
                      isDefault: nested.value === option.currentValue,
                    })),
              ),
            }),
          ];
        });
    const initialDescriptors = descriptorsFor(options);
    // Effort choices belong to the model, not the agent: DeepSeek offers
    // low/high/max while Claude and GPT offer more. The session's options
    // describe only its starting model, so ask each model for its own.
    const descriptorsByModel = new Map<string, ReturnType<typeof descriptorsFor>>();
    const modelOption = options.find(
      (option) => option.category === "model" && option.type === "select",
    );
    const modelValues =
      modelOption?.type === "select"
        ? modelOption.options.flatMap((entry) =>
            "value" in entry ? [entry.value] : entry.options.map((nested) => nested.value),
          )
        : [];
    for (const value of modelValues) {
      const switched = yield* runtime
        .setConfigOption(modelOption?.id ?? "model", value)
        .pipe(Effect.option);
      descriptorsByModel.set(
        value,
        Option.isSome(switched)
          ? descriptorsFor(switched.value.configOptions ?? [])
          : initialDescriptors,
      );
    }
    const models = buildRegistryModels(started.sessionSetupResult).map((model) => ({
      ...model,
      name: model.name.replace(/^[^/]+\//, ""),
      subProvider: model.slug.startsWith("opencode-go/") ? "OpenCode Go" : "OpenCode",
      capabilities: createModelCapabilities({
        optionDescriptors: descriptorsByModel.get(model.slug) ?? initialDescriptors,
      }),
    }));
    return buildServerProvider({
      driver: DRIVER,
      presentation: {
        displayName: "OpenCode",
        supportsConversationRollback: false,
        showInteractionModeToggle: true,
      },
      enabled: input.config.enabled,
      checkedAt: DateTime.formatIso(yield* DateTime.now),
      models,
      probe: {
        installed: true,
        version: input.version,
        status: "ready",
        auth: { status: "authenticated" },
      },
    });
  }).pipe(Effect.scoped, Effect.timeout("30 seconds"));
  const checkProvider = probe.pipe(
    Effect.catch(() =>
      Effect.gen(function* () {
        return buildServerProvider({
          presentation: { displayName: "OpenCode" },
          enabled: input.config.enabled,
          checkedAt: DateTime.formatIso(yield* DateTime.now),
          models: [],
          probe: {
            installed: true,
            version: input.version,
            status: "error",
            auth: { status: "unknown" },
            message:
              "OpenCode 2 could not open a session. Check its connection and try Refresh provider status.",
          },
        });
      }),
    ),
    Effect.flatMap((provider) =>
      readOpenCodeGoUsageLimits({
        enabled: input.config.enabled,
        serverUrl: "",
        environment: input.environment,
      }).pipe(
        Effect.map((usageLimits) => stamp({ ...provider, usageLimits })),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(HttpClient.HttpClient, http),
      ),
    ),
  );
  const source = makeProviderSnapshotSettingsSource(input.config, settings);
  const snapshot = yield* makeManagedServerProvider({
    resolveMaintenance: () =>
      Effect.succeed(
        makeManualOnlyProviderMaintenanceCapabilities({
          provider: DRIVER,
          packageName: "@opencode/cli",
        }),
      ),
    getSettings: source.getSettings,
    streamSettings: source.streamSettings,
    haveSettingsChanged: haveProviderSnapshotSettingsChanged,
    refreshOnInterval: false,
    checkProviderOnSettingsChange: () => false,
    initialSnapshot: () => makePendingOpenCodeProvider(input.config).pipe(Effect.map(stamp)),
    checkProvider,
  });
  const textGeneration = yield* makeOpenCode2TextGeneration(makeRuntime);
  return {
    instanceId: input.instanceId,
    driverKind: DRIVER,
    continuationIdentity: identity,
    displayName: input.displayName,
    accentColor: input.accentColor,
    enabled: input.config.enabled,
    snapshot,
    adapter,
    textGeneration,
    snapshotForCwd: () => snapshot.getSnapshot,
    smokeTest: ({ model }) =>
      Effect.gen(function* () {
        const runtime = yield* makeRuntime(config.cwd, model);
        let reply = "";
        yield* runtime.handleRequestPermission(() =>
          Effect.succeed({ outcome: { outcome: "cancelled" as const } }),
        );
        yield* runtime.handleSessionUpdate((notification) =>
          Effect.sync(() => {
            const update = notification.update;
            if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text")
              reply += update.content.text;
          }),
        );
        yield* runtime.start();
        yield* runtime.setModel(model);
        yield* runtime.prompt({
          prompt: [{ type: "text", text: "Reply with only OK. Do not call tools." }],
        });
        if (!reply.trim())
          return yield* new ProviderDriverError({
            driver: DRIVER,
            instanceId: input.instanceId,
            detail: "OpenCode 2 returned no response to its test message.",
          });
      }).pipe(
        Effect.scoped,
        Effect.timeout("90 seconds"),
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER,
              instanceId: input.instanceId,
              detail: "OpenCode 2 could not complete its test message.",
              cause,
            }),
        ),
      ),
  } satisfies ProviderInstance;
});
