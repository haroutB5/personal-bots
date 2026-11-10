import {
  orchestrationV2RunWorkStartedAt,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type RunId,
  type TurnItemId,
} from "@t3tools/contracts";
import { commandDisplayText } from "@t3tools/client-runtime/work-log/command-label";
import {
  liveThoughtLine,
  summarizeToolGroup,
  toolGroupSummaryKind,
  type ToolGroupSummaryKind,
  type WorkLogPresentationEntry,
  type WorkLogToolLifecycleStatus,
} from "@t3tools/client-runtime/work-log/presentation";
import * as DateTime from "effect/DateTime";

export type WorkStepStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

/**
 * One line of a run's work log. The union keeps a thought from carrying a
 * command label and a file row from carrying a tool name.
 */
export type WorkStep =
  | {
      readonly kind: "thinking";
      readonly id: TurnItemId;
      readonly line: string;
      readonly status: WorkStepStatus;
    }
  | {
      readonly kind: "command";
      readonly id: TurnItemId;
      readonly label: string;
      readonly status: WorkStepStatus;
    }
  | {
      readonly kind: "tool";
      readonly id: TurnItemId;
      readonly label: string;
      readonly status: WorkStepStatus;
    }
  | {
      readonly kind: "file";
      readonly id: TurnItemId;
      readonly label: string;
      readonly status: WorkStepStatus;
    };

export interface RunWorkSummary {
  readonly count: number;
  readonly kind: ToolGroupSummaryKind;
  readonly hasFailure: boolean;
}

/**
 * A run's work as one state machine. The phase comes from the run, so no
 * second boolean can disagree with it.
 */
export type RunWork =
  | { readonly phase: "idle" }
  | {
      readonly phase: "working";
      readonly runId: RunId;
      readonly startedAt: string;
      readonly current: WorkStep | null;
      readonly steps: ReadonlyArray<WorkStep>;
      readonly waitingOnBackground: boolean;
    }
  | {
      readonly phase: "settled";
      readonly runId: RunId;
      readonly durationMs: number;
      readonly steps: ReadonlyArray<WorkStep>;
      /** Steps the server collapsed on the wire, absent from `steps`. */
      readonly deferredCount: number;
      readonly summary: RunWorkSummary;
    };

export const IDLE_RUN_WORK: RunWork = { phase: "idle" };

function isTerminalRun(status: OrchestrationV2Run["status"]): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "interrupted" ||
    status === "cancelled" ||
    status === "rolled_back"
  );
}

/** A queued or preparing run has not begun, so its row waits for the real start. */
function runHasStarted(run: OrchestrationV2Run): boolean {
  if (run.status === "queued" || run.status === "preparing") return false;
  return (
    run.startedAt !== null ||
    run.status === "running" ||
    run.status === "waiting" ||
    isTerminalRun(run.status)
  );
}

function stepStatus(status: OrchestrationV2TurnItem["status"]): WorkStepStatus {
  switch (status) {
    case "idle":
    case "pending":
      return "pending";
    case "running":
    case "waiting":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "cancelled";
  }
}

function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

/**
 * A bot usually starts commands with `cd <dir> &&`. The directory is not what
 * the reader wants, so the label begins at the command itself.
 */
export function commandStepLabel(input: string): string {
  let label = commandDisplayText(input).trim();
  for (;;) {
    const match = /^cd\s+(?:"[^"]*"|'[^']*'|[^;&\n]+?)\s*(?:&&|;)\s*/u.exec(label);
    if (match === null) return label;
    const next = label.slice(match[0].length).trim();
    if (next === "") return label;
    label = next;
  }
}

/** `mcp__t3-code__update_work_record` reads as "update work record". */
export function humanizeToolName(name: string): string {
  const trimmed = name.trim();
  const withoutServer = trimmed.startsWith("mcp__")
    ? trimmed.split("__").slice(2).join("__")
    : trimmed;
  return (withoutServer || trimmed).replace(/_+/gu, " ").trim();
}

const GENERIC_STEP_LABELS: Partial<Record<OrchestrationV2TurnItem["type"], string>> = {
  subagent: "Subagent",
  web_search: "Web search",
  file_search: "File search",
};

/**
 * Rows with their own card. They are not work, so they never count as steps.
 */
const NON_STEP_ITEM_TYPES: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "notification",
  "user_message",
  "assistant_message",
  "proposed_plan",
  "todo_list",
  "approval_request",
  "run_interrupt_request",
  "run_interrupt_result",
  "system_notice",
  "handoff",
]);

