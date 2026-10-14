/**
 * DeepSeekDshAdapter — the `deepseek` adapter on the DeepSeek Harness (dsh).
 *
 * One dsh process per chat, in ACP mode over stdio, reached through hbots'
 * shared `AcpSessionRuntime` (the same shape Antigravity uses). Every launch
 * carries a generated overlay patch: the bot's persona, its skill folders, its
 * agent mode and the bot-state deny plugin. See `acp/DshAcpSupport.ts` for the
 * patch and `dshUsageLedger.ts` for the usage ledger ACP cannot carry.
 *
 * Deliberate differences from the Grok/Antigravity shape:
 * - **Steer never cancels.** dsh refuses a second prompt while one is in
 *   flight, and cancelling to take the new one would kill the tool the turn is
 *   running. A message that arrives mid-turn is held and started as its own
 *   turn the moment the current one settles (`userMessageDelivery:
 *   "turn-started"`, the same machinery Codex's queued turns use). Stop still
 *   cancels, and a message already held still runs: it is the owner's.
 * - **A mode change applies to new chats only.** DeepSeek's API refuses a
 *   resumed Standard session under the Code overlay (deferred tools), so the
 *   mode is pinned in the resume cursor and logged when it differs.
 * - **A cursor dsh cannot resume is not a hard error.** A cursor from the
 *   Claude engine (or a chat whose dsh session is gone) fails the first turn
 *   with the missing-conversation text, which makes the server renew the
 *   session and carry the chat over from its text.
 *
 * @module provider/Layers/DeepSeekDshAdapter
 */
import {
  ApprovalRequestId,
  DEEPSEEK_DSH_MAX_INLINE_IMAGE_BYTES,
  DEEPSEEK_FLASH_MODEL,
  DEEPSEEK_AGENT_MODE_OPTION_ID,
  EventId,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  TurnId,
  type ChatAttachment,
  type ModelSelection,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderUserInputAnswers,
  type ThreadId,
  type TurnCompletedPayload,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { botStateDenyEnabled } from "../../personal/secrets/botProtectedPaths.ts";
import { forgetBotProviderProcess, registerBotProviderProcess } from "../botProviderProcesses.ts";
import { canonicalizeDeepSeekModelId, DEEPSEEK_FLASH_SLUG } from "../DeepSeekModelCatalog.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpThreadTokenUsageEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  buildDshEnvironment,
  buildDshPersona,
  dshAgentModeFromSelection,
  DSH_RESUME_ENGINE,
  makeDshAcpRuntime,
  parseDshResumeCursor,
  resolveDshDenyPlugin,
  resolveDshEffort,
  resolveDshSessionMode,
  resolveDshSkillDirs,
  serializeDshLaunchPatch,
  sweepDshLaunchDir,
  writeDshLaunchPatch,
  removeDshLaunchPatch,
  type DshAcpRuntimeInput,
  type DshAgentMode,
  type DshRuntime,
} from "../acp/DshAcpSupport.ts";
import {
  appendDshLedgerLines,
  decodeDshSessionFrames,
  dshSessionFilePath,
  dshStepToTranscriptLine,
  dshUsageDir,
  findDshDescendantSessions,
  parseDshAssistantStep,
  readDshSessionBytes,
  readLedgerLastSeq,
} from "../dshUsageLedger.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("deepseek");

type Adapter = ProviderAdapterShape<ProviderAdapterError>;
type Runtime = AcpSessionRuntime.AcpSessionRuntime["Service"];
type StartInput = ProviderSessionStartInput;

/** What the server matches to renew a session (see `missingProviderConversation`). */
export function dshMissingConversationText(sessionId: string): string {
  return `No conversation found with session ID: ${sessionId} (DeepSeek Harness)`;
}

/** dsh's wording when the session a launch named cannot be resumed. */
const DSH_NOT_RESUMABLE_PATTERN = /not resumable|no such session|unknown session/i;

/**
 * dsh fails a turn with a JSON-RPC error in its own words. Auth and balance
 * have an hbots-side fix (a key, a top-up), so they are translated; a limit is
 * worded as a limit so `classifyProviderError` and the bot's usage-limit
 * fallback see it, exactly as they do on the Claude engine.
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

interface PendingApproval {
  readonly request: EffectAcpSchema.RequestPermissionRequest;
  readonly response: Deferred.Deferred<{
    readonly decision: ProviderApprovalDecision;
    readonly result: EffectAcpSchema.RequestPermissionResponse;
  }>;
}

interface HeldTurn {
  readonly turnId: TurnId;
  readonly prompt: ReadonlyArray<EffectAcpSchema.ContentBlock>;
}

interface LedgerState {
  offset: number;
  lastSeq: number;
  readonly descendants: Set<string>;
  loaded: boolean;
}

interface DshProcess {
  readonly scope: Scope.Closeable;
  readonly runtime: Runtime;
  readonly sessionId: string;
  readonly pid: number | undefined;
  readonly personaHash: string;
  readonly mode: DshAgentMode;
}

interface SessionContext {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly botId: string | undefined;
  readonly promptLock: Semaphore.Semaphore;
  readonly stopLock: Semaphore.Semaphore;
  readonly approvals: Map<ApprovalRequestId, PendingApproval>;
  readonly turns: Array<{ readonly id: TurnId; readonly items: Array<unknown> }>;
  readonly ledger: LedgerState;
  /** The owner's messages that arrived while a turn was in flight, in order. */
  readonly held: Array<HeldTurn>;
  process: DshProcess | undefined;
  /** The native session id the running process answers to. */
  nativeSessionId: string | undefined;
  /** The id a cursor named that dsh cannot resume, until the server renews it. */
  foreignCursorId: string | undefined;
  /** A bot edit seen since the process started, applied by the next turn. */
  pendingPersona: { readonly hash: string; readonly instructions: string } | undefined;
  /** The reasoning effort the next turn should run at, when one was chosen. */
  pendingEffort: string | undefined;
  session: ProviderSession;
  activeTurnId: TurnId | undefined;
  promptFiber: Fiber.Fiber<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError> | undefined;
  generation: number;
  draining: boolean;
  stopped: boolean;
  closed: boolean;
  disconnected: boolean;
}

