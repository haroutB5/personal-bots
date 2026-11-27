import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  bashCommandWrites,
  ECO_EDIT_DENIED_REASON,
  ECO_HANDOFF_SUCCESS_TEXT,
  ECO_TURN_INSTRUCTIONS,
  ecoBuilderProblem,
  ecoLedgerDelta,
  ecoModelLedger,
  ecoToolDenial,
  ecoTurnModels,
  ecoUsageSplit,
  makeEcoPreToolUseHook,
  makeEcoTurnState,
  noteEcoCall,
  noteEcoStreamEvent,
  noteEcoUsage,
  runEcoHandoff,
  withEcoInstructions,
} from "./ecoMode.ts";
import { BUNDLED_CLAUDE_MODEL_CATALOG } from "../../provider/ClaudeModelCatalog.ts";

const claude = ProviderInstanceId.make("claudeAgent");
const opus: ModelSelection = {
  instanceId: claude,
  model: "claude-opus-5-5",
  options: [{ id: "effort", value: "high" }],
};
const sonnet: ModelSelection = {
  instanceId: claude,
  model: "claude-sonnet-5-5",
  options: [{ id: "effort", value: "high" }],
};

const newTurn = () =>
  makeEcoTurnState({
    runId: "run-1",
    threadId: "thread-1",
    models: { planner: opus, builder: sonnet },
    plannerApiModel: "claude-opus-5-5",
    builderApiModel: "claude-sonnet-5-5",
    startedAt: new Date(0),
  });

const ecoBot = (overrides?: { enabled?: boolean; fallbackActive?: boolean }) => ({
  modelSelection: opus,
  eco: { enabled: overrides?.enabled ?? true, modelSelection: sonnet },
  ...(overrides?.fallbackActive === true
    ? { fallbackActive: { modelSelection: sonnet, until: "2026-01-01T00:00:00.000Z" } as never }
    : {}),
});

describe("ecoTurnModels", () => {
  it("is an Eco turn for a delegated task of an Eco bot on its own model", () => {
    expect(
      ecoTurnModels({ bot: ecoBot(), messageId: "personal-task-abc", modelSelection: opus }),
    ).toEqual({ planner: opus, builder: sonnet });
  });

  it("skips interactive chats and group rounds", () => {
    expect(ecoTurnModels({ bot: ecoBot(), messageId: "msg-1", modelSelection: opus })).toBe(
      undefined,
    );
    expect(
      ecoTurnModels({ bot: ecoBot(), messageId: "personal-group-1", modelSelection: opus }),
    ).toBe(undefined);
  });

  it("skips a bot with Eco off", () => {
    expect(
      ecoTurnModels({
        bot: ecoBot({ enabled: false }),
        messageId: "personal-task-1",
        modelSelection: opus,
      }),
    ).toBe(undefined);
  });

  it("skips a bot on its usage-limit fallback", () => {
    expect(
      ecoTurnModels({
        bot: ecoBot({ fallbackActive: true }),
        messageId: "personal-task-1",
        modelSelection: opus,
      }),
    ).toBe(undefined);
    // The turn running on another model (the fallback) is skipped too.
    expect(
      ecoTurnModels({ bot: ecoBot(), messageId: "personal-task-1", modelSelection: sonnet }),
    ).toBe(undefined);
  });

  it("skips a bot on another provider", () => {
    const codex: ModelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
    expect(
      ecoTurnModels({
        bot: { modelSelection: codex, eco: { enabled: true, modelSelection: sonnet } },
        messageId: "personal-task-1",
        modelSelection: codex,
      }),
    ).toBe(undefined);
  });
});