function typeLabel(type: string): string {
  const words = type.replace(/_+/gu, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function stepForItem(item: OrchestrationV2TurnItem): WorkStep | null {
  switch (item.type) {
    case "reasoning": {
      const line = liveThoughtLine(item.text);
      return line === ""
        ? null
        : { kind: "thinking", id: item.id, line, status: stepStatus(item.status) };
    }
    case "command_execution": {
      const label = commandStepLabel(item.input);
      return label === ""
        ? null
        : { kind: "command", id: item.id, label, status: stepStatus(item.status) };
    }
    case "dynamic_tool": {
      const label = humanizeToolName(item.toolName ?? item.title ?? "Tool") || "Tool";
      return { kind: "tool", id: item.id, label, status: stepStatus(item.status) };
    }
    case "file_change":
      return {
        kind: "file",
        id: item.id,
        label: basename(item.fileName),
        status: stepStatus(item.status),
      };
    default: {
      if (NON_STEP_ITEM_TYPES.has(item.type)) return null;
      return {
        kind: "tool",
        id: item.id,
        label: GENERIC_STEP_LABELS[item.type] ?? typeLabel(item.type),
        status: stepStatus(item.status),
      };
    }
  }
}

function settleStep(step: WorkStep, runStatus: OrchestrationV2Run["status"]): WorkStep {
  if (
    (runStatus === "interrupted" || runStatus === "cancelled" || runStatus === "rolled_back") &&
    (step.status === "pending" || step.status === "running")
  ) {
    return { ...step, status: "cancelled" };
  }
  return step;
}

export function workStepLabel(step: WorkStep): string {
  return step.kind === "thinking" ? step.line : step.label;
}

function lifecycleStatus(status: WorkStepStatus): WorkLogToolLifecycleStatus {
  switch (status) {
    case "pending":
    case "running":
      return "inProgress";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "stopped";
  }
}

function summaryEntry(
  step: WorkStep,
  itemType: OrchestrationV2TurnItem["type"],
): WorkLogPresentationEntry {
  return {
    id: step.id,
    createdAt: "",
    label: workStepLabel(step),
    tone: step.kind === "thinking" ? "thinking" : "tool",
    itemType,
    toolLifecycleStatus: lifecycleStatus(step.status),
  };
}

function durationMs(
  run: OrchestrationV2Run,
  lastItem: OrchestrationV2TurnItem | undefined,
): number {
  const start = DateTime.toEpochMillis(orchestrationV2RunWorkStartedAt(run));
  const end = run.completedAt ?? lastItem?.completedAt ?? orchestrationV2RunWorkStartedAt(run);
  return Math.max(0, DateTime.toEpochMillis(end) - start);
}

interface RunSteps {
  readonly steps: ReadonlyArray<WorkStep>;
  readonly itemTypes: ReadonlyArray<OrchestrationV2TurnItem["type"]>;
  readonly deferredCount: number;
}

function runSteps(
  rows: ReadonlyArray<OrchestrationV2ThreadProjection["visibleTurnItems"][number]>,
  runStatus: OrchestrationV2Run["status"],
): RunSteps {
  const steps: WorkStep[] = [];
  const itemTypes: OrchestrationV2TurnItem["type"][] = [];
  let deferredCount = 0;
  for (const row of rows) {
    const item = row.item;
    const step = stepForItem(item);
    const deferred = item.deferredWork?.itemCount;
    if (step === null) {
      if (deferred !== undefined) deferredCount += deferred;
      continue;
    }
    steps.push(settleStep(step, runStatus));
    itemTypes.push(item.type);
    if (deferred !== undefined) deferredCount += deferred - 1;
  }
  return { steps, itemTypes, deferredCount };
}

/**
 * Live thinking and steps for the thread's latest started run. A queued run
 * does not replace the previous run's row until it begins. Reads turn items
 * directly so the v1 chat adapter and its tool-step setting stay untouched.
 */
export function runWork(projection: OrchestrationV2ThreadProjection): RunWork {
  const run = projection.runs.findLast(runHasStarted);
  if (run === undefined) return IDLE_RUN_WORK;

  const rows = projection.visibleTurnItems
    .filter((row) => row.item.runId === run.id)
    .toSorted((left, right) => left.position - right.position);
  const { steps, itemTypes, deferredCount } = runSteps(rows, run.status);

  if (!isTerminalRun(run.status)) {
    const current = steps.findLast((step) => step.status === "running") ?? steps.at(-1) ?? null;
    return {
      phase: "working",
      runId: run.id,
      startedAt: DateTime.formatIso(orchestrationV2RunWorkStartedAt(run)),
      current,
      steps,
      waitingOnBackground: run.status === "waiting",
    };
  }

  const entries = steps.map((step, index) => summaryEntry(step, itemTypes[index]!));
  const summary = summarizeToolGroup(entries);
  return {
    phase: "settled",
    runId: run.id,
    durationMs: durationMs(run, rows.at(-1)?.item),
    steps,
    deferredCount,
    summary: {
      count: steps.length + deferredCount,
      kind: toolGroupSummaryKind(entries),
      hasFailure: summary.hasFailure || run.status === "failed",
    },
  };
}