export interface DeepSeekDshAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly runtime: DshRuntime;
  /** `<stateDir>/dsh`: this data root's harness home. */
  readonly dshHome: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  /**
   * Test seam: build the ACP runtime another way. Defaults to the real one
   * (`makeDshAcpRuntime`) with this adapter's spawner; the recorded-order
   * integration test passes a fake spawner instead so the real runtime drives
   * `scripts/acp-mock-agent.ts` in its dsh profile.
   */
  readonly makeRuntime?: (
    input: Omit<DshAcpRuntimeInput, "childProcessSpawner">,
  ) => Effect.Effect<Runtime, EffectAcpErrors.AcpError, Crypto.Crypto | Scope.Scope>;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

/** Hashes the persona, so a bot edit can tell whether the process is stale. */
const hashPersona = (value: string): string => {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0;
  }
  return `${value.length}:${hash}`;
};

const IMAGE_MIME_TYPES = new Set(["image/bmp", "image/jpeg", "image/png", "image/webp"]);
const MAX_TOTAL_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/**
 * The inline-image limit is the shared `DEEPSEEK_DSH_MAX_INLINE_IMAGE_BYTES`
 * from `@t3tools/contracts`, which the web composers downscale to as well (the
 * harness's `decodeImage` regex needs it small; see the constant's own note). A
 * bigger image is refused below with {@link dshImageTooLargeText} instead of
 * being sent to a runtime that cannot validate it.
 */
const DSH_MAX_INLINE_IMAGE_BYTES = DEEPSEEK_DSH_MAX_INLINE_IMAGE_BYTES;

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
    `takes images up to ${formatMegabytes(DSH_MAX_INLINE_IMAGE_BYTES)}. Send a smaller photo, ` +
    "or send it to a Claude bot."
  );
}

/**
 * dsh reports a stack overflow of its own as "prompt was not queued: Maximum
 * call stack size exceeded" with our decoder's frames under it. That sentence
 * names the harness's internals and no fix the owner can make, so the chat gets
 * a plain one instead; the raw text stays in the logs.
 */
const DSH_STACK_OVERFLOW_TEXT =
  "DeepSeek could not take this message: the harness ran out of stack on it. " +
  "Send it again with a smaller image or shorter text.";

const assertFlashModel = (
  modelSelection: ModelSelection | undefined,
  operation: string,
): Effect.Effect<void, ProviderAdapterError> =>
  Effect.gen(function* () {
    const raw = modelSelection?.model?.trim();
    if (!raw || canonicalizeDeepSeekModelId(raw) === DEEPSEEK_FLASH_SLUG) return;
    return yield* new ProviderAdapterValidationError({
      provider: PROVIDER,
      operation,
      issue: `DeepSeek supports only DeepSeek V4.1 Flash ("deepseek-flash"); "${raw}" is not accepted here.`,
    });
  });

/** Reads the id a cursor names when it is not a dsh cursor (a Claude session). */
export function readForeignCursorId(cursor: unknown): string | undefined {
  if (typeof cursor === "string" && cursor.length > 0) return cursor;
  if (typeof cursor !== "object" || cursor === null) return undefined;
  const record = cursor as Record<string, unknown>;
  for (const field of ["resume", "sessionId", "threadId", "id"]) {
    const value = record[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * The first inline image past what the harness can validate, or undefined.
 *
 * Shared by {@link validateTurn} — asked before the session is started, so the
 * refusal cannot be overwritten by that session's own start events — and by
 * `buildDshPrompt`, which keeps the same guard as the per-turn backstop. The
 * sentence and the limit therefore come from one place.
 */
const findDshImageOverCap = (input: {
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly attachmentsDir: string;
}): Effect.Effect<
  { readonly name: string; readonly bytes: number } | undefined,
  never,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    for (const attachment of input.attachments ?? []) {
      if (attachment.type !== "image") continue;
      const mimeType = attachment.mimeType.toLowerCase().split(";", 1)[0] ?? "";
      if (!IMAGE_MIME_TYPES.has(mimeType)) continue;
      const attachmentPath = resolveAttachmentPath({
        attachmentsDir: input.attachmentsDir,
        attachment,
      });
      if (!attachmentPath) continue;
      const info = yield* fileSystem
        .stat(attachmentPath)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (info === undefined || info.type !== "File") continue;
      const size = Number(info.size);
      // Past the wire cap the prompt leaves the image out, as it always has;
      // between the two caps is the payload the harness overflows on.
      if (size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) continue;
      if (size > DSH_MAX_INLINE_IMAGE_BYTES) return { name: attachment.name, bytes: size };
    }
    return undefined;
  });

/**
 * The ACP prompt for a turn: the message, any image inline, and the plan
 * instruction when the owner asked for a plan (ACP has no mode for it). Every
 * other attachment is reached by the path the server already put in the text.
 */
export const buildDshPrompt = Effect.fn("buildDshPrompt")(function* (input: {
  readonly input: string | undefined;
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly attachmentsDir: string;
  readonly interactionMode: "default" | "plan" | undefined;
}): Effect.fn.Return<
  ReadonlyArray<EffectAcpSchema.ContentBlock>,
  ProviderAdapterError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const blocks: Array<EffectAcpSchema.ContentBlock> = [];
  if (input.interactionMode === "plan") {
    blocks.push({
      type: "text",
      text: "Plan only for this turn: describe what you would change and in what order, and change nothing until the plan is approved.",
    });
  }
  const text = input.input?.trim();
  if (text) blocks.push({ type: "text", text });
  // Refused before the prompt is built, so the runtime never sees a payload its
  // own validator overflows on (see DSH_MAX_INLINE_IMAGE_BYTES).
  const overCap = yield* findDshImageOverCap({
    attachments: input.attachments,
    attachmentsDir: input.attachmentsDir,
  });
  if (overCap !== undefined) {
    return yield* new ProviderAdapterRequestError({
      provider: PROVIDER,
      method: "session/prompt",
      detail: dshImageTooLargeText(overCap),
    });
  }
  let totalBytes = 0;
  for (const attachment of input.attachments ?? []) {
    if (attachment.type !== "image") continue;
    const mimeType = attachment.mimeType.toLowerCase().split(";", 1)[0] ?? "";
    if (!IMAGE_MIME_TYPES.has(mimeType)) continue;
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: input.attachmentsDir,
      attachment,
    });
    if (!attachmentPath) continue;
    const info = yield* fileSystem.stat(attachmentPath).pipe(Effect.orElseSucceed(() => undefined));
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
    return yield* new ProviderAdapterRequestError({
      provider: PROVIDER,
      method: "session/prompt",
      detail: "A turn requires text or a supported attachment.",
    });
  }
  return blocks;
});

