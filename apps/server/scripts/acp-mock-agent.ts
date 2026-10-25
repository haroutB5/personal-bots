#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import * as NodeChildProcess from "node:child_process";

import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";

import * as EffectAcpAgent from "effect-acp/agent";
import * as AcpError from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/schema";

const requestLogPath = process.env.T3_ACP_REQUEST_LOG_PATH;
const exitLogPath = process.env.T3_ACP_EXIT_LOG_PATH;
const antigravityProfile = process.env.T3_ACP_ANTIGRAVITY === "1";
/**
 * The DeepSeek Harness profile: the capabilities, session shape, errors and
 * the exact prompt/turn event order recorded from dsh 0.2.0-rc.2
 * (`design/hbots/dsh-harness/probe/out/events-run1.jsonl`). It does NOT
 * advertise `loadSession`, and it refuses a second prompt while one is in
 * flight, both of which the adapter relies on.
 */
const dshProfile = process.env.T3_ACP_DSH_PROFILE === "1";
/** The JSON-RPC error text a dsh prompt fails with, when the test sets one. */
const dshPromptError = process.env.T3_ACP_DSH_PROMPT_ERROR?.trim() || undefined;
const emitToolCalls = process.env.T3_ACP_EMIT_TOOL_CALLS === "1";
const emitUsageUpdate = process.env.T3_ACP_EMIT_USAGE_UPDATE === "1";
const emitInterleavedAssistantToolCalls =
  process.env.T3_ACP_EMIT_INTERLEAVED_ASSISTANT_TOOL_CALLS === "1";
const emitGenericToolPlaceholders = process.env.T3_ACP_EMIT_GENERIC_TOOL_PLACEHOLDERS === "1";
const emitBackgroundToolDuringAnswer =
  process.env.T3_ACP_EMIT_BACKGROUND_TOOL_DURING_ANSWER === "1";
const emitAskQuestion = process.env.T3_ACP_EMIT_ASK_QUESTION === "1";
const emitXAiAskUserQuestion = process.env.T3_ACP_EMIT_XAI_ASK_USER_QUESTION === "1";
const emitXAiExitPlanMode = process.env.T3_ACP_EMIT_XAI_EXIT_PLAN_MODE === "1";
const emitXAiPlanMdWrite = process.env.T3_ACP_EMIT_XAI_PLAN_MD_WRITE === "1";
const emitXAiPromptCompleteThenHang = process.env.T3_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG === "1";
const emitXAiRateLimitThenHang = process.env.T3_ACP_EMIT_XAI_RATE_LIMIT_THEN_HANG === "1";
const emitXAiAskUserQuestionThenHang =
  process.env.T3_ACP_EMIT_XAI_ASK_USER_QUESTION_THEN_HANG === "1";
const emitContentThenHang = process.env.T3_ACP_EMIT_CONTENT_THEN_HANG === "1";
const emitPlanThenHang = process.env.T3_ACP_EMIT_PLAN_THEN_HANG === "1";
const emitActiveToolThenHang = process.env.T3_ACP_EMIT_ACTIVE_TOOL_THEN_HANG === "1";
const emitGrokMonitorPostTurnPoll = process.env.T3_ACP_EMIT_GROK_MONITOR_POST_TURN_POLL === "1";
const emitGrokBackgroundTaskStarted = process.env.T3_ACP_EMIT_GROK_BACKGROUND_TASK_STARTED === "1";
const emitForeignSessionUpdates = process.env.T3_ACP_EMIT_FOREIGN_SESSION_UPDATES === "1";
const waitForResumeRelease = process.env.T3_ACP_WAIT_FOR_RESUME_RELEASE === "1";
const completeFirstPromptOnCancel = process.env.T3_ACP_COMPLETE_FIRST_PROMPT_ON_CANCEL === "1";
const floodStderr = process.env.T3_ACP_FLOOD_STDERR === "1";
const hangPromptForever = process.env.T3_ACP_HANG_PROMPT_FOREVER === "1";
// Lists a sign-in method the way Kilo does: `initialize` offers it, sessions still open.
const offerSignInMethod = process.env.T3_ACP_OFFER_SIGN_IN === "1";
const hangFirstPromptForever = process.env.T3_ACP_HANG_FIRST_PROMPT_FOREVER === "1";
const emitLateUpdateAfterCancel = process.env.T3_ACP_EMIT_LATE_UPDATE_AFTER_CANCEL === "1";
const omitXAiPromptCompleteStopReason =
  process.env.T3_ACP_OMIT_XAI_PROMPT_COMPLETE_STOP_REASON === "1";
const failLoadSession = process.env.T3_ACP_FAIL_LOAD_SESSION === "1";
const emitLoadReplay = process.env.T3_ACP_EMIT_LOAD_REPLAY === "1";
const hangLoadSessionAfterReplay = process.env.T3_ACP_HANG_LOAD_SESSION_AFTER_REPLAY === "1";
const delayLoadSessionAfterReplay = process.env.T3_ACP_DELAY_LOAD_SESSION_AFTER_REPLAY === "1";
const loadSessionDelayMs = Number(process.env.T3_ACP_LOAD_SESSION_DELAY_MS ?? "5000");
const emitStaleXAiPromptCompleteBeforeSecondHang =
  process.env.T3_ACP_EMIT_STALE_XAI_PROMPT_COMPLETE_BEFORE_SECOND_HANG === "1";
const emitOverlappingXAiPromptCompleteOutOfOrder =
  process.env.T3_ACP_EMIT_OVERLAPPING_XAI_PROMPT_COMPLETE_OUT_OF_ORDER === "1";
const failPrompt = process.env.T3_ACP_FAIL_PROMPT === "1";
const failSetConfigOption = process.env.T3_ACP_FAIL_SET_CONFIG_OPTION === "1";
const exitOnSetConfigOption = process.env.T3_ACP_EXIT_ON_SET_CONFIG_OPTION === "1";
const promptResponseText = process.env.T3_ACP_PROMPT_RESPONSE_TEXT;
const initialGrokReasoningEffort =
  process.env.T3_ACP_INITIAL_GROK_REASONING_EFFORT?.trim() || undefined;
const promptDelayMs = Number(process.env.T3_ACP_PROMPT_DELAY_MS ?? "0");
const heldToolReleasePath = process.env.T3_ACP_HELD_TOOL_RELEASE_PATH;
let heldToolRunning = false;
const busyFirstPrompt = process.env.T3_ACP_BUSY_FIRST_PROMPT === "1";
/**
 * Fail prompts as an Effect defect with this text, the way the OpenCode 2 agent
 * reports "Session already has an active ACP prompt" on the wire (a
 * defect-shaped JSON-RPC error, not a typed ACP request error).
 */
const defectPromptError = process.env.T3_ACP_DEFECT_PROMPT_ERROR?.trim() || undefined;
const defectPromptCount = Math.max(
  0,
  Number.parseInt(process.env.T3_ACP_DEFECT_PROMPT_COUNT ?? "1", 10) || 0,
);
/** 1-based prompt number the defect starts at, so a steer can fail the second. */
const defectPromptStart = Math.max(
  1,
  Number.parseInt(process.env.T3_ACP_DEFECT_PROMPT_START ?? "1", 10) || 1,
);
const permissionOptionIds = {
  allowOnce: process.env.T3_ACP_ALLOW_ONCE_OPTION_ID ?? "allow-once",
  allowAlways: process.env.T3_ACP_ALLOW_ALWAYS_OPTION_ID ?? "allow-always",
  rejectOnce: process.env.T3_ACP_REJECT_ONCE_OPTION_ID ?? "reject-once",
};
const omitAllowAlways = process.env.T3_ACP_OMIT_ALLOW_ALWAYS === "1";
const permissionRequestCount = Math.max(
  1,
  Number(process.env.T3_ACP_PERMISSION_REQUEST_COUNT ?? "1") || 1,
);
const sessionId = "mock-session-1";