describe("ecoBuilderProblem (settings validation)", () => {
  it("accepts Sonnet with an effort under Opus", () => {
    expect(ecoBuilderProblem(opus, sonnet)).toBe(undefined);
  });
  it("rejects another provider instance", () => {
    expect(
      ecoBuilderProblem(opus, { ...sonnet, instanceId: ProviderInstanceId.make("claudeWork") }),
    ).toMatch(/own provider/);
  });
  it("rejects the bot's own model", () => {
    expect(ecoBuilderProblem(opus, opus)).toMatch(/different model/);
  });
  it("rejects a builder that cannot switch live", () => {
    // Haiku 4.5 has a thinking switch and no effort, so Opus with an effort cannot switch to it live.
    expect(
      ecoBuilderProblem(
        opus,
        {
          instanceId: claude,
          model: "claude-haiku-4-5",
          options: [{ id: "thinking", value: true }],
        },
        BUNDLED_CLAUDE_MODEL_CATALOG,
      ),
    ).toMatch(/thinking setting/);
    expect(
      ecoBuilderProblem(
        opus,
        {
          instanceId: claude,
          model: "claude-haiku-5-5",
          options: [{ id: "effort", value: "high" }],
        },
        BUNDLED_CLAUDE_MODEL_CATALOG,
      ),
    ).toBe(undefined);
  });
});

describe("bashCommandWrites", () => {
  const writes = [
    "echo hi > file.txt",
    "cat a >> b",
    "sed -i 's/a/b/' x.ts",
    "perl -pi -e 's/a/b/' x",
    "tee out.log < in",
    "ls && rm -f x",
    "mv a b",
    "cp a b",
    "mkdir -p dir",
    "touch x",
    "git commit -m wip",
    "git -C repo add .",
    "git checkout -b feature",
    "git stash",
    "git branch new-branch",
    "sudo rm x",
    "env FOO=1 rm x",
    "find . -name '*.tmp' -delete",
    "find . -exec rm {} \\;",
    "pnpm install",
    "npm i left-pad",
    "echo $(rm x)",
    "chmod +x run.sh",
  ];
  const reads = [
    "ls -la",
    "cat README.md",
    "grep -rn 'a > b' src",
    "rg foo | head -5",
    "git status",
    "git log --oneline -5",
    "git diff HEAD~1",
    "git branch",
    "git stash list",
    "npm test 2>&1",
    "node script.mjs > /dev/null",
    "sed -n 1,20p file.ts",
    "find . -name '*.ts'",
    "echo 'rm -rf /' ",
  ];
  for (const command of writes) {
    it(`flags a write: ${command}`, () => expect(bashCommandWrites(command)).toBe(true));
  }
  for (const command of reads) {
    it(`allows a read: ${command}`, () => expect(bashCommandWrites(command)).toBe(false));
  }
});

describe("the edit guard", () => {
  it("denies edits before the handoff and allows them after", async () => {
    const turn = newTurn();
    expect(ecoToolDenial(turn, "Edit", { file_path: "a" })).toBe(ECO_EDIT_DENIED_REASON);
    expect(ecoToolDenial(turn, "Write", {})).toBe(ECO_EDIT_DENIED_REASON);
    expect(ecoToolDenial(turn, "MultiEdit", {})).toBe(ECO_EDIT_DENIED_REASON);
    expect(ecoToolDenial(turn, "NotebookEdit", {})).toBe(ECO_EDIT_DENIED_REASON);
    expect(ecoToolDenial(turn, "Bash", { command: "rm x" })).toBe(ECO_EDIT_DENIED_REASON);
    // Read-only, memory, browser and MCP tools stay allowed.
    expect(ecoToolDenial(turn, "Read", { file_path: "a" })).toBe(undefined);
    expect(ecoToolDenial(turn, "Bash", { command: "ls" })).toBe(undefined);
    expect(ecoToolDenial(turn, "mcp__t3-code__save_memory", {})).toBe(undefined);
    expect(ecoToolDenial(turn, "mcp__t3-code__preview_act", {})).toBe(undefined);

    const hook = makeEcoPreToolUseHook(() => turn);
    const call = (tool_name: string, tool_input: unknown) =>
      hook(
        {
          hook_event_name: "PreToolUse",
          tool_name,
          tool_input,
          tool_use_id: "tu-1",
          session_id: "s",
          transcript_path: "",
          cwd: "/",
        } as never,
        "tu-1",
        { signal: new AbortController().signal },
      );
    expect(await call("Edit", {})).toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
    });
    await runEcoHandoff({ turn, plan: "## Goal\nx", switchToBuilder: () => Promise.resolve() });
    expect(await call("Edit", {})).toEqual({});
    expect(ecoToolDenial(turn, "Bash", { command: "rm x" })).toBe(undefined);
  });

  it("never acts outside an Eco turn", async () => {
    expect(ecoToolDenial(null, "Edit", {})).toBe(undefined);
    const hook = makeEcoPreToolUseHook(() => null);
    expect(
      await hook(
        { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: {} } as never,
        "x",
        {
          signal: new AbortController().signal,
        },
      ),
    ).toEqual({});
  });
});

