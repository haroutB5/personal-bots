/**
 * Eco mode v1: the bot's own model plans a delegated task or routine run
 * without editing; when the task needs a lasting code change it calls
 * `eco_handoff(plan)`, and the same turn switches to a cheaper builder model
 * that implements and tests the plan.
 *
 * This module holds the pure parts, so the Claude adapter only wires them:
 * which turns are Eco turns, the save-time validation, the edit guard (a
 * `PreToolUse` hook, which runs in every permission mode), the handoff tool's
 * handler, the per-model usage split and the planner's instruction.
 *
 * @module personal/eco/ecoMode
 */
import {
  createSdkMcpServer,
  tool,
  type HookCallback,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import type { ModelSelection, PersonalBot } from "@t3tools/contracts";
import { botEco } from "@t3tools/contracts";
import { z } from "zod";

import {
  ECO_HANDOFF_TOOL_NAME,
  ECO_SKIPPED_BACKGROUND_WORK,
  ECO_SKIPPED_BUILDER_NOT_SWITCHABLE,
  ECO_SKIPPED_BUILDER_OTHER_PROVIDER,
  ECO_SKIPPED_BUILDER_SAME_MODEL,
  ECO_SWITCH_TIMEOUT_MS,
  bashCommandWrites,
  ecoPlanMarkdown,
} from "@t3tools/provider-core/server/ecoGuard";
import {
  canApplyClaudeSelectionLive,
  compileClaudeModelSelection,
} from "../../claudeModelOptions.ts";
import type { ClaudeModelCatalog } from "../../provider/ClaudeModelCatalog.ts";
import { isPersonalTaskMessageId } from "../personalThreadTitles.ts";

export {
  ECO_HANDOFF_TOOL_NAME,
  ECO_SKIPPED_BACKGROUND_WORK,
  ECO_SKIPPED_BUILDER_NOT_SWITCHABLE,
  ECO_SKIPPED_BUILDER_OTHER_PROVIDER,
  ECO_SKIPPED_BUILDER_SAME_MODEL,
  ECO_SWITCH_TIMEOUT_MS,
  bashCommandWrites,
  ecoPlanMarkdown,
};

export const ECO_MCP_SERVER_NAME = "eco";
/** The name Claude Code gives the tool. */
export const ECO_HANDOFF_TOOL = `mcp__${ECO_MCP_SERVER_NAME}__${ECO_HANDOFF_TOOL_NAME}`;

// ---------------------------------------------------------------------------
// Settings

/**
 * Why a builder cannot be saved for a bot whose model is `planner`, or
 * undefined when it can. Both Claude and Antigravity require the builder to
 * be a different model on the bot's own provider instance; Claude also
 * requires the switch to apply live inside the running process (same thinking
 * setting, and an effort when the planner has one).
 */
export function ecoBuilderProblem(
  planner: ModelSelection,
  builder: ModelSelection,
  catalog?: ClaudeModelCatalog,
  driver?: string,
): string | undefined {
  if (builder.instanceId !== planner.instanceId) {
    return "The Eco builder must run on the bot's own provider.";
  }
  if (builder.model === planner.model) {
    return "The Eco builder must be a different model from the bot's own.";
  }
  if (
    driver === "antigravity" ||
    (driver === undefined &&
      (planner.instanceId === "antigravity" ||
        planner.model.toLocaleLowerCase().startsWith("gemini")))
  ) {
    return undefined;
  }
  const live = compileClaudeModelSelection(planner, catalog);
  const next = compileClaudeModelSelection(builder, catalog);
  if (!canApplyClaudeSelectionLive(live, next)) {
    return "The Eco builder needs the same thinking setting as the bot's model, and an effort when the bot's model has one.";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Which turns are Eco turns

export interface EcoTurnModels {
  readonly planner: ModelSelection;
  readonly builder: ModelSelection;
  /** Set when the saved builder no longer fits: the turn runs without Eco and records why. */
  readonly skipped?: string;
}

/**
 * The planner and builder for a turn, or undefined when the turn is not an
 * Eco turn. Only a delegated task, a steer into one, or a routine run (their
 * messages carry the task prefix) of an Eco bot on its own model; never a chat
 * the owner types into, a group round, or a bot on its usage-limit fallback.
 * The caller (the Claude adapter) is the Claude-only part.
 */
export function ecoTurnModels(input: {
  readonly bot: Pick<PersonalBot, "modelSelection" | "eco" | "fallbackActive">;
  readonly messageId: string;
  readonly modelSelection: ModelSelection;
}): EcoTurnModels | undefined {
  const eco = botEco(input.bot);
  if (!eco.enabled) return undefined;
  if (!isPersonalTaskMessageId(input.messageId)) return undefined;
  if (input.bot.fallbackActive !== undefined) return undefined;
  const own = input.bot.modelSelection;
  if (
    input.modelSelection.instanceId !== own.instanceId ||
    input.modelSelection.model !== own.model
  ) {
    return undefined;
  }
  const models = { planner: input.modelSelection, builder: eco.modelSelection };
  // A main-model change is saved without checking the builder; the turn says why it skipped.
  if (eco.modelSelection.instanceId !== input.modelSelection.instanceId) {
    return { ...models, skipped: ECO_SKIPPED_BUILDER_OTHER_PROVIDER };
  }
  if (eco.modelSelection.model === input.modelSelection.model) {
    return { ...models, skipped: ECO_SKIPPED_BUILDER_SAME_MODEL };
  }
  return models;
}

// ---------------------------------------------------------------------------
// The planner's instruction

export const ECO_TURN_INSTRUCTIONS = `<eco_mode>
This is an Eco turn and you are the planner. Investigate without editing: file edits, file-writing shell commands and git writes are blocked until you hand off. Keep the investigation short.
If, and only if, the task needs a lasting code change, call the ${ECO_HANDOFF_TOOL_NAME} tool once with a markdown plan in six parts: Goal, Scope, Where to change, Approach, Tests, Risks. A cheaper builder model then takes over this same turn to implement and test it, so write the plan for a reader who has not seen your investigation.
Before you hand off, check that every file, function, option, flag and command your plan names really exists, by reading the code or running it (for example its --help), not by assuming it from the task's wording. The task itself can be wrong about what exists. List anything you could not confirm under Risks, saying it is unconfirmed, and never present it as fact.
Otherwise, do or answer the task yourself without handing off.
</eco_mode>`;

export const withEcoInstructions = (text: string): string => `${ECO_TURN_INSTRUCTIONS}\n\n${text}`;

// ---------------------------------------------------------------------------
// Turn state

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

export interface EcoCall {
  readonly id: string;
  readonly model: string;
  readonly side: "planner" | "builder";
}

export interface EcoTurnState {
  readonly runId: string;
  readonly threadId: string;
  readonly planner: ModelSelection;
  readonly builder: ModelSelection;
  readonly plannerApiModel: string;
  readonly builderApiModel: string;
  readonly startedAt: Date;
  handingOff: boolean;
  handedOff: boolean;
  handedOffAt: Date | undefined;
  plan: string | undefined;
  handoffError: string | undefined;
  /** Root assistant calls in order, by message id; the side is fixed when first seen. */
  readonly calls: Map<string, EcoCall>;
  /**
   * Each API call's own usage by message id (root and subagent calls alike),
   * so the turn is priced call by call with 5-minute and 1-hour cache writes
   * at their own rates. The SDK's summed `modelUsage` merges the two.
   */
  readonly usage: Map<string, EcoCallUsage>;
  /** The message in flight on each stream ("root" or a subagent's tool use id). */
  readonly streams: Map<string, { readonly id: string; readonly model: string }>;
}

export function makeEcoTurnState(input: {
  readonly runId: string;
  readonly threadId: string;
  readonly models: EcoTurnModels;
  readonly plannerApiModel: string;
  readonly builderApiModel: string;
  readonly startedAt: Date;
}): EcoTurnState {
  return {
    runId: input.runId,
    threadId: input.threadId,
    planner: input.models.planner,
    builder: input.models.builder,
    plannerApiModel: input.plannerApiModel,
    builderApiModel: input.builderApiModel,
    startedAt: input.startedAt,
    handingOff: false,
    handedOff: false,
    handedOffAt: undefined,
    plan: undefined,
    handoffError: undefined,
    calls: new Map(),
    usage: new Map(),
    streams: new Map(),
  };
}

/** Notes one root assistant API call (a message id) and the model that answered it. */
export function noteEcoCall(turn: EcoTurnState, id: string, model: string): void {
  if (turn.calls.has(id) || model.length === 0 || model === "<synthetic>") return;
  turn.calls.set(id, { id, model, side: turn.handedOff ? "builder" : "planner" });
}

/** One API call's usage, as its assistant message reports it. */
export interface EcoCallUsage {
  readonly id: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWrite5mTokens: number;
  readonly cacheWrite1hTokens: number;
}

/**
 * Reads an assistant message's API `usage`. Without the `cache_creation`
 * breakdown every write counts as a 5-minute one, as the API bills it.
 */
export function ecoCallUsage(id: string, model: string, usage: unknown): EcoCallUsage | undefined {
  if (typeof usage !== "object" || usage === null) return undefined;
  const fields = usage as Record<string, unknown>;
  const breakdown =
    typeof fields.cache_creation === "object" && fields.cache_creation !== null
      ? (fields.cache_creation as Record<string, unknown>)
      : undefined;
  const written = count(fields.cache_creation_input_tokens);
  const oneHour = breakdown === undefined ? 0 : count(breakdown.ephemeral_1h_input_tokens);
  const fiveMinutes =
    breakdown === undefined
      ? written
      : Math.max(count(breakdown.ephemeral_5m_input_tokens), written - oneHour);
  return {
    id,
    model,
    inputTokens: count(fields.input_tokens),
    outputTokens: count(fields.output_tokens),
    cacheReadTokens: count(fields.cache_read_input_tokens),
    cacheWrite5mTokens: fiveMinutes,
    cacheWrite1hTokens: oneHour,
  };
}

/**
 * Notes one API call's usage. Claude Code sends a message once per content
 * block, all under one id, so each count keeps the largest value seen.
 */
export function noteEcoUsage(turn: EcoTurnState, id: string, model: string, usage: unknown): void {
  if (id.length === 0 || model.length === 0 || model === "<synthetic>") return;
  const next = ecoCallUsage(id, model, usage);
  if (next === undefined) return;
  const was = turn.usage.get(id);
  turn.usage.set(
    id,
    was === undefined
      ? next
      : {
          id,
          model,
          inputTokens: Math.max(was.inputTokens, next.inputTokens),
          outputTokens: Math.max(was.outputTokens, next.outputTokens),
          cacheReadTokens: Math.max(was.cacheReadTokens, next.cacheReadTokens),
          cacheWrite5mTokens: Math.max(was.cacheWrite5mTokens, next.cacheWrite5mTokens),
          cacheWrite1hTokens: Math.max(was.cacheWrite1hTokens, next.cacheWrite1hTokens),
        },
  );
}

/**
 * Notes a streamed API call's usage. The assistant snapshots carry the usage
 * of `message_start`, whose output count is a few tokens; the final, cumulative
 * output count arrives only in `message_delta`, which has no message id, so the
 * id and model of the stream's last `message_start` are kept per stream (the
 * root, or a subagent's tool use id).
 */
export function noteEcoStreamEvent(turn: EcoTurnState, stream: string, event: unknown): void {
  if (typeof event !== "object" || event === null) return;
  const fields = event as Record<string, unknown>;
  if (fields.type === "message_start") {
    const message = fields.message as Record<string, unknown> | undefined;
    const id = typeof message?.id === "string" ? message.id : "";
    const model = typeof message?.model === "string" ? message.model : "";
    if (id.length === 0) return;
    turn.streams.set(stream, { id, model });
    noteEcoUsage(turn, id, model, message?.usage);
  } else if (fields.type === "message_delta") {
    const current = turn.streams.get(stream);
    const usage = fields.usage as Record<string, unknown> | undefined;
    if (current === undefined || usage === undefined) return;
    // Only the output count: the delta repeats the cache writes without the
    // 5m/1h breakdown, which would count 1-hour writes again as 5-minute ones.
    noteEcoUsage(turn, current.id, current.model, { output_tokens: usage.output_tokens });
  }
}

// ---------------------------------------------------------------------------
// The edit guard

/** Claude Code's file-editing tools. */
export const ECO_EDIT_TOOLS: ReadonlySet<string> = new Set([
  "Edit",
  "Write",
  "NotebookEdit",
  "MultiEdit",
]);

export const ECO_EDIT_DENIED_REASON = `Eco mode: you are the planner, so edits are blocked. Finish investigating, then call ${ECO_HANDOFF_TOOL_NAME} with your plan if the task needs a lasting code change.`;

/** The reason an Eco turn refuses this tool call, or undefined to let it run. */
export function ecoToolDenial(
  turn: EcoTurnState | null,
  toolName: string,
  toolInput: unknown,
): string | undefined {
  if (turn === null || turn.handedOff) return undefined;
  if (ECO_EDIT_TOOLS.has(toolName)) return ECO_EDIT_DENIED_REASON;
  if (toolName === "Bash") {
    const command =
      typeof toolInput === "object" && toolInput !== null
        ? Reflect.get(toolInput, "command")
        : undefined;
    if (typeof command === "string" && bashCommandWrites(command)) return ECO_EDIT_DENIED_REASON;
  }
  return undefined;
}

/** The `PreToolUse` hook for a process that serves Eco turns. */
export function makeEcoPreToolUseHook(currentTurn: () => EcoTurnState | null): HookCallback {
  return (hookInput) => {
    if (hookInput.hook_event_name !== "PreToolUse") return Promise.resolve({});
    const reason = ecoToolDenial(currentTurn(), hookInput.tool_name, hookInput.tool_input);
    if (reason === undefined) return Promise.resolve({});
    return Promise.resolve({
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "deny" as const,
        permissionDecisionReason: reason,
      },
    });
  };
}

// ---------------------------------------------------------------------------
// The handoff tool

export interface EcoToolResult {
  readonly content: Array<{ readonly type: "text"; readonly text: string }>;
  readonly isError?: boolean;
}

export const ECO_HANDOFF_SUCCESS_TEXT =
  "Implement this plan now; you are the builder. The plan is a guide, not the task: if the code contradicts it, or a file, function, option or flag it relies on does not exist, do not follow it blindly. Do what the task actually asks, and say in your final reply where you departed from the plan and why.";

const toolError = (text: string): EcoToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

const withTimeout = <A>(promise: Promise<A>, ms: number): Promise<A> =>
  new Promise<A>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

/**
 * The `eco_handoff` handler. It switches the running process to the builder
 * before it returns, so the very next API call of this turn is the builder's
 * (switching after the handler returns is one call late). Edits unlock only
 * once the switch has landed: a parallel Edit in the same message stays
 * denied. On a failed switch the turn stays on the planner with edits blocked;
 * `switchToBuilder` is responsible for putting the planner back.
 */
export async function runEcoHandoff(input: {
  readonly turn: EcoTurnState | null;
  readonly plan: string;
  readonly switchToBuilder: (turn: EcoTurnState) => Promise<void>;
  readonly onHandedOff?: (turn: EcoTurnState) => void;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}): Promise<EcoToolResult> {
  const turn = input.turn;
  if (turn === null) {
    return toolError("Eco handoff is only available on an Eco turn. Carry on without it.");
  }
  if (turn.handedOff || turn.handingOff) {
    return toolError("This turn has already handed off; only one handoff per turn.");
  }
  const plan = input.plan.trim();
  if (plan.length === 0) {
    return toolError("The plan is empty. Call eco_handoff with the six-part markdown plan.");
  }
  turn.handingOff = true;
  try {
    await withTimeout(input.switchToBuilder(turn), input.timeoutMs ?? ECO_SWITCH_TIMEOUT_MS);
  } catch (cause) {
    turn.handingOff = false;
    const detail = cause instanceof Error ? cause.message : String(cause);
    turn.handoffError = detail.slice(0, 500);
    return toolError(
      `The switch to the builder failed (${turn.handoffError}). You are still the planner and edits stay blocked. Report your plan in your reply instead of implementing it.`,
    );
  }
  turn.plan = plan;
  turn.handedOff = true;
  turn.handedOffAt = (input.now ?? (() => new Date()))();
  turn.handingOff = false;
  input.onHandedOff?.(turn);
  return { content: [{ type: "text", text: ECO_HANDOFF_SUCCESS_TEXT }] };
}

const ecoHandoffHandlers = new WeakMap<object, (plan: string) => Promise<EcoToolResult>>();

/** The eco_handoff handler behind a server from `makeEcoMcpServer` (for tests, without an MCP client). */
export const ecoHandoffHandlerOf = (
  server: unknown,
): ((plan: string) => Promise<EcoToolResult>) | undefined =>
  typeof server === "object" && server !== null ? ecoHandoffHandlers.get(server) : undefined;

/** The in-process MCP server that carries `eco_handoff`, loaded up front (not behind ToolSearch). */
export function makeEcoMcpServer(
  handle: (plan: string) => Promise<EcoToolResult>,
): McpSdkServerConfigWithInstance {
  const server = createSdkMcpServer({
    name: ECO_MCP_SERVER_NAME,
    version: "1.0.0",
    alwaysLoad: true,
    timeout: ECO_SWITCH_TIMEOUT_MS + 15_000,
    tools: [
      tool(
        ECO_HANDOFF_TOOL_NAME,
        "Eco mode: hand your plan to the builder model, which implements and tests it in this same turn. Call it once, only when the task needs a lasting code change. The plan is markdown in six parts: Goal, Scope, Where to change, Approach, Tests, Risks.",
        { plan: z.string().describe("The six-part markdown plan.") },
        async ({ plan }) => {
          const result = await handle(plan);
          return {
            content: result.content.map((part) => ({ type: part.type, text: part.text })),
            ...(result.isError === true ? { isError: true } : {}),
          };
        },
        { alwaysLoad: true },
      ),
    ],
  });
  ecoHandoffHandlers.set(server, handle);
  return server;
}

// ---------------------------------------------------------------------------
// Usage

export interface EcoModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly sdkCostUsd: number;
}

/** Per model, from the SDK result's `modelUsage`, with cache reads and writes kept apart. */
export type EcoModelLedger = ReadonlyMap<string, EcoModelUsage>;

export function ecoModelLedger(modelUsage: unknown): EcoModelLedger {
  const ledger = new Map<string, EcoModelUsage>();
  if (typeof modelUsage !== "object" || modelUsage === null) return ledger;
  for (const [model, entry] of Object.entries(modelUsage as Record<string, unknown>)) {
    const fields = (entry ?? {}) as Record<string, unknown>;
    ledger.set(model, {
      inputTokens: count(fields.inputTokens),
      outputTokens: count(fields.outputTokens),
      cacheReadTokens: count(fields.cacheReadInputTokens),
      cacheWriteTokens: count(fields.cacheCreationInputTokens),
      sdkCostUsd: count(fields.costUSD),
    });
  }
  return ledger;
}

export const EMPTY_ECO_USAGE: EcoModelUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  sdkCostUsd: 0,
};

