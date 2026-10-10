/**
 * DeepSeekAdapter — `deepseek` provider adapter reusing the Claude Agent SDK runtime.
 *
 * Delegates every session/turn to `makeClaudeAdapter` (the same persona via
 * `withBotInstructions`, memory turn context, streaming, tools/MCP,
 * cancellation, resume/second turns) and rewrites the provider identity on
 * the way out: adapter `provider`, sessions, runtime events, and adapter
 * errors are stamped `deepseek`, never `claudeAgent`. Model selection is
 * Flash-only: anything that does not canonicalize to `deepseek-flash` fails
 * with a validation error before the SDK spawns, so Pro and Claude ids can
 * never route here.
 *
 * @module provider/Layers/DeepSeekAdapter
 */
import {
  type DeepSeekSettings,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderSessionStartInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { ClaudeModelCatalog } from "../ClaudeModelCatalog.ts";
import {
  canonicalizeDeepSeekModelId,
  DEEPSEEK_FLASH_SLUG,
  type DeepSeekModelCatalog,
} from "../DeepSeekModelCatalog.ts";
import { ProviderAdapterValidationError, type ProviderAdapterError } from "../Errors.ts";
import { makeClaudeAdapter, type ClaudeAdapterLiveOptions } from "./ClaudeAdapter.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("deepseek");
const CLAUDE_AGENT = ProviderDriverKind.make("claudeAgent");

export interface DeepSeekAdapterOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly modelCatalog?: Effect.Effect<DeepSeekModelCatalog>;
  readonly createQuery?: ClaudeAdapterLiveOptions["createQuery"];
  readonly getSessionMessages?: ClaudeAdapterLiveOptions["getSessionMessages"];
  readonly forkSession?: ClaudeAdapterLiveOptions["forkSession"];
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: ClaudeAdapterLiveOptions["nativeEventLogger"];
}

const withDeepSeekProvider = <T>(value: T): T => {
  if (typeof value !== "object" || value === null || !("provider" in value)) return value;
  if ((value as { provider: unknown }).provider === PROVIDER) return value;
  return { ...(value as Record<string, unknown>), provider: PROVIDER } as T;
};

const rewriteAdapterError = (error: ProviderAdapterError): ProviderAdapterError => {
  if (typeof error === "object" && error !== null && error.provider !== PROVIDER) {
    const proto = Object.getPrototypeOf(error);
    return Object.assign(Object.create(proto), error, { provider: PROVIDER });
  }
  return error;
};

/**
 * The inner runtime words auth/rate-limit failures in Claude terms (`claude
 * auth login`, Claude usage limits). On DeepSeek those directions mislead, so
 * the three known Claude-specific failure wordings are translated at the
 * event boundary. Every other failure (tool errors, context window, SDK
 * text) passes through verbatim.
 */