describe("runEcoHandoff", () => {
  it("switches to the builder before it returns, then unlocks edits", async () => {
    const turn = newTurn();
    const order: Array<string> = [];
    const result = await runEcoHandoff({
      turn,
      plan: "  ## Goal\nShip it  ",
      switchToBuilder: async () => {
        order.push("switch");
        // A parallel Edit during the switch stays denied.
        expect(ecoToolDenial(turn, "Edit", {})).toBe(ECO_EDIT_DENIED_REASON);
      },
      onHandedOff: () => order.push("handed-off"),
      now: () => new Date(5),
    });
    expect(result).toEqual({ content: [{ type: "text", text: ECO_HANDOFF_SUCCESS_TEXT }] });
    expect(order).toEqual(["switch", "handed-off"]);
    expect(turn.handedOff).toBe(true);
    expect(turn.plan).toBe("## Goal\nShip it");
    expect(turn.handedOffAt).toEqual(new Date(5));
  });

  it("keeps the planner and blocks edits when the switch fails", async () => {
    const turn = newTurn();
    const result = await runEcoHandoff({
      turn,
      plan: "## Goal",
      switchToBuilder: () => Promise.reject(new Error("setModel refused")),
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/setModel refused/);
    expect(turn.handedOff).toBe(false);
    expect(turn.handingOff).toBe(false);
    expect(turn.handoffError).toBe("setModel refused");
    expect(ecoToolDenial(turn, "Edit", {})).toBe(ECO_EDIT_DENIED_REASON);
  });

  it("times out a switch that never lands", async () => {
    const turn = newTurn();
    const result = await runEcoHandoff({
      turn,
      plan: "## Goal",
      timeoutMs: 10,
      switchToBuilder: () => new Promise<void>(() => undefined),
    });
    expect(result.isError).toBe(true);
    expect(turn.handoffError).toMatch(/timed out/);
    expect(turn.handedOff).toBe(false);
  });

  it("allows one handoff per turn", async () => {
    const turn = newTurn();
    let switches = 0;
    const switchToBuilder = async () => {
      switches += 1;
    };
    await runEcoHandoff({ turn, plan: "## Goal", switchToBuilder });
    const again = await runEcoHandoff({ turn, plan: "## Goal 2", switchToBuilder });
    expect(again.isError).toBe(true);
    expect(again.content[0]?.text).toMatch(/only one handoff/);
    expect(switches).toBe(1);
    expect(turn.plan).toBe("## Goal");
  });

  it("refuses a handoff while one is in flight", async () => {
    const turn = newTurn();
    let release: () => void = () => undefined;
    const first = runEcoHandoff({
      turn,
      plan: "## Goal",
      switchToBuilder: () => new Promise<void>((resolve) => (release = resolve)),
    });
    const second = await runEcoHandoff({
      turn,
      plan: "## Goal",
      switchToBuilder: () => Promise.resolve(),
    });
    expect(second.isError).toBe(true);
    release();
    expect((await first).isError).toBeUndefined();
  });

  it("refuses outside an Eco turn and an empty plan", async () => {
    const ok = () => Promise.resolve();
    expect((await runEcoHandoff({ turn: null, plan: "x", switchToBuilder: ok })).isError).toBe(
      true,
    );
    const turn = newTurn();
    expect((await runEcoHandoff({ turn, plan: "  ", switchToBuilder: ok })).isError).toBe(true);
    expect(turn.handedOff).toBe(false);
  });
});

describe("Eco bookkeeping", () => {
  it("prepends the planner's instruction", () => {
    expect(withEcoInstructions("Fix the bug")).toBe(`${ECO_TURN_INSTRUCTIONS}\n\nFix the bug`);
    expect(ECO_TURN_INSTRUCTIONS).toMatch(/Goal, Scope, Where to change, Approach, Tests, Risks/);
    // The planner checks what its plan names exists, and lists what it could not confirm.
    expect(ECO_TURN_INSTRUCTIONS).toMatch(
      /check that every file, function, option, flag and command your plan names really exists/,
    );
    expect(ECO_TURN_INSTRUCTIONS).toMatch(/could not confirm under Risks/);
    // The builder follows the task, not a plan the code contradicts, and says so.
    expect(ECO_HANDOFF_SUCCESS_TEXT).toMatch(/^Implement this plan now; you are the builder\./);
    expect(ECO_HANDOFF_SUCCESS_TEXT).toMatch(/do not follow it blindly/);
    expect(ECO_HANDOFF_SUCCESS_TEXT).toMatch(/Do what the task actually asks/);
    expect(ECO_HANDOFF_SUCCESS_TEXT).toMatch(
      /say in your final reply where you departed from the plan/,
    );
  });

  it("puts each call on the side it ran on", () => {
    const turn = newTurn();
    noteEcoCall(turn, "m1", "claude-opus-5-5");
    turn.handedOff = true;
    noteEcoCall(turn, "m1", "claude-opus-5-5");
    noteEcoCall(turn, "m2", "claude-sonnet-5-5");
    noteEcoCall(turn, "m3", "<synthetic>");
    expect([...turn.calls.values()]).toEqual([
      { id: "m1", model: "claude-opus-5-5", side: "planner" },
      { id: "m2", model: "claude-sonnet-5-5", side: "builder" },
    ]);
  });

  it("takes each call's final output count from its message_delta", () => {
    const turn = newTurn();
    const start = (id: string, model: string) => ({
      type: "message_start",
      message: {
        id,
        model,
        usage: {
          input_tokens: 2,
          output_tokens: 9,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 500,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 500 },
        },
      },
    });
    noteEcoStreamEvent(turn, "root", start("m1", "claude-opus-5-5"));
    noteEcoStreamEvent(turn, "tool-1", start("s1", "claude-sonnet-5-5"));
    // The assistant snapshot repeats message_start's usage.
    noteEcoUsage(turn, "m1", "claude-opus-5-5", start("m1", "claude-opus-5-5").message.usage);
    noteEcoStreamEvent(turn, "root", {
      type: "message_delta",
      usage: { output_tokens: 4024, cache_read_input_tokens: null },
    });
    noteEcoStreamEvent(turn, "tool-1", { type: "message_delta", usage: { output_tokens: 300 } });
    // A delta with no message_start on its stream is ignored.
    noteEcoStreamEvent(turn, "tool-2", { type: "message_delta", usage: { output_tokens: 7 } });
    expect(turn.usage.get("m1")).toEqual({
      id: "m1",
      model: "claude-opus-5-5",
      inputTokens: 2,
      outputTokens: 4024,
      cacheReadTokens: 1000,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 500,
    });
    expect(turn.usage.get("s1")?.outputTokens).toBe(300);
    expect(turn.usage.size).toBe(2);
  });

  it("splits the turn's usage by model, cache reads and writes apart", () => {
    const usage = (input: number, output: number, read: number, write: number, cost: number) => ({
      inputTokens: input,
      outputTokens: output,
      cacheReadInputTokens: read,
      cacheCreationInputTokens: write,
      costUSD: cost,
    });
    const before = ecoModelLedger({ "claude-opus-5-5[1m]": usage(10, 5, 100, 50, 0.1) });
    const after = ecoModelLedger({
      "claude-opus-5-5[1m]": usage(30, 15, 300, 60, 0.3),
      "claude-sonnet-5-5": usage(7, 70, 700, 32_000, 0.2),
      "claude-haiku-4-5": usage(1, 1, 0, 0, 0.001),
    });
    const split = ecoUsageSplit(
      ecoLedgerDelta(before, after),
      "claude-opus-5-5",
      "claude-sonnet-5-5",
    );
    expect(split.planner).toEqual({
      inputTokens: 20,
      outputTokens: 10,
      cacheReadTokens: 200,
      cacheWriteTokens: 10,
      sdkCostUsd: expect.closeTo(0.2, 6),
    });
    expect(split.builder).toEqual({
      inputTokens: 7,
      outputTokens: 70,
      cacheReadTokens: 700,
      cacheWriteTokens: 32_000,
      sdkCostUsd: expect.closeTo(0.2, 6),
    });
    expect(split.other.map((entry) => entry.model)).toEqual(["claude-haiku-4-5"]);
  });
});
