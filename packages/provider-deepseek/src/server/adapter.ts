/**
 * The claude-code engine: DeepSeek identity, Flash-only gating and DeepSeek
 * failure wording over the app's Claude adapter, which the app injects because
 * it is not a package export.
 * @module provider-deepseek/server/adapter
 */
import {
  ProviderDriverKind,
  type ClaudeSettings,
  type ModelSelection,
  type OrchestrationV2ProviderThread,
  type ProviderInstanceId,
  type ResolvedProviderInstanceEnvironment,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import type { ProviderCatalog } from "@t3tools/provider-core/server/ModelCatalog";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import type { DeepSeekSettings } from "../settings.ts";
import { canonicalizeDeepSeekModelId, DEEPSEEK_FLASH_MODEL } from "./catalog.ts";
import { DEEPSEEK_AUTH_TOKEN_ENV, DEEPSEEK_AUTO_COMPACT_WINDOW } from "./environment.ts";

const DEEPSEEK_DRIVER = ProviderDriverKind.make("deepseek");
const CLAUDE_AGENT_DRIVER = ProviderDriverKind.make("claudeAgent");

/**
 * DeepSeek's settings are a subset of the Claude shape. The compact window is
 * DeepSeek's own: its Claude Code guide pins auto-compact at 786432 (three
 * quarters of Flash's 1M context).
 */
export const deepSeekClaudeSettings = (settings: DeepSeekSettings): ClaudeSettings => ({
  enabled: settings.enabled,
  binaryPath: settings.binaryPath,
  homePath: settings.homePath,
  customModels: [],
  launchArgs: "",
  autoCompactWindow: DEEPSEEK_AUTO_COMPACT_WINDOW,
  idleCompaction: "default",
});

/**
 * What the app needs to build the shared Claude adapter: the DeepSeek-shaped
 * create input, the exact child environment, and DeepSeek's provider catalog
 * for the app to resolve into the Claude catalog view.
 */
export interface DeepSeekClaudeAdapterFactoryInput {
  readonly create: ProviderAdapterDriverCreateInput<ClaudeSettings>;
  readonly processEnvironment: NodeJS.ProcessEnv;
  readonly providerCatalog: Effect.Effect<ProviderCatalog | undefined>;
}

export type DeepSeekClaudeAdapterFactory = (
  input: DeepSeekClaudeAdapterFactoryInput,
) => Effect.Effect<ProviderAdapter.ProviderAdapterV2["Service"], ProviderAdapterDriverCreateError>;

export interface DeepSeekClaudeAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly settings: DeepSeekSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly providerCatalog: Effect.Effect<ProviderCatalog | undefined>;
  readonly createClaudeAdapter: DeepSeekClaudeAdapterFactory;
  readonly displayName?: string;
  readonly accentColor?: string;
}

const resolveEnvironment = (environment: NodeJS.ProcessEnv): ResolvedProviderInstanceEnvironment =>
  Object.entries(environment).flatMap(([name, value]) =>
    typeof value === "string" ? [{ name, value, sensitive: name === DEEPSEEK_AUTH_TOKEN_ENV }] : [],
  );

/** A plain object or array, never a decoded DateTime or other class instance. */
const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * Rewrites every `driver` field in an event's plain data. Events nest their
 * entities (session, thread, turn item, subagent), and consumers read those
 * fields directly, so a top-level stamp alone is not enough.
 */
const restampDriver = <T>(value: T): T => {
  if (Array.isArray(value)) {
    const next = value.map(restampDriver);
    return (next.some((entry, index) => entry !== value[index]) ? next : value) as T;
  }
  if (!isPlainRecord(value)) return value;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const stamped =
      key === "driver" && entry === CLAUDE_AGENT_DRIVER ? DEEPSEEK_DRIVER : restampDriver(entry);
    next[key] = stamped;
    if (stamped !== entry) changed = true;
  }
  return (changed ? next : value) as T;
};

/**
 * The inner runtime words auth and rate-limit failures in Claude terms. On
 * DeepSeek those directions mislead, so the three known Claude-specific
 * wordings are translated at the event boundary. Every other failure passes
 * through verbatim.
 */
export const deepSeekFailureText = (message: string): string => {
  if (message.includes("claude auth login")) {
    return (
      "DeepSeek could not authenticate. Check the API key saved in this DeepSeek instance's " +
      "settings, then start a new thread."
    );
  }
  if (message.includes("Claude usage limit reached")) {
    return "DeepSeek rate limit reached. Send the message again once the limit resets.";
  }
  if (message.includes("Claude turn failed.")) {
    return message.replace("Claude turn failed.", "DeepSeek turn failed.");
  }
  return message;
};