let currentModeId = antigravityProfile ? "default" : "ask";
let currentModelId = antigravityProfile ? "gemini-test-low" : "default";
let parameterizedModelPicker = false;
let currentReasoning = "medium";
// Starts away from the effort hbots sends, so the dsh profile always exercises
// `session/set_config_option` rather than a no-op match.
let dshReasoningEffort = "low";
let currentContext = "272k";
let currentFast = false;
let promptCount = 0;
let busyPromptsLeft = busyFirstPrompt ? 1 : 0;
let defectPromptsLeft = defectPromptError ? defectPromptCount : 0;
let overlappingFirstPromptId: string | undefined;
const cancelledSessions = new Set<string>();

function promptIdFromRequestMeta(
  request: Pick<AcpSchema.PromptRequest, "_meta">,
): string | undefined {
  const meta = request._meta;
  if (meta === null || typeof meta !== "object") {
    return undefined;
  }
  const promptId = meta.promptId ?? meta.requestId;
  return typeof promptId === "string" && promptId.length > 0 ? promptId : undefined;
}

function logExit(reason: string): void {
  if (!exitLogPath) {
    return;
  }
  NodeFS.appendFileSync(exitLogPath, `${reason}\n`, "utf8");
}

function writeJsonRpcNotification(method: string, params: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

process.once("SIGTERM", () => {
  logExit("SIGTERM");
  process.exit(0);
});

process.once("SIGINT", () => {
  logExit("SIGINT");
  process.exit(0);
});

process.once("exit", (code) => {
  logExit(`exit:${code}`);
});

function configOptions(): ReadonlyArray<AcpSchema.SessionConfigOption> {
  if (antigravityProfile) {
    return [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: currentModelId,
        options: antigravityModels.map((model) => ({ value: model.modelId, name: model.name })),
      },
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: currentModeId,
        options: availableModes.map((mode) => ({ value: mode.id, name: mode.name })),
      },
    ];
  }
  if (parameterizedModelPicker) {
    const baseOptions: Array<AcpSchema.SessionConfigOption> = [
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: currentModeId,
        options: availableModes.map((mode) => ({
          value: mode.id,
          name: mode.name,
          ...(mode.description ? { description: mode.description } : {}),
        })),
      },
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: currentModelId,
        options: [
          { value: "default", name: "Auto" },
          { value: "composer-2", name: "Composer 2" },
          { value: "gpt-5.4", name: "GPT-5.4" },
          { value: "claude-opus-4-6", name: "Opus 4.6" },
        ],
      },
    ];

    switch (currentModelId) {
      case "gpt-5.4":
        return [
          ...baseOptions,
          {
            id: "reasoning",
            name: "Reasoning",
            category: "thought_level",
            type: "select",
            currentValue: currentReasoning,
            options: [
              { value: "none", name: "None" },
              { value: "low", name: "Low" },
              { value: "medium", name: "Medium" },
              { value: "high", name: "High" },
              { value: "extra-high", name: "Extra High" },
            ],
          },
          {
            id: "context",
            name: "Context",
            category: "model_config",
            type: "select",
            currentValue: currentContext,
            options: [
              { value: "272k", name: "272K" },
              { value: "1m", name: "1M" },
            ],
          },
          {
            id: "fast",
            name: "Fast",
            category: "model_config",
            type: "select",
            currentValue: String(currentFast),
            options: [
              { value: "false", name: "Off" },
              { value: "true", name: "Fast" },
            ],
          },
        ];
      case "composer-2":
        return [
          ...baseOptions,
          {
            id: "fast",
            name: "Fast",
            category: "model_config",
            type: "select",
            currentValue: String(currentFast),
            options: [
              { value: "false", name: "Off" },
              { value: "true", name: "Fast" },
            ],
          },
        ];
      case "claude-opus-4-6":
        return [
          ...baseOptions,
          {
            id: "reasoning",
            name: "Reasoning",
            category: "thought_level",
            type: "select",
            currentValue: currentReasoning,
            options: [
              { value: "low", name: "Low" },
              { value: "medium", name: "Medium" },
              { value: "high", name: "High" },
            ],
          },
          {
            id: "thinking",
            name: "Thinking",
            category: "model_config",
            type: "boolean",
            currentValue: true,
          },
        ];
      default:
        return baseOptions;
    }
  }

  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select" as const,
      currentValue: currentModelId,
      options: [
        { value: "default", name: "Auto" },
        { value: "composer-2", name: "Composer 2" },
        { value: "composer-2[fast=true]", name: "Composer 2 Fast" },
        { value: "gpt-5.3-codex[reasoning=medium,fast=false]", name: "Codex 5.3" },
      ],
    },
  ];
}

function modelConfigOptionsFor(modelId: string): ReadonlyArray<AcpSchema.SessionConfigOption> {
  const previousModelId = currentModelId;
  try {
    currentModelId = modelId;
    return configOptions().filter(
      (option) => option.category !== "mode" && option.category !== "model",
    );
  } finally {
    currentModelId = previousModelId;
  }
}

function availableModels(): ReadonlyArray<{
  readonly value: string;
  readonly name: string;
  readonly configOptions: ReadonlyArray<AcpSchema.SessionConfigOption>;
}> {
  return [
    { value: "default", name: "Auto" },
    { value: "composer-2", name: "Composer 2" },
    { value: "gpt-5.4", name: "GPT-5.4" },
    { value: "claude-opus-4-6", name: "Opus 4.6" },
  ].map((model) => ({
    value: model.value,
    name: model.name,
    configOptions: modelConfigOptionsFor(model.value),
  }));
}

const antigravityModels = [
  { modelId: "gemini-test-low", name: "Gemini Test Low" },
  { modelId: "gemini-test-high", name: "Gemini Test High" },
] satisfies ReadonlyArray<AcpSchema.ModelInfo>;

const availableModes: ReadonlyArray<AcpSchema.SessionMode> = antigravityProfile
  ? [
      { id: "default", name: "Default" },
      { id: "auto_edit", name: "Auto edit" },
      { id: "yolo", name: "YOLO" },
    ]
  : [
      {
        id: "ask",
        name: "Ask",
        description: "Request permission before making any changes",
      },
      {
        id: "architect",
        name: "Architect",
        description: "Design and plan software systems without implementation",
      },
      {
        id: "code",
        name: "Code",
        description: "Write and modify code with full tool access",
      },
    ];

function modeState(): AcpSchema.SessionModeState {
  return {
    currentModeId,
    availableModes,
  };
}

