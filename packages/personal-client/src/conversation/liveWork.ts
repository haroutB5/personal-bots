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
    }
  | {
      readonly phase: "settled";
      readonly runId: RunId;
      readonly durationMs: number;
      readonly steps: ReadonlyArray<WorkStep>;
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

function stepForItem(item: OrchestrationV2TurnItem): WorkStep | null {
  switch (item.type) {
    case "reasoning": {
      const line = liveThoughtLine(item.text);
      return line === ""
        ? null
        : { kind: "thinking", id: item.id, line, status: stepStatus(item.status) };
    }
    case "command_execution": {
      const label = commandDisplayText(item.input).trim();
      return label === ""
        ? null
        : { kind: "command", id: item.id, label, status: stepStatus(item.status) };
    }
    case "dynamic_tool": {
      const label = (item.toolName ?? item.title ?? "Tool").trim();
      return { kind: "tool", id: item.id, label, status: stepStatus(item.status) };
    }
    case "file_change":
      return {
        kind: "file",
        id: item.id,
        label: basename(item.fileName),
        status: stepStatus(item.status),
      };
    default:
      // Approvals, notifications and plan rows have their own cards.
      return null;
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

/**
 * Live thinking and steps for the thread's latest run. Reads turn items
 * directly so the v1 chat adapter and its tool-step setting stay untouched.
 */
export function runWork(projection: OrchestrationV2ThreadProjection): RunWork {
  const run = projection.runs.at(-1);
  if (run === undefined) return IDLE_RUN_WORK;

  const rows = projection.visibleTurnItems
    .filter((row) => row.item.runId === run.id)
    .toSorted((left, right) => left.position - right.position);
  const derived = rows.flatMap((row) => {
    const step = stepForItem(row.item);
    return step === null ? [] : [{ step, itemType: row.item.type }];
  });
  const steps = derived.map(({ step }) => settleStep(step, run.status));

  if (!isTerminalRun(run.status)) {
    const current = steps.findLast((step) => step.status === "running") ?? steps.at(-1) ?? null;
    return {
      phase: "working",
      runId: run.id,
      startedAt: DateTime.formatIso(orchestrationV2RunWorkStartedAt(run)),
      current,
      steps,
    };
  }

  const entries = steps.map((step, index) => summaryEntry(step, derived[index]!.itemType));
  const summary = summarizeToolGroup(entries);
  return {
    phase: "settled",
    runId: run.id,
    durationMs: durationMs(run, rows.at(-1)?.item),
    steps,
    summary: {
      count: steps.length,
      kind: toolGroupSummaryKind(entries),
      hasFailure: summary.hasFailure || run.status === "failed",
    },
  };
}