const withDeepSeekFailureText = <T>(event: T): T => {
  if (!isPlainRecord(event) || event["type"] !== "turn.terminal") return event;
  if (event["status"] !== "failed") return event;
  const failure = event["failure"];
  if (!isPlainRecord(failure) || typeof failure["message"] !== "string") return event;
  const translated = deepSeekFailureText(failure["message"]);
  if (translated === failure["message"]) return event;
  return { ...event, failure: { ...failure, message: translated } } as T;
};

const stampDeepSeekEvent = (event: ProviderAdapter.ProviderAdapterV2Event) =>
  withDeepSeekFailureText(restampDriver(event));

const rewriteAdapterError = (
  error: ProviderAdapter.ProviderAdapterV2Error,
): ProviderAdapter.ProviderAdapterV2Error => {
  if (typeof error !== "object" || error === null || !("driver" in error)) return error;
  if ((error as { readonly driver?: unknown }).driver === DEEPSEEK_DRIVER) return error;
  const proto = Object.getPrototypeOf(error);
  return Object.assign(Object.create(proto), error, {
    driver: DEEPSEEK_DRIVER,
  }) as ProviderAdapter.ProviderAdapterV2Error;
};

const mapAdapterError = <A, R>(
  effect: Effect.Effect<A, ProviderAdapter.ProviderAdapterV2Error, R>,
): Effect.Effect<A, ProviderAdapter.ProviderAdapterV2Error, R> =>
  effect.pipe(Effect.mapError(rewriteAdapterError));

const mapAdapterStream = (
  stream: Stream.Stream<
    ProviderAdapter.ProviderAdapterV2Event,
    ProviderAdapter.ProviderAdapterV2Error
  >,
): Stream.Stream<ProviderAdapter.ProviderAdapterV2Event, ProviderAdapter.ProviderAdapterV2Error> =>
  stream.pipe(Stream.map(stampDeepSeekEvent), Stream.mapError(rewriteAdapterError));

/** Flash-only: anything that does not canonicalize to Flash fails before the runtime spawns. */
const assertFlashModel = Effect.fn("DeepSeekClaudeAdapter.assertFlashModel")(function* (
  modelSelection: ModelSelection,
  operation: string,
) {
  const raw = modelSelection.model?.trim();
  if (!raw || canonicalizeDeepSeekModelId(raw) === DEEPSEEK_FLASH_MODEL) return;
  return yield* new ProviderAdapter.ProviderAdapterProtocolError({
    driver: DEEPSEEK_DRIVER,
    detail:
      `DeepSeek adapter validation failed in ${operation}: DeepSeek supports only ` +
      `DeepSeek V4.1 Flash ("deepseek-flash"); "${raw}" is not accepted here.`,
  });
});

const assertResumeModel = (input: { readonly modelSelection?: ModelSelection }) =>
  input.modelSelection === undefined
    ? Effect.void
    : assertFlashModel(input.modelSelection, "resumeThread");

const rewriteThread = (thread: OrchestrationV2ProviderThread): OrchestrationV2ProviderThread =>
  restampDriver(thread);

const rewriteSnapshot = (
  snapshot: ProviderAdapter.ProviderAdapterV2ThreadSnapshot,
): ProviderAdapter.ProviderAdapterV2ThreadSnapshot => ({
  ...snapshot,
  providerThread: rewriteThread(snapshot.providerThread),
});

const wrapMcpApps = (
  mcpApps: ProviderAdapter.ProviderAdapterV2McpApps,
): ProviderAdapter.ProviderAdapterV2McpApps => ({
  listTools: (input) => mapAdapterError(mcpApps.listTools(input)),
  callTool: (input) => mapAdapterError(mcpApps.callTool(input)),
  readResource: (input) => mapAdapterError(mcpApps.readResource(input)),
});