// Mirrors the real Grok ACP: it advertises versioned model ids, never the CLI's own
// "grok-build" product name, and it rejects unknown ids in session/set_model.
const grokAcpModels: ReadonlyArray<AcpSchema.ModelInfo> = [
  {
    modelId: "grok-4.6",
    name: "Grok 4.6",
    _meta: {
      totalContextTokens: 500_000,
      supportsReasoningEffort: true,
      reasoningEffort: initialGrokReasoningEffort ?? "high",
      reasoningEfforts: [
        { id: "xhigh", value: "xhigh", label: "Extra High Effort", default: false },
        { id: "high", value: "high", label: "High Effort", default: true },
        { id: "low", value: "low", label: "Low Effort", default: false },
      ],
    },
  },
  { modelId: "grok-mock-alt", name: "Grok Mock Alt" },
];

function modelState(): AcpSchema.SessionModelState {
  if (antigravityProfile) {
    return { currentModelId, availableModels: antigravityModels };
  }
  const modelId = grokAcpModels.some((model) => model.modelId === currentModelId)
    ? currentModelId
    : "grok-4.6";
  return {
    currentModelId: modelId,
    availableModels: grokAcpModels,
  };
}

const program = Effect.gen(function* () {
  const agent = yield* EffectAcpAgent.AcpAgent;
  const resumeRelease = yield* Deferred.make<void>();
  const nativeCancelRequested = yield* Deferred.make<void>();
  const nativeCancelRelease = yield* Deferred.make<void>();
  // The dsh profile's own turn state: one prompt in flight at a time, and the
  // cancel that settles the running one.
  let dshPromptInFlight = false;
  let dshPromptCount = 0;
  const dshCancelRequested = yield* Deferred.make<void>();
  const dshSessionIds = new Set<string>([sessionId]);
  // The long tool call the second recorded prompt starts, so the cancel can
  // report it aborted by its own id.
  const dshRunningToolCallId = "call_00_FI7e8UthkdOSYjYzxjtc5336";
  // dsh's own session log: the append-only zstd-frame file the adapter's usage
  // ledger reads. The mock writes it exactly as the real agent does, one frame
  // per event, under the DSH_HOME the launch environment names.
  let dshLogFile: string | undefined;
  let dshLogSeq = 0;
  const dshSessionHeader = () =>
    JSON.stringify({
      type: "session",
      version: 4,
      id: sessionId,
      createdAt: Date.now(),
      cwd: dshCwd,
      isSeeded: false,
      delegationDepth: 0,
    }) as unknown as Record<string, unknown>;
  const appendDshLog = (event: Record<string, unknown>) => {
    if (dshLogFile === undefined) return;
    try {
      NodeFS.mkdirSync(NodePath.dirname(dshLogFile), { recursive: true });
      NodeFS.appendFileSync(
        dshLogFile,
        NodeZlib.zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`, "utf8")),
      );
    } catch {
      // A missing log only costs the usage test, never the turn.
    }
  };
  const appendDshAssistantStep = (messageId: string, usage: Record<string, number>) => {
    dshLogSeq += 1;
    appendDshLog({
      type: "assistant/message",
      seq: dshLogSeq,
      time: Date.now(),
      data: {
        turn: 1,
        step: dshLogSeq,
        message: {
          role: "assistant",
          content: [],
          source: { kind: "model", provider: "deepseek-official", model: "deepseek-flash" },
          id: messageId,
        },
        usage,
      },
    });
  };
  let dshCwd = process.cwd();
  const publishAntigravityCommands = (targetSessionId: string) =>
    agent.client.sessionUpdate({
      sessionId: targetSessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "plan", description: "Plan a task", input: { hint: "task" } },
          { name: "logout", description: "Sign out" },
        ],
      },
    });

  yield* agent.handleInitialize((request) =>
    Effect.gen(function* () {
      if (floodStderr) {
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              process.stderr.write("stderr".repeat(350_000), () => resolve());
            }),
        );
      }
      parameterizedModelPicker =
        request.clientCapabilities?._meta?.parameterizedModelPicker === true;
      if (dshProfile) {
        // Verbatim from the recorded handshake. No `loadSession`, and
        // `sessionCapabilities.resume` is what the adapter's `resumeMethod`
        // has to use.
        return {
          protocolVersion: 1,
          agentInfo: { name: "deepseek-harness-acp", version: "0.0.1" },
          agentCapabilities: {
            mcpCapabilities: { http: true },
            promptCapabilities: { image: true, audio: false, embeddedContext: false },
            sessionCapabilities: { close: {}, list: {}, resume: {} },
          },
          authMethods: [],
        };
      }
      if (antigravityProfile) {
        return {
          protocolVersion: 1,
          agentInfo: { name: "antigravity-acp", version: "mock" },
          agentCapabilities: {
            loadSession: true,
            sessionCapabilities: { resume: {} },
            auth: { logout: {} },
            promptCapabilities: { image: true, embeddedContext: true },
          },
          authMethods: [{ id: "oauth-personal", name: "Sign in with Google" }],
        };
      }
      return {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
        // Grok advertises model state before any session exists; the provider
        // health check reads it from here without authenticating.
        _meta: { modelState: modelState() },
        ...(offerSignInMethod
          ? {
              authMethods: [
                {
                  id: "mock-login",
                  name: "Login with Mock",
                  description: "Run `mock auth login` in the terminal",
                },
              ],
            }
          : {}),
      };
    }),
  );

  // Mirrors the real agent: the API key method reads GEMINI_API_KEY from the
  // process environment and rejects when it is missing.
  yield* agent.handleAuthenticate((request) =>
    !antigravityProfile || request.methodId === "oauth-personal"
      ? Effect.succeed({})
      : request.methodId === "gemini-api-key" && process.env.GEMINI_API_KEY
        ? Effect.succeed({})
        : Effect.fail(
            AcpError.AcpRequestError.invalidParams(
              `Mock Antigravity rejected auth method ${request.methodId}.`,
            ),
          ),
  );
  if (antigravityProfile) {
    yield* agent.handleLogout(() => Effect.succeed({}));
  }

  yield* agent.handleCreateSession((request) =>
    Effect.gen(function* () {
      if (dshProfile) {
        // dsh has no ACP modes and no `models` list: the model is a config
        // option, and its values are JSON strings. Its own session log starts
        // here, next to the harness home the launch environment names.
        dshCwd = String(request.cwd ?? process.cwd());
        const dshHome = process.env.DSH_HOME;
        if (dshHome) {
          dshLogFile = NodePath.join(
            dshHome,
            "sessions",
            `--${dshCwd.replace(/[\\/:]/g, "-")}--`,
            sessionId,
            "session.v4.jsonl.zstd",
          );
          NodeFS.mkdirSync(NodePath.dirname(dshLogFile), { recursive: true });
          NodeFS.writeFileSync(dshLogFile, Buffer.alloc(0));
          appendDshLog(dshSessionHeader());
        }
        return { sessionId, configOptions: dshConfigOptions() };
      }
      if (antigravityProfile) {
        yield* publishAntigravityCommands(sessionId);
      }
      return {
        sessionId,
        modes: modeState(),
        models: modelState(),
        configOptions: configOptions(),
      };
    }),
  );

  /** dsh's config options: `model` (JSON-string values) and `reasoning_effort`. */
  function dshConfigOptions(): ReadonlyArray<AcpSchema.SessionConfigOption> {
    return [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: '["deepseek-official","deepseek-flash"]',
        options: [
          {
            group: "deepseek-official",
            name: "DeepSeek",
            options: [
              { value: '["deepseek-official","deepseek-flash"]', name: "DeepSeek-V41-Flash" },
              { value: '["deepseek-official","deepseek-v4-pro"]', name: "DeepSeek-V41-Pro" },
            ],
          },
        ],
      },
      {
        id: "reasoning_effort",
        name: "Reasoning effort",
        category: "thought_level",
        type: "select",
        currentValue: dshReasoningEffort,
        options: [
          { value: "off", name: "Off" },
          { value: "low", name: "Low" },
          { value: "high", name: "High" },
          { value: "max", name: "Max" },
        ],
      },
    ] as ReadonlyArray<AcpSchema.SessionConfigOption>;
  }

  yield* agent.handleResumeSession((request) =>
    Effect.gen(function* () {
      if (dshProfile) {
        // `session/resume` only: an unknown id is refused with dsh's own text,
        // which the adapter turns into a renewed session.
        if (!dshSessionIds.has(request.sessionId)) {
          return yield* AcpError.AcpRequestError.invalidParams(
            `Invalid params: session is not resumable: ${request.sessionId}`,
          );
        }
        return { configOptions: dshConfigOptions() };
      }
      yield* agent.client.sessionUpdate({
        sessionId: request.sessionId,
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "native-resume-started" },
        },
      });
      if (waitForResumeRelease) {
        yield* Deferred.await(resumeRelease);
      }
      if (antigravityProfile) {
        yield* publishAntigravityCommands(request.sessionId);
      }
      return {
        modes: modeState(),
        models: modelState(),
        configOptions: configOptions(),
        _meta: { nativeResume: true },
      };
    }),
  );

  const emitLoadReplayNotifications = (requestedSessionId: string) => {
    writeJsonRpcNotification("session/update", {
      _meta: { isReplay: true },
      sessionId: requestedSessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "replay-tool-1",
        title: "Replay tool",
        kind: "search",
        status: "completed",
      },
    });
    writeJsonRpcNotification("session/update", {
      _meta: { isReplay: true },
      sessionId: requestedSessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "replayed assistant text" },
      },
    });
  };

  // dsh does not implement `session/load` at all: leaving the handler
  // unregistered makes the library answer `-32601 Method not found`, exactly
  // as the real agent does.
  if (!dshProfile)
    yield* agent.handleLoadSession((request) =>
      Effect.gen(function* () {
        const requestedSessionId = String(request.sessionId ?? sessionId);
        if (failLoadSession) {
          return yield* AcpError.AcpRequestError.internalError("Mock load session failure");
        }
        if (hangLoadSessionAfterReplay || delayLoadSessionAfterReplay) {
          emitLoadReplayNotifications(requestedSessionId);
          yield* agent.client.sessionUpdate({
            sessionId: requestedSessionId,
            update: {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text: "replay-tail" },
            },
          });
          yield* Effect.sleep(loadSessionDelayMs);
          return {
            modes: modeState(),
            models: modelState(),
            configOptions: configOptions(),
          };
        }
        if (emitLoadReplay) {
          emitLoadReplayNotifications(requestedSessionId);
        }
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "replay" },
          },
        });
        return {
          modes: modeState(),
          models: modelState(),
          configOptions: configOptions(),
        };
      }),
    );

  yield* agent.handleSetSessionModel((request) =>
    Effect.gen(function* () {
      if (!modelState().availableModels.some((model) => model.modelId === request.modelId)) {
        return yield* AcpError.AcpRequestError.invalidParams(
          `Unknown mock model id: ${request.modelId}`,
          {
            method: "session/set_model",
            params: request,
          },
        );
      }
      currentModelId = request.modelId;
      return {};
    }),
  );

  yield* agent.handleSetSessionConfigOption((request) =>
    Effect.gen(function* () {
      if (exitOnSetConfigOption) {
        return yield* Effect.sync(() => {
          process.exit(7);
        });
      }
      if (failSetConfigOption) {
        return yield* AcpError.AcpRequestError.invalidParams(
          "Mock invalid params for session/set_config_option",
          {
            method: "session/set_config_option",
            params: request,
          },
        );
      }
      if (request.configId === "mode" && typeof request.value === "string") {
        currentModeId = request.value;
      }
      if (request.configId === "model" && typeof request.value === "string") {
        currentModelId = request.value;
      }
      if (request.configId === "reasoning" && typeof request.value === "string") {
        currentReasoning = request.value;
      }
      if (request.configId === "context" && typeof request.value === "string") {
        currentContext = request.value;
      }
      if (request.configId === "fast") {
        currentFast = request.value === true || request.value === "true";
      }
      return {
        configOptions: configOptions(),
      };
    }),
  );

  yield* agent.handleCancel(({ sessionId }) =>
    Effect.gen(function* () {
      const cancelledSessionId = String(sessionId ?? "mock-session-1");
      cancelledSessions.add(cancelledSessionId);
      if (dshProfile) {
        // dsh settles the running prompt ~20 ms after the cancel, and the
        // tool the turn was running comes back failed. The failed update is
        // written first, as the recording shows: settling before it made the
        // cancelled turn's tool card race the prompt response.
        yield* agent.client.sessionUpdate({
          sessionId: cancelledSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: dshRunningToolCallId,
            status: "failed",
            content: [
              { type: "content", content: { type: "text", text: "Error: tool call aborted" } },
            ],
          },
        });
        yield* Effect.sleep("20 millis");
        yield* Deferred.succeed(dshCancelRequested, undefined);
        return;
      }
      if (completeFirstPromptOnCancel) {
        yield* Deferred.succeed(nativeCancelRequested, undefined);
        yield* agent.client.sessionUpdate({
          sessionId: cancelledSessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "native-cancel-received" },
          },
        });
      }
      if (emitLateUpdateAfterCancel) {
        yield* Effect.sleep("50 millis");
        yield* Effect.sync(() => {
          writeJsonRpcNotification("session/update", {
            sessionId: cancelledSessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "late after cancel" },
            },
          });
        });
      }
    }),
  );

  yield* agent.handlePrompt((request) =>
    Effect.gen(function* () {
      const requestedSessionId = String(request.sessionId ?? sessionId);
      if (heldToolRunning) {
        return yield* Effect.die(new Error("Session already has an active ACP prompt: mock"));
      }
      promptCount += 1;
      if (heldToolReleasePath && promptCount === 1) {
        // A real child keeps the remote prompt busy after session/cancel. The
        // test releases it explicitly, so the race does not depend on timing.
        heldToolRunning = true;
        const child = NodeChildProcess.spawn(
          process.execPath,
          [
            "-e",
            "setInterval(() => { if (require('node:fs').existsSync(process.argv[1])) process.exit(0) }, 10)",
            heldToolReleasePath,
          ],
          { stdio: "ignore", windowsHide: true },
        );
        try {
          const exited = new Promise<void>((resolve, reject) => {
            child.once("exit", () => resolve());
            child.once("error", reject);
          });
          yield* agent.client.sessionUpdate({
            sessionId: requestedSessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "held-shell",
              title: "Waiting for test command release",
              kind: "execute",
              status: "in_progress",
            },
          });
          yield* Effect.promise(() => exited);
          yield* agent.client.sessionUpdate({
            sessionId: requestedSessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "held-shell",
              status: "completed",
            },
          });
          return {
            stopReason: cancelledSessions.delete(requestedSessionId) ? "cancelled" : "end_turn",
          };
        } finally {
          child.kill();
          heldToolRunning = false;
        }
      }
      if (promptCount >= defectPromptStart && defectPromptsLeft > 0) {
        defectPromptsLeft -= 1;
        return yield* Effect.die(new Error(defectPromptError));
      }
      if (busyPromptsLeft > 0) {
        busyPromptsLeft -= 1;
        return yield* AcpError.AcpRequestError.internalError(
          "Session already has an active ACP prompt: mock",
        );
      }
      if (
        process.env.T3_ACP_CRASH_PROMPT === "1" &&
        request.prompt.some((part) => part.type === "text" && part.text === "crash now")
      ) {
        return yield* Effect.sync(() => process.exit(23));
      }

      if (dshProfile) {
        // One prompt in flight per session, refused with dsh's own text.
        if (dshPromptInFlight) {
          return yield* AcpError.AcpRequestError.invalidParams(
            "Invalid params: a prompt is already in flight for this session",
          );
        }
        dshPromptInFlight = true;
        dshPromptCount += 1;
        const promptText = (request.prompt ?? [])
          .map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
          .join("\n");
        try {
          if (dshPromptError !== undefined) {
            return yield* AcpError.AcpRequestError.internalError(dshPromptError);
          }
          const update = (payload: Parameters<typeof agent.client.sessionUpdate>[0]["update"]) =>
            agent.client.sessionUpdate({ sessionId: requestedSessionId, update: payload });
          if (/start-sleep/i.test(promptText)) {
            // The recorded cancelled turn: a thought, a context reading, then
            // a `pwsh` tool that runs until the client cancels.
            yield* update({
              sessionUpdate: "agent_thought_chunk",
              messageId: "8c16fb18-4e56-4c16-a9b0-a0301239a625",
              content: { type: "text", text: "The user wants me to run a long command." },
            });
            yield* update({ sessionUpdate: "usage_update", used: 7050, size: 1000000 });
            yield* update({
              sessionUpdate: "tool_call",
              toolCallId: dshRunningToolCallId,
              title: "pwsh",
              kind: "other",
              status: "in_progress",
              rawInput: { command: promptText },
            });
            appendDshAssistantStep("8c16fb18-4e56-4c16-a9b0-a0301239a625", {
              inputTokens: 6600,
              outputTokens: 30,
              cacheReadTokens: 420,
              cacheWriteTokens: 0,
              totalTokens: 7050,
            });
            yield* Deferred.await(dshCancelRequested);
            return { stopReason: "cancelled" };
          }
          if (/paragraph-probe/i.test(promptText)) {
            // Two thinking steps split by a tool call, in dsh's own frame
            // shapes: the order the adapter's reasoning paragraph break is
            // written for (thought, tool_call, tool_call_update, thought).
            yield* update({
              sessionUpdate: "agent_thought_chunk",
              messageId: "dsh-paragraph-probe-1",
              content: { type: "text", text: "Let me check the file." },
            });
            yield* update({ sessionUpdate: "usage_update", used: 7000, size: 1000000 });
            yield* update({
              sessionUpdate: "tool_call",
              toolCallId: "dsh-paragraph-probe-call",
              title: "read_file",
              kind: "other",
              status: "in_progress",
              rawInput: { path: promptText },
            });
            yield* update({
              sessionUpdate: "tool_call_update",
              toolCallId: "dsh-paragraph-probe-call",
              status: "completed",
              content: [{ type: "content", content: { type: "text", text: "ok" } }],
            });
            yield* update({
              sessionUpdate: "agent_thought_chunk",
              messageId: "dsh-paragraph-probe-2",
              content: { type: "text", text: "The file is fine." },
            });
            yield* update({
              sessionUpdate: "agent_message_chunk",
              messageId: "dsh-paragraph-probe-3",
              content: { type: "text", text: "Done." },
            });
            return { stopReason: "end_turn" };
          }
          if (/colon-probe/i.test(promptText)) {
            // The live stub shape from the 2026-10-16 re-measure ("Now the
            // provider:" right before a call), with the colon arriving in its
            // own delta and the two tool-call frames dsh really sends.
            yield* update({
              sessionUpdate: "agent_message_chunk",
              messageId: "dsh-colon-probe-1",
              content: { type: "text", text: "Now the provider" },
            });
            yield* update({
              sessionUpdate: "agent_message_chunk",
              messageId: "dsh-colon-probe-2",
              content: { type: "text", text: ":" },
            });
            yield* update({
              sessionUpdate: "tool_call",
              toolCallId: "dsh-colon-probe-call",
              title: "read_file",
              kind: "other",
              status: "in_progress",
              rawInput: { path: promptText },
            });
            yield* update({
              sessionUpdate: "tool_call_update",
              toolCallId: "dsh-colon-probe-call",
              status: "completed",
              content: [{ type: "content", content: { type: "text", text: "ok" } }],
            });
            yield* update({
              sessionUpdate: "agent_message_chunk",
              messageId: "dsh-colon-probe-3",
              content: { type: "text", text: "Done." },
            });
            return { stopReason: "end_turn" };
          }
          if (/dsml-probe/i.test(promptText)) {
            // The leaked tool-call markup a dsh reply carried on 2026-10-15,
            // in the shape the live row holds it: an invoke block split across
            // chunks (so a tag really is cut in two), then the three stray
            // closing tags. `\uFF5C` is the full-width bar dsh fences with.
            const bar = "\uFF5C";
            const marker = `${bar}${bar}DSML${bar}${bar}`;
            yield* update({
              sessionUpdate: "agent_message_chunk",
              messageId: "dsh-dsml-probe-1",
              content: { type: "text", text: "Before." },
            });
            yield* update({
              sessionUpdate: "agent_message_chunk",
              messageId: "dsh-dsml-probe-2",
              content: {
                type: "text",
                text: `<${marker} tool_calls>\n<${marker} invoke name="web_search">\n<${marker} param`,
              },
            });
            yield* update({
              sessionUpdate: "agent_message_chunk",
              messageId: "dsh-dsml-probe-3",
              content: {
                type: "text",
                text:
                  `eter name="query">tennis scores</${marker} parameter>\n` +
                  `</${marker} invoke>\n</${marker} tool_calls>`,
              },
            });
            yield* update({
              sessionUpdate: "agent_message_chunk",
              messageId: "dsh-dsml-probe-4",
              content: {
                type: "text",
                text: `After.\n\n</${marker} parameter>\n</${marker} invoke>\n</${marker} calls>`,
              },
            });
            return { stopReason: "end_turn" };
          }
          // The recorded turn in `events-run1.jsonl`: three committed model
          // steps, one `usage_update` each, an MCP call and a skill.
          yield* update({
            sessionUpdate: "agent_message_chunk",
            messageId: "cb8ff6d0-2379-4301-bc1a-4e98693bc0f1",
            content: { type: "text", text: "I'll do these in order." },
          });
          yield* update({ sessionUpdate: "usage_update", used: 6652, size: 1000000 });
          yield* update({
            sessionUpdate: "tool_call",
            toolCallId: "call_00_ET_2cnwa0tA6yX29u4h9fdB8740",
            title: "mcp__t3-code__save_memory",
            kind: "other",
            status: "in_progress",
            rawInput: { text: "hello dsh" },
          });
          appendDshAssistantStep("cb8ff6d0-2379-4301-bc1a-4e98693bc0f1", {
            inputTokens: 6215,
            outputTokens: 53,
            cacheReadTokens: 384,
            cacheWriteTokens: 0,
            totalTokens: 6652,
          });
          yield* update({
            sessionUpdate: "tool_call_update",
            toolCallId: "call_00_ET_2cnwa0tA6yX29u4h9fdB8740",
            status: "completed",
            content: [{ type: "content", content: { type: "text", text: "ECHO:HELLO DSH" } }],
          });
          yield* update({
            sessionUpdate: "agent_thought_chunk",
            messageId: "93dc4425-a06a-4922-be77-70bd2df55914",
            content: { type: "text", text: "Now load the skill probe-falcon." },
          });
          yield* update({ sessionUpdate: "usage_update", used: 6722, size: 1000000 });
          yield* update({
            sessionUpdate: "tool_call",
            toolCallId: "call_00_Lre5pY2iDgyWaz8Z2Y1e9700",
            title: "skill",
            kind: "other",
            status: "in_progress",
            rawInput: { name: "probe-falcon" },
          });
          appendDshAssistantStep("93dc4425-a06a-4922-be77-70bd2df55914", {
            inputTokens: 6300,
            outputTokens: 20,
            cacheReadTokens: 402,
            cacheWriteTokens: 0,
            totalTokens: 6722,
          });
          yield* update({
            sessionUpdate: "tool_call_update",
            toolCallId: "call_00_Lre5pY2iDgyWaz8Z2Y1e9700",
            status: "completed",
            content: [{ type: "content", content: { type: "text", text: "<skill_content/>" } }],
          });
          yield* update({
            sessionUpdate: "agent_message_chunk",
            messageId: "ee7650ea-9c90-40aa-a418-e7700f3a9dd6",
            content: {
              type: "text",
              text: "Probey\nECHO:HELLO DSH\nPELICAN\nFALCON-42\nOVER",
            },
          });
          yield* update({ sessionUpdate: "usage_update", used: 6863, size: 1000000 });
          appendDshAssistantStep("ee7650ea-9c90-40aa-a418-e7700f3a9dd6", {
            inputTokens: 6400,
            outputTokens: 40,
            cacheReadTokens: 423,
            cacheWriteTokens: 0,
            totalTokens: 6863,
          });
          return { stopReason: "end_turn" };
        } finally {
          dshPromptInFlight = false;
        }
      }

      if (completeFirstPromptOnCancel && promptCount === 1) {
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "native-cancel-tool",
            title: "Long command",
            kind: "execute",
            status: "in_progress",
          },
        });
        yield* Deferred.await(nativeCancelRequested);
        yield* Deferred.await(nativeCancelRelease);
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "native-cancel-tool",
            status: "failed",
            content: [{ type: "content", content: { type: "text", text: "Cancelled." } }],
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Request cancelled." },
          },
        });
        return { stopReason: "cancelled", _meta: { nativeCancel: true } };
      }

      if (Number.isFinite(promptDelayMs) && promptDelayMs > 0) {
        yield* Effect.sleep(`${promptDelayMs} millis`);
      }

      if (failPrompt) {
        return yield* AcpError.AcpRequestError.internalError("Mock prompt failure");
      }

      if (emitStaleXAiPromptCompleteBeforeSecondHang && promptCount === 1) {
        return {
          stopReason: "end_turn",
          _meta: {
            promptId: "mock-stale-xai-prompt-1",
            requestId: "mock-stale-xai-prompt-1",
          },
        };
      }

      if (emitStaleXAiPromptCompleteBeforeSecondHang && promptCount === 2) {
        const currentPromptId = promptIdFromRequestMeta(request) ?? "mock-current-xai-prompt-2";
        writeJsonRpcNotification("_x.ai/session/prompt_complete", {
          sessionId: requestedSessionId,
          promptId: "mock-stale-xai-prompt-1",
          stopReason: "end_turn",
          agentResult: null,
        });

        writeJsonRpcNotification("_x.ai/session/prompt_complete", {
          sessionId: requestedSessionId,
          promptId: currentPromptId,
          stopReason: "end_turn",
          agentResult: null,
        });

        return yield* Effect.never;
      }

      if (emitOverlappingXAiPromptCompleteOutOfOrder && promptCount === 1) {
        overlappingFirstPromptId = promptIdFromRequestMeta(request);
        return yield* Effect.never;
      }

      if (emitOverlappingXAiPromptCompleteOutOfOrder && promptCount === 2) {
        const secondPromptId = promptIdFromRequestMeta(request);
        if (overlappingFirstPromptId !== undefined && secondPromptId !== undefined) {
          writeJsonRpcNotification("_x.ai/session/prompt_complete", {
            sessionId: requestedSessionId,
            promptId: secondPromptId,
            stopReason: "end_turn",
            agentResult: null,
          });
          writeJsonRpcNotification("_x.ai/session/prompt_complete", {
            sessionId: requestedSessionId,
            promptId: overlappingFirstPromptId,
            stopReason: "end_turn",
            agentResult: null,
          });
        }
        return yield* Effect.never;
      }

      if (hangPromptForever || (hangFirstPromptForever && promptCount === 1)) {
        return yield* Effect.never;
      }

      if (emitXAiRateLimitThenHang) {
        writeJsonRpcNotification("_x.ai/session/prompt_complete", {
          sessionId: requestedSessionId,
          promptId: promptIdFromRequestMeta(request) ?? "mock-xai-rate-limit-prompt-1",
          stopReason: "rate_limit",
          agentResult: null,
        });
        return yield* Effect.never;
      }

      if (emitContentThenHang) {
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "partial before stall" },
          },
        });
        return yield* Effect.never;
      }

      if (emitPlanThenHang) {
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "plan",
            entries: [
              {
                content: "Wait for more ACP progress",
                priority: "high",
                status: "in_progress",
              },
            ],
          },
        });
        return yield* Effect.never;
      }

      if (emitActiveToolThenHang) {
        const toolCallId = "tool-call-long-running-1";
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "Long-running tool",
            kind: "execute",
            status: "pending",
            rawInput: { command: ["long-running-tool"] },
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "in_progress",
          },
        });
        return yield* Effect.never;
      }

      if (emitXAiPromptCompleteThenHang) {
        writeJsonRpcNotification("session/update", {
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "hello from" },
          },
        });

        if (emitForeignSessionUpdates) {
          writeJsonRpcNotification("session/update", {
            sessionId: "mock-child-session-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "child before completion" },
            },
          });
        }

        writeJsonRpcNotification("_x.ai/session/prompt_complete", {
          sessionId: requestedSessionId,
          promptId: promptIdFromRequestMeta(request) ?? "mock-xai-prompt-1",
          ...(omitXAiPromptCompleteStopReason ? {} : { stopReason: "end_turn" }),
          agentResult: null,
        });

        if (emitForeignSessionUpdates) {
          writeJsonRpcNotification("session/update", {
            sessionId: "mock-child-session-1",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "child-tool-call-1",
              title: "Child-only tool",
              kind: "other",
              status: "pending",
              rawInput: {},
            },
          });
          writeJsonRpcNotification("session/update", {
            sessionId: "mock-child-session-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "child after completion" },
            },
          });
        }

        for (const text of [" ", "mo", "ck"]) {
          writeJsonRpcNotification("session/update", {
            sessionId: requestedSessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text },
            },
          });
        }

        return yield* Effect.never;
      }

      if (emitGrokMonitorPostTurnPoll) {
        const monitorCallId = "call-monitor-1";
        const pollCallId = "call-monitor-poll-1";
        const taskId = "01a05f41-5107-7550-821e-79e8d1cd7687";
        const description = "Watch count-sheet Typst unit until done";
        writeJsonRpcNotification("session/update", {
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: monitorCallId,
            title: "monitor",
            kind: "other",
            status: "pending",
            rawInput: { description },
            _meta: {
              "x.ai/tool": { version: 1, name: "monitor", kind: "task", namespace: "grok_build" },
            },
          },
        });
        writeJsonRpcNotification("session/update", {
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: monitorCallId,
            status: "completed",
            rawInput: { description },
            rawOutput: {
              type: "Monitor",
              taskId,
              timeoutMs: 36_000_000,
            },
          },
        });
        writeJsonRpcNotification("_x.ai/session/prompt_complete", {
          sessionId: requestedSessionId,
          promptId: promptIdFromRequestMeta(request) ?? "mock-xai-prompt-1",
          stopReason: "end_turn",
          agentResult: null,
        });
        yield* Effect.sleep("120 millis");
        writeJsonRpcNotification("session/update", {
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: pollCallId,
            title: "get_command_or_subagent_output",
            kind: "other",
            status: "completed",
            rawInput: { variant: "TaskOutput", task_ids: [taskId], timeout_ms: 0 },
            rawOutput: {
              type: "TaskOutput",
              Result: {
                task_id: taskId,
                command: `[monitor] ${description}`,
                status: "completed",
                exit_code: 0,
                output: "Monitor finished.",
              },
            },
          },
        });
        return yield* Effect.never;
      }

      if (emitGrokBackgroundTaskStarted) {
        const toolCallId = "call-fb9d0000-0000-0000-0000-000000000026";
        const command = "sleep 40; echo done-a";
        writeJsonRpcNotification("session/update", {
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "run_terminal_command",
            kind: "execute",
            status: "in_progress",
            rawInput: { command },
          },
        });
        writeJsonRpcNotification("session/update", {
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "completed",
            rawOutput: {
              type: "BackgroundTaskStarted",
              task_id: toolCallId,
              task_type: "bash",
              status: "running",
              command,
            },
          },
        });
        writeJsonRpcNotification("_x.ai/session/prompt_complete", {
          sessionId: requestedSessionId,
          promptId: promptIdFromRequestMeta(request) ?? "mock-xai-prompt-1",
          stopReason: "end_turn",
          agentResult: null,
        });
        return yield* Effect.never;
      }

      if (emitBackgroundToolDuringAnswer) {
        // A command backgrounded earlier reports progress and then finishes
        // while the next answer is still streaming.
        const toolCallId = "background-1";
        const say = (text: string) =>
          agent.client.sessionUpdate({
            sessionId: requestedSessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
          });
        const progress = (status: "in_progress" | "completed", stdout: string) =>
          agent.client.sessionUpdate({
            sessionId: requestedSessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId,
              status,
              rawOutput: { stdout },
            },
          });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "Terminal",
            kind: "execute",
            status: "in_progress",
            rawInput: { command: "sleep 3 && echo done" },
          },
        });
        yield* say("| a | b |\n|---|---|\n| 1 ");
        yield* progress("in_progress", ".");
        yield* say("| x |\n");
        yield* progress("completed", "done");
        yield* say("| 2 | y |\n");
        // Agents can repeat a terminal update after the call finished.
        yield* progress("completed", "done");
        yield* say("| 3 | z |");
        return { stopReason: "end_turn" };
      }

      if (emitInterleavedAssistantToolCalls) {
        const toolCallId = "tool-call-1";

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "before tool" },
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "Terminal",
            kind: "execute",
            status: "pending",
            rawInput: {
              command: ["echo", "hello"],
            },
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "completed",
            rawOutput: {
              exitCode: 0,
              stdout: "hello",
              stderr: "",
            },
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "after tool" },
          },
        });

        return { stopReason: "end_turn" };
      }

      if (emitToolCalls) {
        const toolCallId = "tool-call-1";

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "Terminal",
            kind: "execute",
            status: "pending",
            rawInput: {
              command: ["cat", "server/package.json"],
            },
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "in_progress",
          },
        });

        const permissionOptions: Array<AcpSchema.PermissionOption> = [
          { optionId: permissionOptionIds.allowOnce, name: "Allow once", kind: "allow_once" },
          ...(omitAllowAlways
            ? []
            : [
                {
                  optionId: permissionOptionIds.allowAlways,
                  name: "Allow always",
                  kind: "allow_always" as const,
                },
              ]),
          { optionId: permissionOptionIds.rejectOnce, name: "Reject", kind: "reject_once" },
        ];

        let cancelled = cancelledSessions.delete(requestedSessionId);
        for (let index = 0; index < permissionRequestCount; index++) {
          const command =
            index > 0
              ? (process.env.T3_ACP_SECOND_PERMISSION_COMMAND ?? "cat server/package.json")
              : "cat server/package.json";
          const permission = yield* agent.client.requestPermission({
            sessionId: requestedSessionId,
            toolCall: {
              toolCallId: index === 0 ? toolCallId : `${toolCallId}-${index + 1}`,
              title: process.env.T3_ACP_PERMISSION_TITLE ?? `\`${command}\``,
              kind: "execute",
              status: "pending",
              rawInput: {
                variant: "Bash",
                command,
                description: index === 0 ? "Read package metadata" : "Read it again",
              },
              content: [
                {
                  type: "content",
                  content: {
                    type: "text",
                    text: `Not in allowlist: ${command}`,
                  },
                },
              ],
            },
            options: permissionOptions,
          });
          cancelled =
            cancelled ||
            cancelledSessions.delete(requestedSessionId) ||
            permission.outcome.outcome === "cancelled";
          if (cancelled) {
            break;
          }
        }

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            title: "Terminal",
            kind: "execute",
            status: "completed",
            rawOutput: {
              exitCode: 0,
              stdout: '{ "name": "t3" }',
              stderr: "",
            },
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "hello from mock" },
          },
        });

        return { stopReason: cancelled ? "cancelled" : "end_turn" };
      }

      if (emitGenericToolPlaceholders) {
        const toolCallId = "tool-call-generic-1";

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "Read File",
            kind: "read",
            status: "pending",
            rawInput: {},
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "in_progress",
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "completed",
            rawOutput: {
              content: "package.json\n",
            },
          },
        });

        return { stopReason: "end_turn" };
      }

      if (emitAskQuestion) {
        yield* agent.client.extRequest("cursor/ask_question", {
          toolCallId: "ask-question-tool-call-1",
          title: "Question",
          questions: [
            {
              id: "scope",
              prompt: "Which scope?",
              options: [
                { id: "workspace", label: "Workspace" },
                { id: "session", label: "Session" },
              ],
            },
          ],
        });

        return { stopReason: "end_turn" };
      }

      if (emitXAiAskUserQuestion || emitXAiAskUserQuestionThenHang) {
        const result = yield* agent.client.extRequest("_x.ai/ask_user_question", {
          method: "x.ai/ask_user_question",
          params: {
            sessionId: requestedSessionId,
            toolCallId: "ask-user-question-tool-call-1",
            questions: [
              {
                question: "Which scope should Grok use?",
                multiSelect: null,
                options: [
                  { label: "Workspace", description: "Use the current workspace" },
                  { label: "Session", description: "Only use this session" },
                ],
              },
            ],
            mode: "default",
          },
        });
        if (typeof result !== "object" || result === null || !("outcome" in result)) {
          throw new Error("Expected _x.ai/ask_user_question response outcome.");
        }
        if (result.outcome === "cancelled") {
          return { stopReason: "end_turn" };
        }
        if (
          result.outcome !== "accepted" ||
          !("answers" in result) ||
          typeof result.answers !== "object" ||
          result.answers === null
        ) {
          throw new Error("Expected accepted _x.ai/ask_user_question response answers.");
        }

        if (emitXAiAskUserQuestionThenHang) {
          return yield* Effect.never;
        }

        return { stopReason: "end_turn" };
      }

      if (emitXAiPlanMdWrite) {
        // Match Grok's real session layout so isGrokPlanMarkdownPath accepts it.
        const planRoot = process.env.T3_ACP_PLAN_ROOT ?? "/tmp/mock-home/.grok";
        const planPath = `${planRoot}/sessions/${requestedSessionId}/plan.md`;
        const planBody = "# Mock plan\n\n- Write the feature\n- Add a test\n- Ship it\n";
        // enter_plan_mode first so the adapter arms planModeActive.
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "enter-plan-mode-1",
            title: "enter_plan_mode",
            kind: "other",
            status: "completed",
            rawInput: { variant: "EnterPlanMode" },
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "plan-md-write-1",
            title: "write",
            kind: "edit",
            status: "pending",
            rawInput: { file_path: planPath, content: planBody },
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "plan-md-write-1",
            kind: "edit",
            status: "completed",
            title: `Write \`${planPath}\``,
            rawInput: { file_path: planPath, content: planBody },
            content: [
              {
                type: "diff",
                path: planPath,
                oldText: "",
                newText: planBody,
              },
            ],
          },
        });
        return { stopReason: "end_turn" };
      }

      if (emitXAiExitPlanMode) {
        const result = yield* agent.client.extRequest("_x.ai/exit_plan_mode", {
          method: "x.ai/exit_plan_mode",
          params: {
            sessionId: requestedSessionId,
            toolCallId: "exit-plan-mode-tool-call-1",
            planContent: "# Exit plan\n\n- Step one\n- Step two\n",
          },
        });
        if (typeof result !== "object" || result === null || !("outcome" in result)) {
          throw new Error("Expected _x.ai/exit_plan_mode response outcome.");
        }
        if (
          result.outcome !== "abandoned" &&
          result.outcome !== "approved" &&
          result.outcome !== "request_changes"
        ) {
          throw new Error(
            `Expected exit_plan_mode outcome abandoned|approved|request_changes, got ${String(result.outcome)}`,
          );
        }
        return { stopReason: "end_turn" };
      }

      if (emitForeignSessionUpdates) {
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "root before child" },
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: "mock-child-session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "child content" },
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: "mock-child-session-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "child-tool-call-1",
            title: "Child-only tool",
            kind: "other",
            status: "pending",
            rawInput: {},
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: " root after child" },
          },
        });
        return { stopReason: "end_turn" };
      }

      yield* agent.client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: "plan",
          entries: [
            {
              content: "Inspect mock ACP state",
              priority: "high",
              status: "completed",
            },
            {
              content: "Implement the requested change",
              priority: "high",
              status: "in_progress",
            },
          ],
        },
      });

      yield* agent.client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: promptResponseText ?? "hello from mock" },
        },
      });

      if (emitUsageUpdate) {
        // ACP `usage_update`: `used` is what the context holds now, `size` its window.
        for (const used of [12_000, 18_500]) {
          yield* agent.client.sessionUpdate({
            sessionId: requestedSessionId,
            update: { sessionUpdate: "usage_update", used, size: 200_000 },
          });
        }
      }

      return { stopReason: "end_turn" };
    }),
  );

  yield* agent.handleUnknownExtRequest((method, params) => {
    if (method === "_test/environment") {
      return Effect.succeed({
        inherited: process.env.T3_ACP_RUNTIME_AMBIENT === "sentinel",
        explicit: process.env.T3_ACP_RUNTIME_EXPLICIT === "kept",
      });
    }
    if (method === "_test/release-resume") {
      return Deferred.succeed(resumeRelease, undefined).pipe(Effect.as({}));
    }
    if (method === "_test/finish-cancel") {
      return Deferred.succeed(nativeCancelRelease, undefined).pipe(Effect.as({}));
    }
    if (method === "_test/startup-metadata") {
      return Effect.gen(function* () {
        for (const [metadataSessionId, commandName, modeId] of [
          [sessionId, "plan", "code"],
          ["child-session", "foreign-command", "ask"],
        ] as const) {
          yield* agent.client.sessionUpdate({
            sessionId: metadataSessionId,
            update: {
              sessionUpdate: "available_commands_update",
              availableCommands: [{ name: commandName, description: "Native command" }],
            },
          });
          yield* agent.client.sessionUpdate({
            sessionId: metadataSessionId,
            update: { sessionUpdate: "current_mode_update", currentModeId: modeId },
          });
          yield* agent.client.sessionUpdate({
            sessionId: metadataSessionId,
            update: {
              sessionUpdate: "config_option_update",
              configOptions: configOptions().map((option) =>
                option.type === "select" && option.category === "model"
                  ? {
                      ...option,
                      currentValue: metadataSessionId === sessionId ? "gpt-5.4" : "default",
                    }
                  : option,
              ),
            },
          });
          yield* agent.client.sessionUpdate({
            sessionId: metadataSessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Startup transcript must not replay." },
            },
          });
        }
        return {};
      });
    }
    if (method === "cursor/list_available_models") {
      return Effect.succeed({
        models: availableModels(),
      });
    }

    if (method !== "session/mode/set") {
      return Effect.fail(AcpError.AcpRequestError.methodNotFound(method));
    }

    const nextModeId =
      typeof params === "object" &&
      params !== null &&
      "modeId" in params &&
      typeof params.modeId === "string"
        ? params.modeId
        : typeof params === "object" &&
            params !== null &&
            "mode" in params &&
            typeof params.mode === "string"
          ? params.mode
          : undefined;
    const requestedSessionId =
      typeof params === "object" &&
      params !== null &&
      "sessionId" in params &&
      typeof params.sessionId === "string"
        ? params.sessionId
        : sessionId;

    if (typeof nextModeId === "string" && nextModeId.trim()) {
      currentModeId = nextModeId.trim();
      return agent.client
        .sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "current_mode_update",
            currentModeId,
          },
        })
        .pipe(Effect.as({}));
    }

    return Effect.succeed({});
  });

  yield* agent.handleUnknownExtNotification((method) =>
    method === "_test/exit" ? Effect.sync(() => process.exit(19)) : Effect.void,
  );

  return yield* Effect.never;
}).pipe(
  Effect.provide(
    EffectAcpAgent.layerStdio(
      requestLogPath
        ? {
            logIncoming: true,
            logger: (event) => {
              if (event.direction !== "incoming" || event.stage !== "raw") {
                return Effect.void;
              }
              if (typeof event.payload !== "string") {
                return Effect.void;
              }
              const payload = event.payload;
              return Effect.sync(() => {
                NodeFS.appendFileSync(
                  requestLogPath,
                  payload.endsWith("\n") ? payload : `${payload}\n`,
                  "utf8",
                );
              });
            },
          }
        : {},
    ),
  ),
  Effect.scoped,
  Effect.provide(NodeServices.layer),
);

NodeRuntime.runMain(program);