/** Growth per model from `before` to `after`; a counter that went back counts from zero (a new process). */
export function ecoLedgerDelta(before: EcoModelLedger, after: EcoModelLedger): EcoModelLedger {
  const delta = new Map<string, EcoModelUsage>();
  for (const [model, now] of after) {
    const was = before.get(model) ?? EMPTY_ECO_USAGE;
    const wentBack =
      now.inputTokens < was.inputTokens ||
      now.outputTokens < was.outputTokens ||
      now.cacheReadTokens < was.cacheReadTokens ||
      now.cacheWriteTokens < was.cacheWriteTokens;
    const base = wentBack ? EMPTY_ECO_USAGE : was;
    const grown = {
      inputTokens: now.inputTokens - base.inputTokens,
      outputTokens: now.outputTokens - base.outputTokens,
      cacheReadTokens: now.cacheReadTokens - base.cacheReadTokens,
      cacheWriteTokens: now.cacheWriteTokens - base.cacheWriteTokens,
      sdkCostUsd: Math.max(0, now.sdkCostUsd - base.sdkCostUsd),
    };
    if (
      grown.inputTokens + grown.outputTokens + grown.cacheReadTokens + grown.cacheWriteTokens >
      0
    ) {
      delta.set(model, grown);
    }
  }
  return delta;
}

