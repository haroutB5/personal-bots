/**
 * The dsh ACP flavour: one process per chat on U's shared adapter, plus the
 * launch patch, reply stripper, stub colon and failure wording.
 * @module provider-deepseek/server/dshAdapter
 */
import * as NodeProcess from "node:process";

import {
  DEEPSEEK_DSH_MAX_INLINE_IMAGE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ProviderDriverKind,
  type ChatAttachment,
  type OrchestrationV2ProviderCapabilities,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

import { acpSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import { botStateDenyEnabled } from "@t3tools/provider-core/server/botProtectedPaths";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { AgentScope } from "@t3tools/shared/AgentScope";
import type { SelfInvocation } from "@t3tools/shared/nodeRuntime";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "@t3tools/provider-acp/server/adapter";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

import type { DeepSeekSettings } from "../settings.ts";
import {
  buildDshEnvironment,
  buildDshPersona,
  dshAgentModeFromSelection,
  makeDshColonStubber,
  makeDshReplyStripper,
  resolveDshEffort,
  serializeDshLaunchPatch,
  type DshAgentMode,
  type DshColonStubber,
  type DshReplyStripper,
} from "./dshSupport.ts";
import {
  makeDshAcpRuntime,
  removeDshLaunchPatch,
  resolveDshDenyPlugin,
  resolveDshRuntime,
  resolveDshSkillDirs,
  sweepDshLaunchDir,
  warnUnloadableDshSkills,
  writeDshLaunchPatch,
  type DshRuntime,
} from "./dshRuntime.ts";
import { DSH_HOME_DIR_NAME } from "./engine.ts";

const DRIVER_KIND = ProviderDriverKind.make("deepseek");

const IMAGE_MIME_TYPES = new Set(["image/bmp", "image/jpeg", "image/png", "image/webp"]);
const MAX_TOTAL_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/** "8.1 MB": one decimal, for a sentence the owner reads in the chat. */
function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What the owner reads when an image is past what the harness can validate. */
export function dshImageTooLargeText(input: {
  readonly name: string;
  readonly bytes: number;
}): string {
  const name = input.name.trim();
  const label = name.length > 0 ? ` "${name}"` : "";
  return (
    `DeepSeek can't read this image${label} (${formatMegabytes(input.bytes)}): the DeepSeek engine ` +
    `takes images up to ${formatMegabytes(DEEPSEEK_DSH_MAX_INLINE_IMAGE_BYTES)}. Send a smaller photo, ` +
    "or send it to a Claude bot."
  );
}

/**
 * dsh reports a stack overflow of its own as "prompt was not queued: Maximum
 * call stack size exceeded" with our decoder's frames under it. That sentence
 * names the harness's internals, so the chat gets a plain one instead.
 */
const DSH_STACK_OVERFLOW_TEXT =
  "DeepSeek could not take this message: the harness ran out of stack on it. " +
  "Send it again with a smaller image or shorter text.";

/**
 * dsh fails a turn with a JSON-RPC error in its own words. Auth and balance
 * have an hbots-side fix, so they are translated; a limit is worded as a
 * limit so the limit handling sees it, exactly as it does on the Claude engine.
 */
export function translateDshFailure(message: string): {
  readonly text: string;
  readonly rateLimited: boolean;
} {
  const lower = message.toLowerCase();
  if (lower.includes("insufficient balance") || lower.includes("insufficient_balance")) {
    return {
      text: "DeepSeek rate limit reached: the DeepSeek account has insufficient balance. Top it up, or wait for this bot's fallback model.",
      rateLimited: true,
    };
  }
  if (
    lower.includes("rate limit") ||
    lower.includes("too many requests") ||
    lower.includes("429") ||
    lower.includes("quota")
  ) {
    return {
      text: "DeepSeek rate limit reached. Send the message again once the limit resets.",
      rateLimited: true,
    };
  }
  if (
    lower.includes("authentication fails") ||
    lower.includes("invalid api key") ||
    lower.includes("api key is invalid") ||
    lower.includes("401")
  ) {
    return {
      text:
        "DeepSeek could not authenticate. Check the API key saved in this DeepSeek instance's " +
        "settings, then start a new thread.",
      rateLimited: false,
    };
  }
  if (lower.includes("maximum call stack size exceeded")) {
    return { text: DSH_STACK_OVERFLOW_TEXT, rateLimited: false };
  }
  const turnFailed = message.split("Internal error: turn failed: ")[1];
  if (turnFailed !== undefined) {
    return { text: `DeepSeek turn failed: ${turnFailed.trim()}`, rateLimited: false };
  }
  return { text: message, rateLimited: false };
}

/** The failure text an ACP error carries, without a cause chain. */
function failureText(cause: unknown): string {
  if (typeof cause === "string") return cause;
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    const message = (cause as { readonly message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(cause);
}

/** The text of one ACP content block, when it has any. */
function textContent(content: unknown): { readonly text: string } | undefined {
  if (typeof content !== "object" || content === null) return undefined;
  const block = content as Record<string, unknown>;
  if (block["type"] !== "text") return undefined;
  return typeof block["text"] === "string" ? { text: block["text"] } : undefined;
}

/** Replaces a text chunk's text, keeping the block's other fields. */
function withContentText(
  update: EffectAcpSchema.SessionUpdate,
  text: string,
): EffectAcpSchema.SessionUpdate {
  const record = update as Record<string, unknown>;
  const content = record["content"];
  if (typeof content !== "object" || content === null) return update;
  return { ...record, content: { ...(content as object), text } } as EffectAcpSchema.SessionUpdate;
}

interface ReplyState {
  stripper: DshReplyStripper;
  stubber: DshColonStubber;
  /** A full stop the stubber settled, waiting for the next visible chunk. */
  pendingStop: string;
  thoughtStarted: boolean;
  toolCallSinceThought: boolean;
}

const freshReplyState = (): ReplyState => ({
  stripper: makeDshReplyStripper(),
  stubber: makeDshColonStubber(),
  pendingStop: "",
  thoughtStarted: false,
  toolCallSinceThought: false,
});

interface DshSessionContext {
  readonly threadId: string;
  readonly botId: string | undefined;
  readonly mode: DshAgentMode;
}

export interface DeepSeekDshAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly settings: DeepSeekSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly selfInvocation: SelfInvocation;
  /** `<stateDir>/dsh`; the tests point it at a temp dir. */
  readonly dshHome?: string;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly testHooks?: Parameters<typeof makeAcpAdapterV2>[0]["testHooks"];
  /** Replaces only the child command (tests). The launch patch and environment stay. */
  readonly spawnForTest?: (input: {
    readonly patchFile: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly cwd: string;
    readonly runtimeDir: string;
    readonly binJs: string;
  }) => AcpSessionRuntime.AcpSpawnInput;
  /** The app's Performance-tab registry, injected so the package keeps no app import. */
  readonly registerProcess?: (input: {
    readonly threadId: string;
    readonly provider: string;
    readonly pid: number;
  }) => void;
  readonly forgetProcess?: (threadId: string, pid?: number) => void;
}

const DSH_PROVIDER_CAPABILITIES: OrchestrationV2ProviderCapabilities = AcpProviderCapabilitiesV2;

/**
 * One session's flavour. The launch patch needs inputs the shared adapter does
 * not pass to `makeRuntime` (mode, persona, bot id), so the factory opens each
 * session with its own flavour bound to that session's `openSession` input.
 */
function makeDshFlavor(input: {
  readonly options: DeepSeekDshAdapterOptions;
  readonly session: DshSessionContext;
  readonly states: Map<string, ReplyState>;
  readonly fileSystem: FileSystem.FileSystem;
  readonly host: ProviderHost.ProviderHost["Service"];
  readonly path: Path.Path;
}): AcpAdapterV2Flavor {
  const { options, session, states, fileSystem, host, path } = input;
  /** Tools whose leaked markup this session removed, waiting for a log context. */
  const pendingTools = new Set<string>();
  const stateFor = (sessionId: string): ReplyState => {
    const known = states.get(sessionId);
    if (known !== undefined) return known;
    const created = freshReplyState();
    states.set(sessionId, created);
    return created;
  };
  /** Logs each stripped tool once, from an effect context that carries the logger. */
  const flushWarnings = Effect.gen(function* () {
    for (const tool of pendingTools) {
      yield* Effect.logWarning("Removed DeepSeek tool-call markup from a bot reply", {
        threadId: session.threadId,
        tool,
        ...(session.botId === undefined ? {} : { botId: session.botId }),
      });
    }
    pendingTools.clear();
  });

  const makeRuntime = Effect.fn("DeepSeekDshAdapter.makeRuntime")(function* (
    runtimeInput: AcpAdapterV2RuntimeInput,
  ) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const provideFs = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
      effect.pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
    const runtimeInfo: DshRuntime = yield* provideFs(resolveDshRuntime(options.settings));
    const dshHome = options.dshHome ?? path.join(host.paths.stateDir, DSH_HOME_DIR_NAME);
    const skillDirs = yield* provideFs(
      resolveDshSkillDirs({
        baseDir: host.paths.baseDir,
        botId: session.botId,
        cwd: runtimeInput.cwd,
      }),
    ).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
    yield* provideFs(warnUnloadableDshSkills({ botId: session.botId, skillDirs })).pipe(
      Effect.ignore,
    );
    const deny = yield* provideFs(
      resolveDshDenyPlugin({
        runtimeDir: runtimeInfo.runtimeDir,
        paths: { secretsDir: host.paths.secretsDir, dbPath: host.paths.dbPath },
        dshHome,
        enabled: botStateDenyEnabled(),
      }),
    ).pipe(Effect.orElseSucceed(() => undefined));
    // v2 sends the runtime and bot instructions with every prompt, so the
    // launch carries only dsh's own reply style.
    const persona = buildDshPersona(undefined, "");
    const patchFile = yield* provideFs(
      writeDshLaunchPatch({
        dshHome,
        threadId: session.threadId,
        patch: serializeDshLaunchPatch({
          personaSuffix: persona,
          skillDirs,
          mode: session.mode,
          ...(deny === undefined ? {} : { deny }),
        }),
      }),
    );
    const environment = yield* provideFs(
      buildDshEnvironment({
        instanceEnv: { ...options.environment, ...runtimeInput.processEnvironment },
        runtimeMode: runtimeInput.runtimePolicy.runtimeMode,
        dshHome,
      }),
    );
    yield* Effect.logInfo("DeepSeek Harness runtime resolved", {
      threadId: session.threadId,
      runtimeDir: runtimeInfo.runtimeDir,
      version: runtimeInfo.version,
    });
    let startedPid: number | undefined;
    const forget = Effect.sync(() => {
      if (startedPid !== undefined) options.forgetProcess?.(session.threadId, startedPid);
    });
    const scope = yield* Effect.scope;
    yield* Scope.addFinalizer(
      scope,
      Effect.gen(function* () {
        yield* forget;
        yield* provideFs(removeDshLaunchPatch({ dshHome, threadId: session.threadId })).pipe(
          Effect.ignore,
        );
      }),
    );
    const spawn = options.spawnForTest?.({
      patchFile,
      environment,
      cwd: runtimeInput.cwd,
      runtimeDir: runtimeInfo.runtimeDir,
      binJs: runtimeInfo.binJs,
    }) ?? {
      command: NodeProcess.execPath,
      args: [runtimeInfo.binJs, "--profile", "acp", "--patch", patchFile],
      cwd: runtimeInput.cwd,
      env: environment,
    };
    return yield* makeDshAcpRuntime({
      ...runtimeInput,
      spawn,
      childProcessSpawner: spawner,
      onProcessStarted: (pid) => {
        startedPid = pid;
        options.registerProcess?.({ threadId: session.threadId, provider: DRIVER_KIND, pid });
      },
      onTermination: (error) => forget.pipe(Effect.andThen(runtimeInput.onTermination(error))),
    });
  });

  return {
    driver: DRIVER_KIND,
    runtimeHarness: "DeepSeek Harness",
    capabilities: DSH_PROVIDER_CAPABILITIES,
    mcpOverHttp: true,
    makeRuntime,
    applyModelSelection: Effect.fn("DeepSeekDshAdapter.applyModelSelection")(function* ({
      runtime: acpRuntime,
      modelSelection,
    }) {
      const effort = resolveDshEffort(modelSelection);
      const configOptions = yield* acpRuntime.getConfigOptions;
      if (configOptions.some((option) => option.id === "reasoning_effort")) {
        yield* acpRuntime.setConfigOption("reasoning_effort", effort);
      }
      return undefined;
    }),
    buildPrompt: Effect.fn("DeepSeekDshAdapter.buildPrompt")(function* ({
      text,
      attachments,
      resolveAttachmentPath,
    }) {
      const blocks: Array<EffectAcpSchema.ContentBlock> = [];
      if (text.trim().length > 0) blocks.push({ type: "text", text });
      const overCap = yield* findDshImageOverCap({
        attachments,
        resolveAttachmentPath,
        fileSystem,
      });
      if (overCap !== undefined) {
        return yield* EffectAcpErrors.AcpRequestError.invalidParams(dshImageTooLargeText(overCap));
      }
      let totalBytes = 0;
      for (const attachment of attachments) {
        if (attachment.type !== "image") continue;
        const mimeType = attachment.mimeType.toLowerCase().split(";", 1)[0] ?? "";
        if (!IMAGE_MIME_TYPES.has(mimeType)) continue;
        const attachmentPath = resolveAttachmentPath(attachment);
        if (attachmentPath === null) continue;
        const info = yield* fileSystem
          .stat(attachmentPath)
          .pipe(Effect.orElseSucceed(() => undefined));
        if (info === undefined || info.type !== "File") continue;
        const size = Number(info.size);
        if (size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) continue;
        totalBytes += size;
        if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) break;
        const bytes = yield* fileSystem
          .readFile(attachmentPath)
          .pipe(Effect.orElseSucceed(() => undefined));
        if (bytes === undefined) continue;
        blocks.push({ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType });
      }
      if (blocks.length === 0) {
        return yield* EffectAcpErrors.AcpRequestError.invalidParams(
          "A turn requires text or a supported attachment.",
        );
      }
      return blocks;
    }),
    normalizeSessionUpdate: (notification) => {
      const update = notification.update;
      const sessionId = notification.sessionId;
      if (update.sessionUpdate === "agent_message_chunk") {
        const content = textContent(update.content);
        if (content === undefined) return notification;
        const state = stateFor(sessionId);
        const stripped = state.stripper.push(content.text);
        for (const tool of stripped.tools) pendingTools.add(tool);
        let text = state.stubber.push(stripped.text);
        if (state.pendingStop !== "") {
          text = `${state.pendingStop}${text}`;
          state.pendingStop = "";
        }
        return { ...notification, update: withContentText(update, text) };
      }
      if (update.sessionUpdate === "agent_thought_chunk") {
        const content = textContent(update.content);
        if (content === undefined) return notification;
        const state = stateFor(sessionId);
        const paragraph = state.thoughtStarted && state.toolCallSinceThought ? "\n\n" : "";
        state.thoughtStarted = true;
        state.toolCallSinceThought = false;
        return paragraph === ""
          ? notification
          : { ...notification, update: withContentText(update, `${paragraph}${content.text}`) };
      }
      if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
        const state = stateFor(sessionId);
        state.toolCallSinceThought = true;
        const stop = state.stubber.closeByToolCall();
        if (stop !== "") state.pendingStop = stop;
        return notification;
      }
      return notification;
    },
    watchPromptOutcome: (sessionId) =>
      Effect.sync(() => {
        states.set(sessionId, freshReplyState());
        return () => flushWarnings.pipe(Effect.as(undefined));
      }),
    onSessionEvent: () => flushWarnings,
    promptFailure: (cause) => {
      const translated = translateDshFailure(failureText(cause));
      return {
        class: translated.rateLimited ? "usage_limit" : "provider_error",
        message: translated.text,
        code: null,
        retryable: translated.rateLimited ? true : null,
      };
    },
  };
}