/** Keeps one dsh process per chat, each with its own launch patch. */
export const makeDeepSeekDshAdapter = Effect.fn("makeDeepSeekDshAdapter")(function* (
  options: DeepSeekDshAdapterOptions,
) {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const ownerScope = yield* Effect.scope;
  const makeNativeLoggers = yield* makeAcpNativeLoggerFactory();
  const sessions = new Map<ThreadId, SessionContext>();
  const locks = yield* SynchronizedRef.make(new Map<ThreadId, Semaphore.Semaphore>());
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const randomId = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Could not create a DeepSeek Harness event ID.",
          cause,
        }),
    ),
  );
  const stamp = Effect.all({ eventId: Effect.map(randomId, EventId.make), createdAt: nowIso });
  const emit = (event: ProviderRuntimeEvent) => PubSub.publish(events, event).pipe(Effect.asVoid);
  const provideFs = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  const makeRuntime =
    options.makeRuntime ??
    ((input: Omit<DshAcpRuntimeInput, "childProcessSpawner">) =>
      makeDshAcpRuntime({ ...input, childProcessSpawner: options.childProcessSpawner }));

  // A crashed session can leave its launch patch behind; it holds bot
  // instructions for a chat that may no longer exist.
  yield* sweepDshLaunchDir({ dshHome: options.dshHome }).pipe(provideFs, Effect.ignore);

  const withThreadLock = <A, E, R>(threadId: ThreadId, task: Effect.Effect<A, E, R>) =>
    SynchronizedRef.modifyEffect(locks, (current) => {
      const existing = current.get(threadId);
      if (existing) return Effect.succeed([existing, current] as const);
      return Semaphore.make(1).pipe(
        Effect.map((lock) => [lock, new Map(current).set(threadId, lock)] as const),
      );
    }).pipe(Effect.flatMap((lock) => lock.withPermit(task)));

  const requireSession = (threadId: ThreadId) => {
    const context = sessions.get(threadId);
    return context && !context.stopped
      ? Effect.succeed(context)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };

  /* ---------------------------------------------------------------------- */
  /* Usage ledger                                                            */
  /* ---------------------------------------------------------------------- */

  /**
   * Writes what the session log gained since the last flush, in the Claude
   * transcript shape the usage scan already reads. Content-free by design:
   * token counts, ids and a timestamp only.
   */
  const flushLedger = (context: SessionContext) =>
    Effect.sync(() => {
      const sessionId = context.nativeSessionId;
      if (sessionId === undefined) return;
      const file = dshSessionFilePath(options.dshHome, sessionId);
      if (file === undefined) return;
      const bytes = readDshSessionBytes(file);
      if (bytes === undefined) return;
      const state = context.ledger;
      if (!state.loaded) {
        state.loaded = true;
        state.offset = 0;
        state.lastSeq = readLedgerLastSeq(
          path.join(dshUsageDir(options.dshHome), `${sessionId}.jsonl`),
          sessionId,
        );
      }
      const decoded = decodeDshSessionFrames(bytes, state.offset);
      state.offset = decoded.offset;
      const lines: string[] = [];
      for (const line of decoded.lines) {
        const step = parseDshAssistantStep(line);
        if (step === null || step.seq <= state.lastSeq) continue;
        state.lastSeq = step.seq;
        // The root session always owns the ledger line, so the spend a
        // subagent did is attributed to the chat that started it.
        lines.push(dshStepToTranscriptLine({ step, rootSessionId: sessionId }));
      }
      for (const descendant of findDshDescendantSessions({
        dshHome: options.dshHome,
        rootSessionId: sessionId,
        sessionFilePath: file,
        alreadyKnown: state.descendants,
      })) {
        state.descendants.add(descendant.sessionId);
      }
      appendDshLedgerLines(path.join(dshUsageDir(options.dshHome), `${sessionId}.jsonl`), lines);
    }).pipe(Effect.catchCause(() => Effect.void));

  /* ---------------------------------------------------------------------- */
  /* Launch patch                                                            */
  /* ---------------------------------------------------------------------- */

  const buildPatch = Effect.fn("DeepSeekDshAdapter.buildPatch")(function* (input: {
    readonly cwd: string;
    readonly botId: string | undefined;
    readonly mode: DshAgentMode;
    readonly systemInstructions: string | undefined;
  }) {
    const skillDirs = yield* resolveDshSkillDirs({
      baseDir: serverConfig.baseDir,
      botId: input.botId,
      cwd: input.cwd,
    }).pipe(
      provideFs,
      Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
    );
    const deny = yield* resolveDshDenyPlugin({
      runtimeDir: options.runtime.runtimeDir,
      paths: { secretsDir: serverConfig.secretsDir, dbPath: serverConfig.dbPath },
      dshHome: options.dshHome,
      enabled: botStateDenyEnabled(),
    }).pipe(provideFs);
    const persona = buildDshPersona(
      input.systemInstructions,
      buildRuntimeInstructions({ harness: "DeepSeek Harness" }),
    );
    return {
      patch: serializeDshLaunchPatch({
        personaSuffix: persona,
        skillDirs,
        mode: input.mode,
        ...(deny === undefined ? {} : { deny }),
      }),
      personaHash: hashPersona(persona),
    };
  });

  /* ---------------------------------------------------------------------- */
  /* Event mapping                                                           */
  /* ---------------------------------------------------------------------- */

  const handleEvent = Effect.fn("DeepSeekDshAdapter.handleEvent")(function* (
    context: SessionContext,
    event: AcpSessionRuntime.AcpSessionRuntimeEvent,
  ) {
    if (event._tag === "EventStreamBarrier") {
      yield* Deferred.succeed(event.acknowledge, undefined);
      return;
    }
    if (context.stopped) return;
    switch (event._tag) {
      case "ModeChanged":
      case "AvailableCommandsUpdated":
      case "ConfigOptionsUpdated":
      case "PlanUpdated":
        return;
      case "ConnectionTerminated":
        context.stopped = true;
        context.disconnected = true;
        yield* stopContext(context).pipe(Effect.forkIn(ownerScope));
        return;
      case "AssistantItemStarted":
      case "AssistantItemCompleted":
        yield* emit(
          makeAcpAssistantItemEvent({
            stamp: yield* stamp,
            provider: PROVIDER,
            threadId: context.threadId,
            turnId: context.activeTurnId,
            itemId: event.itemId,
            lifecycle: event._tag === "AssistantItemStarted" ? "item.started" : "item.completed",
          }),
        );
        return;
      case "UsageUpdated":
        yield* emit(
          makeAcpThreadTokenUsageEvent({
            stamp: yield* stamp,
            provider: PROVIDER,
            threadId: context.threadId,
            turnId: context.activeTurnId,
            usedTokens: event.usedTokens,
            ...(event.maxTokens !== undefined ? { maxTokens: event.maxTokens } : {}),
            rawPayload: event.rawPayload,
          }),
        );
        return;
      case "ThoughtDelta":
      case "ContentDelta":
        yield* emit(
          makeAcpContentDeltaEvent({
            stamp: yield* stamp,
            provider: PROVIDER,
            threadId: context.threadId,
            turnId: context.activeTurnId,
            ...(event._tag === "ContentDelta" && event.itemId ? { itemId: event.itemId } : {}),
            ...(event._tag === "ThoughtDelta" ? { streamKind: "reasoning_text" } : {}),
            text: event.text,
            rawPayload: event.rawPayload,
          }),
        );
        return;
      case "ToolCallUpdated":
        yield* emit(
          makeAcpToolCallEvent({
            stamp: yield* stamp,
            provider: PROVIDER,
            threadId: context.threadId,
            turnId: context.activeTurnId,
            toolCall: event.toolCall,
            rawPayload: event.rawPayload,
          }),
        );
        return;
    }
  });

  const cancelPendingApprovals = (context: SessionContext) =>
    Effect.gen(function* () {
      for (const pending of context.approvals.values()) {
        yield* Deferred.succeed(pending.response, {
          decision: "cancel",
          result: { outcome: { outcome: "cancelled" } },
        });
      }
    });

  const handlePermission = Effect.fn("DeepSeekDshAdapter.handlePermission")(function* (
    context: SessionContext,
    request: EffectAcpSchema.RequestPermissionRequest,
  ): Effect.fn.Return<EffectAcpSchema.RequestPermissionResponse, ProviderAdapterError> {
    if (context.stopped || request.sessionId !== context.nativeSessionId) {
      return { outcome: { outcome: "cancelled" } };
    }
    const requestId = ApprovalRequestId.make(yield* randomId);
    const runtimeRequestId = RuntimeRequestId.make(requestId);
    const turnId = context.activeTurnId;
    const response = yield* Deferred.make<{
      decision: ProviderApprovalDecision;
      result: EffectAcpSchema.RequestPermissionResponse;
    }>();
    context.approvals.set(requestId, { request, response });
    const parsed = parsePermissionRequest(request);
    const permissionRequest = {
      ...parsed,
      detail:
        parsed.toolCall?.command ??
        parsed.toolCall?.title ??
        parsed.toolCall?.detail ??
        "DeepSeek Harness requests permission.",
    };
    // dsh offers `allow-once` and `reject-once` and nothing else.
    const approvalOptions = [
      { decision: "accept" as const, label: "Allow once" },
      { decision: "decline" as const, label: "Deny" },
      { decision: "cancel" as const, label: "Cancel" },
    ];
    return yield* Effect.gen(function* () {
      yield* emit(
        makeAcpRequestOpenedEvent({
          stamp: yield* stamp,
          provider: PROVIDER,
          threadId: context.threadId,
          turnId,
          requestId: runtimeRequestId,
          permissionRequest,
          approvalOptions,
          detail: permissionRequest.detail,
          args: request,
          source: "acp.jsonrpc",
          method: "session/request_permission",
          rawPayload: request,
        }),
      );
      const answer = yield* Deferred.await(response);
      yield* emit(
        makeAcpRequestResolvedEvent({
          stamp: yield* stamp,
          provider: PROVIDER,
          threadId: context.threadId,
          turnId,
          requestId: runtimeRequestId,
          permissionRequest,
          decision: answer.decision,
        }),
      );
      return answer.result;
    }).pipe(Effect.ensuring(Effect.sync(() => context.approvals.delete(requestId))));
  });

  /* ---------------------------------------------------------------------- */
  /* Process lifecycle                                                       */
  /* ---------------------------------------------------------------------- */

  /**
   * Starts one dsh process for a chat: writes its launch patch, builds the ACP
   * runtime, registers the permission handler, starts (or resumes) the
   * session, forks the event consumer into the process's own scope and
   * registers the PID for the Performance tab.
   */
  const startProcess = Effect.fn("DeepSeekDshAdapter.startProcess")(function* (
    context: SessionContext,
    input: {
      readonly mode: DshAgentMode;
      readonly systemInstructions: string | undefined;
      readonly runtimeMode: ProviderSession["runtimeMode"];
      readonly resumeSessionId?: string;
    },
  ): Effect.fn.Return<DshProcess, ProviderAdapterError> {
    const built = yield* buildPatch({
      cwd: context.cwd,
      botId: context.botId,
      mode: input.mode,
      systemInstructions: input.systemInstructions,
    });
    const patchFile = yield* writeDshLaunchPatch({
      dshHome: options.dshHome,
      threadId: context.threadId,
      patch: built.patch,
    }).pipe(provideFs);
    const mcp = McpProviderSession.readMcpProviderSession(context.threadId);
    const environment = yield* buildDshEnvironment({
      instanceEnv: McpProviderSession.withAgentDeviceEnvironment(options.environment, mcp),
      runtimeMode: input.runtimeMode,
      dshHome: options.dshHome,
    }).pipe(provideFs);
    const processScope = yield* Scope.make("sequential");
    let pid: number | undefined;
    return yield* Effect.gen(function* () {
      const runtime = yield* makeRuntime({
        spawn: {
          // hbots' own node, no shell.
          command: process.execPath,
          args: [options.runtime.binJs, "--profile", "acp", "--patch", patchFile],
          cwd: context.cwd,
          env: environment,
        },
        cwd: context.cwd,
        ...(input.resumeSessionId !== undefined ? { resumeSessionId: input.resumeSessionId } : {}),
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
        additionalDirectories: [serverConfig.attachmentsDir],
        onProcessStarted: (startedPid) =>
          Effect.sync(() => {
            pid = startedPid;
          }),
        ...makeNativeLoggers({
          nativeEventLogger: options.nativeEventLogger,
          provider: PROVIDER,
          threadId: context.threadId,
        }),
      }).pipe(
        Effect.provideService(Scope.Scope, processScope),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.mapError(
          (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: context.threadId,
              detail: "Could not start the DeepSeek Harness process.",
              cause,
            }),
        ),
      );
      yield* runtime.handleRequestPermission((request) =>
        handlePermission(context, request).pipe(
          Effect.mapError((cause) =>
            EffectAcpErrors.AcpRequestError.internalError(
              "Could not process a DeepSeek Harness permission request.",
              undefined,
              { cause },
            ),
          ),
        ),
      );
      const started = yield* runtime
        .start()
        .pipe(
          Effect.mapError((cause) =>
            mapAcpToAdapterError(PROVIDER, context.threadId, "session/start", cause),
          ),
        );
      context.nativeSessionId = started.sessionId;
      yield* Stream.runForEach(runtime.getEvents(), (event) => handleEvent(context, event)).pipe(
        Effect.catchCause(() =>
          Effect.logError("Could not process a DeepSeek Harness runtime event."),
        ),
        Effect.forkIn(processScope),
      );
      yield* runtime.drainEvents;
      if (pid !== undefined) {
        registerBotProviderProcess({ threadId: context.threadId, provider: PROVIDER, pid });
      }
      return {
        scope: processScope,
        runtime,
        sessionId: started.sessionId,
        pid,
        personaHash: built.personaHash,
        mode: input.mode,
      } satisfies DshProcess;
    }).pipe(Effect.onError(() => Scope.close(processScope, Exit.void)));
  });

  const closeProcess = (context: SessionContext, process: DshProcess) =>
    Effect.gen(function* () {
      if (process.pid !== undefined) forgetBotProviderProcess(context.threadId, process.pid);
      yield* Scope.close(process.scope, Exit.void);
      yield* removeDshLaunchPatch({
        dshHome: options.dshHome,
        threadId: context.threadId,
      }).pipe(provideFs);
    }).pipe(Effect.ignore);

  /* ---------------------------------------------------------------------- */
  /* Session lifecycle                                                       */
  /* ---------------------------------------------------------------------- */

  const stopContext = (context: SessionContext) =>
    context.stopLock
      .withPermit(
        Effect.gen(function* () {
          if (context.closed) return;
          context.stopped = true;
          const process = context.process;
          context.process = undefined;
          context.held.length = 0;
          yield* cancelPendingApprovals(context);
          if (process !== undefined) {
            if (context.promptFiber && !context.disconnected) {
              yield* Effect.ignore(process.runtime.cancel);
            }
            yield* flushLedger(context);
            yield* closeProcess(context, process);
          }
          context.closed = true;
          if (sessions.get(context.threadId) === context) sessions.delete(context.threadId);
          yield* emit({
            type: "session.exited",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: context.threadId,
            payload: {
              exitKind: context.disconnected ? "error" : "graceful",
              ...(context.disconnected ? { reason: "DeepSeek Harness process stopped." } : {}),
            },
          });
        }),
      )
      .pipe(Effect.uninterruptible);

  const emitStartEvents = (context: SessionContext, providerThreadId: string | undefined) =>
    Effect.gen(function* () {
      yield* emit({
        type: "session.started",
        ...(yield* stamp),
        provider: PROVIDER,
        threadId: context.threadId,
        payload: {},
      });
      yield* emit({
        type: "session.state.changed",
        ...(yield* stamp),
        provider: PROVIDER,
        threadId: context.threadId,
        payload: {
          state: "ready",
          reason:
            providerThreadId === undefined
              ? "Waiting for a new DeepSeek Harness session"
              : "DeepSeek Harness session ready",
        },
      });
      yield* emit({
        type: "thread.started",
        ...(yield* stamp),
        provider: PROVIDER,
        threadId: context.threadId,
        payload: providerThreadId === undefined ? {} : { providerThreadId },
      });
    });

  /**
   * Refuses an oversized inline image before the session is started or reused.
   *
   * `buildDshPrompt` makes the same refusal per turn, but by then the session
   * start this turn caused has already emitted `session.started` and a `ready`
   * state change: those land a moment later and would leave the thread ready
   * with no error, so the owner's chat showed nothing at all. That is what QA
   * hit on 1.66.45 (C5F/C5R): the first message of a fresh chat, or the first
   * after a restart, carrying the 8.4 MB photo.
   */
  const validateTurn: NonNullable<Adapter["validateTurn"]> = (input) =>
    Effect.gen(function* () {
      const overCap = yield* findDshImageOverCap({
        attachments: input.attachments,
        attachmentsDir: serverConfig.attachmentsDir,
      });
      if (overCap === undefined) return;
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "session/prompt",
        detail: dshImageTooLargeText(overCap),
      });
    }).pipe(provideFs);

  const startSession: Adapter["startSession"] = (input: StartInput) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        if (!input.cwd?.trim()) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "The session requires a workspace directory.",
          });
        }
        if (
          (input.provider !== undefined && input.provider !== PROVIDER) ||
          (input.providerInstanceId !== undefined &&
            input.providerInstanceId !== options.instanceId) ||
          (input.modelSelection !== undefined &&
            input.modelSelection.instanceId !== options.instanceId)
        ) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "The DeepSeek provider instance does not match the requested session.",
          });
        }
        yield* assertFlashModel(input.modelSelection, "startSession");
        const previous = sessions.get(input.threadId);
        if (previous) yield* stopContext(previous);
        const cwd = path.resolve(input.cwd);

        const requestedMode = dshAgentModeFromSelection(input.modelSelection);
        const cursor = parseDshResumeCursor(input.resumeCursor);
        const pinned = resolveDshSessionMode({
          cursor: input.resumeCursor,
          requested: input.modelSelection?.options?.find(
            (option) => option.id === DEEPSEEK_AGENT_MODE_OPTION_ID,
          )?.value,
        });
        if (pinned.pinned && pinned.mode !== requestedMode) {
          yield* Effect.logInfo("dsh.mode.pinned", {
            threadId: input.threadId,
            requested: requestedMode,
            pinned: pinned.mode,
          });
        }
        const foreignCursorId =
          input.freshSession === true || input.resumeCursor === undefined
            ? undefined
            : Option.isSome(cursor)
              ? undefined
              : readForeignCursorId(input.resumeCursor);

        const createdAt = yield* nowIso;
        const context: SessionContext = {
          threadId: input.threadId,
          cwd,
          botId: input.personalBotId,
          promptLock: yield* Semaphore.make(1),
          stopLock: yield* Semaphore.make(1),
          approvals: new Map(),
          turns: [],
          ledger: { offset: 0, lastSeq: -1, descendants: new Set(), loaded: false },
          held: [],
          process: undefined,
          nativeSessionId: undefined,
          foreignCursorId,
          pendingPersona: undefined,
          pendingEffort: undefined,
          session: {
            provider: PROVIDER,
            providerInstanceId: options.instanceId,
            threadId: input.threadId,
            cwd,
            status: "ready",
            runtimeMode: input.runtimeMode,
            model: DEEPSEEK_FLASH_MODEL,
            createdAt,
            updatedAt: createdAt,
          },
          activeTurnId: undefined,
          promptFiber: undefined,
          generation: 0,
          draining: false,
          stopped: false,
          closed: false,
          disconnected: false,
        };
        // Registered before the process starts, so its events find a context.
        sessions.set(input.threadId, context);

        if (foreignCursorId !== undefined) {
          // A Claude-engine cursor. Start nothing: the first turn fails with the
          // missing-conversation text, so the server renews the session and
          // carries the chat over from its text.
          yield* emitStartEvents(context, undefined);
          return context.session;
        }

        const attempt = yield* Effect.result(
          startProcess(context, {
            mode: pinned.mode,
            systemInstructions: input.systemInstructions,
            runtimeMode: input.runtimeMode,
            ...(Option.isSome(cursor) ? { resumeSessionId: cursor.value.resume } : {}),
          }),
        );
        let started: DshProcess | undefined;
        if (Result.isSuccess(attempt)) {
          started = attempt.success;
        } else if (
          Option.isSome(cursor) &&
          DSH_NOT_RESUMABLE_PATTERN.test(attempt.failure.message)
        ) {
          // dsh lost the session it was asked to resume (its home was cleared,
          // or the chat outlived the folder). Same treatment as a foreign
          // cursor: the first turn renews it from the chat's text.
          context.foreignCursorId = cursor.value.resume;
          yield* startProcess(context, {
            mode: pinned.mode,
            systemInstructions: input.systemInstructions,
            runtimeMode: input.runtimeMode,
          });
        } else {
          return yield* Effect.fail(attempt.failure);
        }
        if (started !== undefined) {
          context.process = started;
          yield* started.runtime
            .setConfigOption("reasoning_effort", resolveDshEffort(input.modelSelection))
            .pipe(
              Effect.catchCause(() =>
                Effect.logWarning("dsh could not set the reasoning effort", {
                  threadId: input.threadId,
                }),
              ),
            );
          context.session = {
            ...context.session,
            resumeCursor: {
              schemaVersion: 1,
              engine: DSH_RESUME_ENGINE,
              resume: started.sessionId,
              mode: started.mode,
            },
            updatedAt: yield* nowIso,
          };
        }
        yield* emitStartEvents(context, started?.sessionId);
        return context.session;
      }).pipe(
        Effect.onError(() =>
          Effect.suspend(() => {
            const context = sessions.get(input.threadId);
            return context === undefined ? Effect.void : stopContext(context).pipe(Effect.ignore);
          }),
        ),
      ),
    );

  /* ---------------------------------------------------------------------- */
  /* Turns                                                                   */
  /* ---------------------------------------------------------------------- */

  const finishTurn = (context: SessionContext, turn: TurnId, payload: TurnCompletedPayload) =>
    Effect.gen(function* () {
      context.activeTurnId = undefined;
      context.promptFiber = undefined;
      context.session = {
        ...context.session,
        status: payload.state === "failed" ? "error" : "ready",
        activeTurnId: undefined,
        updatedAt: yield* nowIso,
        ...(payload.errorMessage ? { lastError: payload.errorMessage } : { lastError: undefined }),
      };
      yield* emit({
        type: "turn.completed",
        ...(yield* stamp),
        provider: PROVIDER,
        threadId: context.threadId,
        turnId: turn,
        payload,
      });
    }).pipe(Effect.uninterruptible);

  /**
   * Starts a turn, under the prompt lock: applies a pending bot edit (the
   * persona is fixed at process start), announces the turn and dispatches the
   * prompt. Returns the plan the caller settles outside the lock, so a steer
   * arriving mid-turn can take the lock and be held instead of waiting behind
   * the whole turn.
   */
  const beginTurnLocked = Effect.fn("DeepSeekDshAdapter.beginTurnLocked")(function* (
    context: SessionContext,
    turn: HeldTurn,
  ) {
    const pending = context.pendingPersona;
    if (pending !== undefined) {
      context.pendingPersona = undefined;
      const process = context.process;
      if (process !== undefined && process.personaHash !== pending.hash) {
        yield* restartForPersona(context, pending.instructions);
      }
    }
    const process = context.process;
    if (process === undefined || context.stopped) return undefined;
    // Effort is a per-session config option; a change applies to the next turn.
    const effort = context.pendingEffort;
    context.pendingEffort = undefined;
    if (effort !== undefined) {
      yield* process.runtime.setConfigOption("reasoning_effort", effort).pipe(
        Effect.catchCause(() =>
          Effect.logWarning("dsh could not set the reasoning effort", {
            threadId: context.threadId,
            effort,
          }),
        ),
      );
    }
    const generation = ++context.generation;
    context.activeTurnId = turn.turnId;
    context.session = {
      ...context.session,
      status: "running",
      activeTurnId: turn.turnId,
      updatedAt: yield* nowIso,
    };
    yield* emit({
      type: "turn.started",
      ...(yield* stamp),
      provider: PROVIDER,
      threadId: context.threadId,
      turnId: turn.turnId,
      payload: { model: DEEPSEEK_FLASH_MODEL },
    });
    const dispatched = yield* Deferred.make<void>();
    const fiber = yield* process.runtime
      .prompt({ prompt: [...turn.prompt] }, { dispatched })
      .pipe(Effect.forkIn(process.scope));
    context.promptFiber = fiber;
    // Hold the lock until the prompt is really the active one, so a steer that
    // takes it next sees a turn in flight rather than racing this start.
    yield* Effect.raceFirst(
      Deferred.await(dispatched),
      Fiber.await(fiber).pipe(
        Effect.flatMap((exit) => exit),
        Effect.asVoid,
      ),
    );
    return { fiber, generation, process, turnId: turn.turnId };
  });

  /** Waits out a started turn and settles it, outside the prompt lock. */
  const settleTurn = Effect.fn("DeepSeekDshAdapter.settleTurn")(function* (
    context: SessionContext,
    plan: {
      readonly fiber: Fiber.Fiber<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError>;
      readonly generation: number;
      readonly process: DshProcess;
      readonly turnId: TurnId;
    },
  ) {
    const settled = yield* Fiber.await(plan.fiber).pipe(Effect.orElseSucceed(() => undefined));
    if (context.stopped || context.generation !== plan.generation) return;
    yield* plan.process.runtime.drainEvents;
    yield* flushLedger(context);
    yield* context.promptLock.withPermit(
      Effect.gen(function* () {
        if (context.stopped || context.generation !== plan.generation) return;
        if (settled !== undefined && Exit.isSuccess(settled)) {
          const record = context.turns.find((entry) => entry.id === plan.turnId);
          if (record) record.items.push(settled.value);
          else context.turns.push({ id: plan.turnId, items: [settled.value] });
          yield* finishTurn(context, plan.turnId, {
            state: settled.value.stopReason === "cancelled" ? "cancelled" : "completed",
            stopReason: settled.value.stopReason,
          });
          return;
        }
        const translated =
          settled === undefined
            ? { text: "DeepSeek turn failed: the harness sent no result.", rateLimited: false }
            : translateDshFailure(Cause.pretty(settled.cause));
        yield* finishTurn(context, plan.turnId, {
          state: "failed",
          errorMessage: translated.text,
          ...(translated.rateLimited
            ? { retry: { kind: "rate_limited" as const, reason: "deepseek_usage_limit" } }
            : {}),
        });
      }),
    );
  });

  /**
   * One send's turn: started when nothing is running, held when a turn is.
   * The decision and the start both happen under the lock, so two sends can
   * never start at once.
   */
  const attemptTurn = Effect.fn("DeepSeekDshAdapter.attemptTurn")(function* (
    context: SessionContext,
    turn: HeldTurn,
  ) {
    const outcome = yield* context.promptLock.withPermit(
      Effect.gen(function* () {
        if (context.stopped || context.process === undefined) return { kind: "closed" } as const;
        if (context.activeTurnId !== undefined && context.promptFiber !== undefined) {
          context.held.push(turn);
          return { kind: "held" } as const;
        }
        const plan = yield* beginTurnLocked(context, turn);
        return plan === undefined
          ? ({ kind: "closed" } as const)
          : ({ kind: "running", plan } as const);
      }),
    );
    if (outcome.kind === "running") yield* settleTurn(context, outcome.plan).pipe(Effect.ignore);
    return outcome.kind;
  });

  /**
   * Runs the held messages one after another, each as its own announced turn,
   * until the queue is empty. One loop at a time; a send that arrives while it
   * runs joins the same queue and is picked up by the same loop.
   */
  const drainLoop: (context: SessionContext) => Effect.Effect<void> = (context) =>
    Effect.suspend(() => {
      const next = context.held.shift();
      if (next === undefined) return Effect.void;
      if (context.stopped) {
        context.held.length = 0;
        return Effect.void;
      }
      return attemptTurn(context, next).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("A held DeepSeek Harness turn failed", {
            threadId: context.threadId,
            cause: Cause.pretty(cause),
          }),
        ),
        Effect.andThen(Effect.suspend(() => drainLoop(context))),
      );
    });

  const scheduleDrain = (context: SessionContext) =>
    Effect.suspend(() => {
      if (context.draining || context.stopped || context.held.length === 0) return Effect.void;
      context.draining = true;
      return drainLoop(context).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            context.draining = false;
          }),
        ),
        Effect.forkIn(context.process?.scope ?? ownerScope),
      );
    });

  /** Replaces the process so a bot edit takes effect, keeping the conversation. */
  const restartForPersona = Effect.fn("DeepSeekDshAdapter.restartForPersona")(function* (
    context: SessionContext,
    systemInstructions: string | undefined,
  ) {
    const previous = context.process;
    if (previous === undefined) return;
    const next = yield* startProcess(context, {
      mode: previous.mode,
      systemInstructions,
      runtimeMode: context.session.runtimeMode,
      resumeSessionId: previous.sessionId,
    });
    context.process = next;
    yield* closeProcess(context, previous);
  });

  const sendTurn: Adapter["sendTurn"] = (input) =>
    Effect.gen(function* () {
      const context = yield* requireSession(input.threadId);
      if (input.modelSelection && input.modelSelection.instanceId !== options.instanceId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "The selected model belongs to another provider instance.",
        });
      }
      yield* assertFlashModel(input.modelSelection, "sendTurn");
      if (context.foreignCursorId !== undefined) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/prompt",
          detail: dshMissingConversationText(context.foreignCursorId),
        });
      }
      const prompt = yield* buildDshPrompt({
        input: input.input,
        attachments: input.attachments,
        attachmentsDir: serverConfig.attachmentsDir,
        interactionMode: input.interactionMode,
      }).pipe(provideFs);

      // The persona is fixed when the process starts, so a bot edited mid-chat
      // gets a fresh process resumed onto the same conversation. Recorded
      // here and applied by the next turn that actually begins, so a hold
      // cannot drop it.
      if (input.systemInstructions !== undefined) {
        const hash = hashPersona(
          buildDshPersona(
            input.systemInstructions,
            buildRuntimeInstructions({ harness: "DeepSeek Harness" }),
          ),
        );
        context.pendingPersona = { hash, instructions: input.systemInstructions };
      }
      context.pendingEffort = resolveDshEffort(input.modelSelection);
      const turnId = TurnId.make(yield* randomId);
      // A message that arrives while a turn is running is held, never folded
      // into it: dsh refuses a second prompt, and cancelling to take the new
      // one would kill the tool that turn is running.
      const outcome = yield* attemptTurn(context, { turnId, prompt }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.succeed("closed" as const)
            : Effect.gen(function* () {
                yield* finishTurn(context, turnId, {
                  state: "failed",
                  errorMessage: translateDshFailure(Cause.pretty(cause)).text,
                });
                return "done" as const;
              }),
        ),
      );
      if (outcome === "closed") {
        return yield* new ProviderAdapterSessionClosedError({
          provider: PROVIDER,
          threadId: input.threadId,
        });
      }
      yield* scheduleDrain(context);
      return {
        threadId: input.threadId,
        turnId,
        resumeCursor: context.session.resumeCursor,
      };
    });

  const interruptTurn: Adapter["interruptTurn"] = (threadId) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      const process = context.process;
      if (process === undefined) return;
      yield* cancelPendingApprovals(context);
      yield* process.runtime.cancel.pipe(
        Effect.mapError((cause) =>
          mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", cause),
        ),
      );
    });

  const respondToRequest: Adapter["respondToRequest"] = (threadId, requestId, decision) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      const pending = context.approvals.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/request_permission",
          detail: "This approval request is no longer pending.",
        });
      }
      const optionId =
        decision === "cancel"
          ? undefined
          : pending.request.options.find((entry) =>
              decision === "accept"
                ? entry.kind === "allow_once"
                : decision === "acceptForSession"
                  ? entry.kind === "allow_always" || entry.kind === "allow_once"
                  : entry.kind === "reject_once",
            )?.optionId;
      if (decision !== "cancel" && optionId === undefined) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "respondToRequest",
          issue:
            "The DeepSeek Harness did not offer this permission choice. Select one of the available choices.",
        });
      }
      yield* Deferred.succeed(pending.response, {
        decision,
        result: {
          outcome:
            optionId === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId },
        },
      });
    });

  const respondToUserInput: Adapter["respondToUserInput"] = (
    _threadId,
    _requestId,
    _answers: ProviderUserInputAnswers,
  ) =>
    Effect.fail(
      new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "respondToUserInput",
        issue: "The DeepSeek Harness does not ask the owner questions over ACP.",
      }),
    );

  const stopSession: Adapter["stopSession"] = (threadId) =>
    withThreadLock(threadId, Effect.flatMap(requireSession(threadId), stopContext));
  const stopAll: Adapter["stopAll"] = () =>
    Effect.forEach([...sessions.values()], stopContext, { discard: true });
  yield* Effect.addFinalizer(() =>
    stopAll().pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logError("Could not stop a DeepSeek Harness session."),
      ),
      Effect.ensuring(PubSub.shutdown(events)),
    ),
  );

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
      supportsConversationRollback: false,
      // A send that lands mid-turn is started as a turn of its own, so the
      // owner's message counts as taken in when that turn starts.
      userMessageDelivery: "turn-started",
    },
    startSession,
    validateTurn,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    stopAll,
    listSessions: () =>
      Effect.sync(() =>
        [...sessions.values()]
          .filter((context) => !context.stopped)
          .map((context) => ({ ...context.session })),
      ),
    hasSession: (threadId) =>
      Effect.sync(() => sessions.has(threadId) && !sessions.get(threadId)?.stopped),
    readThread: (threadId) =>
      Effect.map(requireSession(threadId), (context) => ({ threadId, turns: context.turns })),
    rollbackThread: (_threadId: ThreadId, _numTurns: number) =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue:
            "The DeepSeek Harness does not support conversation rewind. Start a new thread instead.",
        }),
      ),
    streamEvents: Stream.fromPubSub(events),
  } satisfies Adapter;
});