const deepSeekFailureText = (message: string): string => {
  if (message.includes("claude auth login")) {
    return (
      "DeepSeek could not authenticate. Check this DeepSeek instance's ANTHROPIC_AUTH_TOKEN " +
      "sensitive environment variable, then start a new thread."
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
  if (typeof event !== "object" || event === null) return event;
  const record = event as Record<string, unknown>;
  if (record.type === "turn.completed") {
    const payload = record.payload as Record<string, unknown> | undefined;
    if (
      payload?.state === "failed" &&
      typeof payload.errorMessage === "string" &&
      payload.errorMessage.length > 0
    ) {
      const translated = deepSeekFailureText(payload.errorMessage);
      if (translated !== payload.errorMessage) {
        return { ...record, payload: { ...payload, errorMessage: translated } } as T;
      }
    }
    return event;
  }
  if (record.type === "runtime.error") {
    const payload = record.payload as Record<string, unknown> | undefined;
    if (typeof payload?.message === "string" && payload.message.length > 0) {
      const translated = deepSeekFailureText(payload.message);
      if (translated !== payload.message) {
        return { ...record, payload: { ...payload, message: translated } } as T;
      }
    }
  }
  return event;
};

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

export const makeDeepSeekAdapter = Effect.fn("makeDeepSeekAdapter")(function* (
  settings: DeepSeekSettings,
  options?: DeepSeekAdapterOptions,
) {
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("deepseek");
  void boundInstanceId;
  // The Claude runtime reads Claude-shaped settings; DeepSeek settings are a
  // subset (no launchArgs/autoCompact), so map explicitly with safe defaults.
  const claudeSettings = {
    enabled: settings.enabled,
    binaryPath: settings.binaryPath,
    homePath: settings.homePath,
    customModels: [],
    launchArgs: "",
    autoCompactWindow: "",
  };
  const inner = yield* makeClaudeAdapter(claudeSettings, {
    ...(options?.instanceId ? { instanceId: options.instanceId } : {}),
    ...(options?.environment ? { environment: options.environment } : {}),
    ...(options?.modelCatalog
      ? {
          // Same profile shapes by design; the wrapper validates Flash-only on top.
          modelCatalog: options.modelCatalog as unknown as Effect.Effect<ClaudeModelCatalog>,
        }
      : {}),
    ...(options?.createQuery ? { createQuery: options.createQuery } : {}),
    ...(options?.getSessionMessages ? { getSessionMessages: options.getSessionMessages } : {}),
    ...(options?.forkSession ? { forkSession: options.forkSession } : {}),
    ...(options?.nativeEventLogPath ? { nativeEventLogPath: options.nativeEventLogPath } : {}),
    ...(options?.nativeEventLogger ? { nativeEventLogger: options.nativeEventLogger } : {}),
  });

  const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
    Effect.gen(function* () {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        });
      }
      yield* assertFlashModel(input.modelSelection, "startSession");
      // The inner runtime only accepts its own kind; translate the DeepSeek
      // routing key at the boundary. Outputs are stamped back below.
      const session = yield* inner
        .startSession(input.provider === undefined ? input : { ...input, provider: CLAUDE_AGENT })
        .pipe(Effect.mapError(rewriteAdapterError));
      return withDeepSeekProvider(session);
    });

  const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
    Effect.gen(function* () {
      yield* assertFlashModel(input.modelSelection, "sendTurn");
      return yield* inner.sendTurn(input).pipe(Effect.mapError(rewriteAdapterError));
    });

  const wrapSessionEffect = <A, E extends ProviderAdapterError, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, ProviderAdapterError, R> =>
    effect.pipe(
      Effect.map((value) =>
        Array.isArray(value)
          ? (value.map((entry) =>
              typeof entry === "object" && entry !== null && "provider" in entry
                ? withDeepSeekProvider(entry)
                : entry,
            ) as A)
          : typeof value === "object" && value !== null && "provider" in value
            ? (withDeepSeekProvider(value) as A)
            : value,
      ),
      Effect.mapError(rewriteAdapterError),
    );

  const streamEvents = Stream.map(inner.streamEvents, (event) =>
    withDeepSeekFailureText(withDeepSeekProvider(event)),
  );

  // The persona flows through the Claude adapter's `withBotInstructions`
  // call (imported above); this wrapper only pins identity, Flash-only
  // model gating, and DeepSeek failure wording on top.
  return {
    ...inner,
    provider: PROVIDER,
    startSession,
    sendTurn,
    interruptTurn: (threadId, turnId) => wrapSessionEffect(inner.interruptTurn(threadId, turnId)),
    respondToRequest: (threadId, requestId, decision) =>
      wrapSessionEffect(inner.respondToRequest(threadId, requestId, decision)),
    respondToUserInput: (threadId, requestId, answers) =>
      wrapSessionEffect(inner.respondToUserInput(threadId, requestId, answers)),
    stopSession: (threadId, opts) => wrapSessionEffect(inner.stopSession(threadId, opts)),
    // Infallible in the shape: stamp values only, never touch the channel.
    listSessions: () =>
      inner.listSessions().pipe(Effect.map((sessions) => sessions.map(withDeepSeekProvider))),
    hasSession: (threadId) => inner.hasSession(threadId),
    readThread: (threadId) => wrapSessionEffect(inner.readThread(threadId)),
    rollbackThread: (threadId, numTurns) =>
      wrapSessionEffect(inner.rollbackThread(threadId, numTurns)),
    stopAll: () => inner.stopAll(),
    streamEvents,
  } satisfies ProviderAdapterShape<ProviderAdapterError>;
});