const wrapSession = (
  inner: ProviderAdapter.ProviderAdapterV2SessionRuntime,
): ProviderAdapter.ProviderAdapterV2SessionRuntime => {
  const innerMcpApps = inner.mcpApps;
  return {
    ...inner,
    driver: DEEPSEEK_DRIVER,
    providerSession: restampDriver(inner.providerSession),
    events: mapAdapterStream(inner.events),
    ensureThread: (input) =>
      assertFlashModel(input.modelSelection, "ensureThread").pipe(
        Effect.andThen(inner.ensureThread(input)),
        Effect.map(rewriteThread),
        Effect.mapError(rewriteAdapterError),
      ),
    resumeThread: (input) =>
      assertResumeModel(input).pipe(
        Effect.andThen(inner.resumeThread(input)),
        Effect.map(rewriteThread),
        Effect.mapError(rewriteAdapterError),
      ),
    startTurn: (input) =>
      assertFlashModel(input.modelSelection, "startTurn").pipe(
        Effect.andThen(inner.startTurn(input)),
        Effect.mapError(rewriteAdapterError),
      ),
    steerTurn: (input) => mapAdapterError(inner.steerTurn(input)),
    interruptTurn: (input) => mapAdapterError(inner.interruptTurn(input)),
    respondToRuntimeRequest: (input) => mapAdapterError(inner.respondToRuntimeRequest(input)),
    readThreadSnapshot: (input) =>
      inner
        .readThreadSnapshot(input)
        .pipe(Effect.map(rewriteSnapshot), Effect.mapError(rewriteAdapterError)),
    rollbackThread: (input) =>
      inner
        .rollbackThread(input)
        .pipe(Effect.map(rewriteSnapshot), Effect.mapError(rewriteAdapterError)),
    forkThread: (input) =>
      inner.forkThread(input).pipe(Effect.map(rewriteThread), Effect.mapError(rewriteAdapterError)),
    ...(inner.subscribeEvents === undefined
      ? {}
      : {
          subscribeEvents: inner.subscribeEvents.pipe(
            Effect.map((subscription) => ({
              ...subscription,
              events: mapAdapterStream(subscription.events),
            })),
          ),
        }),
    ...(inner.injectHistory === undefined
      ? {}
      : { injectHistory: (input) => mapAdapterError(inner.injectHistory!(input)) }),
    ...(inner.compactThread === undefined
      ? {}
      : {
          compactThread: (input) =>
            assertFlashModel(input.modelSelection, "compactThread").pipe(
              Effect.andThen(inner.compactThread!(input)),
              Effect.mapError(rewriteAdapterError),
            ),
        }),
    ...(inner.stopTask === undefined
      ? {}
      : { stopTask: (input) => mapAdapterError(inner.stopTask!(input)) }),
    ...(inner.awaitBackgroundTasks === undefined
      ? {}
      : {
          awaitBackgroundTasks: (input) => mapAdapterError(inner.awaitBackgroundTasks!(input)),
        }),
    ...(inner.stopSubagent === undefined
      ? {}
      : { stopSubagent: (input) => mapAdapterError(inner.stopSubagent!(input)) }),
    ...(inner.unloadThread === undefined
      ? {}
      : { unloadThread: (input) => mapAdapterError(inner.unloadThread!(input)) }),
    ...(inner.uploadFeedback === undefined
      ? {}
      : { uploadFeedback: (input) => mapAdapterError(inner.uploadFeedback!(input)) }),
    ...(innerMcpApps === undefined ? {} : { mcpApps: wrapMcpApps(innerMcpApps) }),
  };
};

export const makeDeepSeekClaudeAdapter = Effect.fn("makeDeepSeekClaudeAdapter")(function* (
  options: DeepSeekClaudeAdapterOptions,
) {
  const inner = yield* options.createClaudeAdapter({
    create: {
      instanceId: options.instanceId,
      displayName: options.displayName,
      accentColor: options.accentColor,
      environment: resolveEnvironment(options.environment),
      enabled: options.settings.enabled,
      config: deepSeekClaudeSettings(options.settings),
    },
    processEnvironment: options.environment,
    providerCatalog: options.providerCatalog,
  });
  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: DEEPSEEK_DRIVER,
    getCapabilities: Effect.fn("DeepSeekClaudeAdapter.getCapabilities")(() =>
      mapAdapterError(inner.getCapabilities()),
    ),
    planSelectionTransition: Effect.fn("DeepSeekClaudeAdapter.planSelectionTransition")((input) =>
      mapAdapterError(inner.planSelectionTransition(input)),
    ),
    openSession: Effect.fn("DeepSeekClaudeAdapter.openSession")(function* (sessionInput) {
      yield* assertFlashModel(sessionInput.modelSelection, "openSession");
      const session = yield* mapAdapterError(inner.openSession(sessionInput));
      return wrapSession(session);
    }),
  });
});