/** A ledger key names `apiModel` when it is the id itself or the id without its `[1m]`-style suffix. */
export const ledgerKeyMatches = (key: string, apiModel: string): boolean => {
  const bare = (model: string) => model.replace(/\[[^\]]*\]$/, "");
  return key === apiModel || bare(key) === bare(apiModel);
};

export interface EcoUsageSplit {
  readonly planner: EcoModelUsage;
  readonly builder: EcoModelUsage;
  /** Models that are neither, such as Claude Code's background Haiku calls. */
  readonly other: ReadonlyArray<{ readonly model: string; readonly usage: EcoModelUsage }>;
}

/**
 * The turn's usage split into the planner's and the builder's: by model, since
 * the two are different models (save-time validation makes sure of that).
 */
export function ecoUsageSplit(
  turnDelta: EcoModelLedger,
  plannerApiModel: string,
  builderApiModel: string,
): EcoUsageSplit {
  let planner = EMPTY_ECO_USAGE;
  let builder = EMPTY_ECO_USAGE;
  const other: Array<{ readonly model: string; readonly usage: EcoModelUsage }> = [];
  const add = (left: EcoModelUsage, right: EcoModelUsage): EcoModelUsage => ({
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    sdkCostUsd: left.sdkCostUsd + right.sdkCostUsd,
  });
  for (const [model, usage] of turnDelta) {
    if (ledgerKeyMatches(model, plannerApiModel)) planner = add(planner, usage);
    else if (ledgerKeyMatches(model, builderApiModel)) builder = add(builder, usage);
    else other.push({ model, usage });
  }
  return { planner, builder, other };
}