/**
 * The first inline image past what the harness can validate, before the
 * session sees it. The harness's own base64 regex overflows on this payload.
 */
const findDshImageOverCap = Effect.fn("DeepSeekDshAdapter.findDshImageOverCap")(function* (input: {
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly resolveAttachmentPath: (attachment: ChatAttachment) => string | null;
  readonly fileSystem: FileSystem.FileSystem;
}) {
  const fileSystem = input.fileSystem;
  for (const attachment of input.attachments) {
    if (attachment.type !== "image") continue;
    const mimeType = attachment.mimeType.toLowerCase().split(";", 1)[0] ?? "";
    if (!IMAGE_MIME_TYPES.has(mimeType)) continue;
    const attachmentPath = input.resolveAttachmentPath(attachment);
    if (attachmentPath === null) continue;
    const info = yield* fileSystem.stat(attachmentPath).pipe(Effect.orElseSucceed(() => undefined));
    if (info === undefined || info.type !== "File") continue;
    const size = Number(info.size);
    if (size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) continue;
    if (size > DEEPSEEK_DSH_MAX_INLINE_IMAGE_BYTES) {
      return { name: attachment.name, bytes: size };
    }
  }
  return undefined;
});

export const makeDeepSeekDshAdapter = Effect.fn("makeDeepSeekDshAdapter")(function* (
  options: DeepSeekDshAdapterOptions,
) {
  const host = yield* ProviderHost.ProviderHost;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const secureRandom = yield* SecureRandom.SecureRandom;
  const fileSystem = yield* FileSystem.FileSystem;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const agentScope = yield* AgentScope;
  const states = new Map<string, ReplyState>();
  const dshHome = options.dshHome ?? path.join(host.paths.stateDir, DSH_HOME_DIR_NAME);
  yield* sweepDshLaunchDir({ dshHome }).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
    Effect.ignore,
  );
  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: DRIVER_KIND,
    getCapabilities: Effect.fn("DeepSeekDshAdapter.getCapabilities")(() =>
      Effect.succeed(DSH_PROVIDER_CAPABILITIES),
    ),
    planSelectionTransition: Effect.fn("DeepSeekDshAdapter.planSelectionTransition")((planInput) =>
      Effect.succeed(acpSelectionTransition(planInput)),
    ),
    openSession: Effect.fn("DeepSeekDshAdapter.openSession")(function* (
      sessionInput: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
    ) {
      const session: DshSessionContext = {
        threadId: String(sessionInput.threadId),
        botId: sessionInput.personal?.personalBotId,
        mode: dshAgentModeFromSelection(sessionInput.modelSelection),
      };
      const inner = yield* makeAcpAdapterV2({
        instanceId: options.instanceId,
        flavor: makeDshFlavor({ options, session, states, fileSystem, host, path }),
        selfInvocation: options.selfInvocation,
        ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
        ...(options.testHooks === undefined ? {} : { testHooks: options.testHooks }),
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(SecureRandom.SecureRandom, secureRandom),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(IdAllocator.IdAllocatorV2, idAllocator),
        Effect.provideService(McpProviderSessions.McpProviderSessions, mcpSessions),
        Effect.provideService(ProviderHost.ProviderHost, host),
        Effect.provideService(AgentScope, agentScope),
      );
      return yield* inner.openSession(sessionInput);
    }),
  });
});
