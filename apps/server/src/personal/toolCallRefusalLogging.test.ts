/**
 * A tool call the bot got wrong (a parameter that does not fit the tool's
 * schema, a credential that does not grant the capability the tool needs) must
 * reach the server log as one WARN line naming the tool, the failing path and
 * the schema's message, and a real handler fault must stay ERROR: the hbots
 * release runner fails a release on any ERROR line after the restart.
 *
 * This lives under src/personal because that is the fork gate
 * (`vp test run src/personal`), and the personal and bots toolkits are where
 * these calls land.
 */
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Tool, Toolkit } from "effect/unstable/ai";

import { downgradeExpectedRefusals } from "../expectedToolRefusals.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { UpdateWorkRecordInput } from "../mcp/toolkits/bots/tools.ts";

interface Line {
  readonly level: string;
  readonly text: string;
  readonly hasCause: boolean;
}

/** What the server's logger would write for `effect`, as plain lines. */
const logged = <E>(effect: Effect.Effect<unknown, E>) => {
  const lines: Array<Line> = [];
  const sink = downgradeExpectedRefusals(
    Logger.make<unknown, void>((options) => {
      lines.push({
        level: options.logLevel,
        text: Array.isArray(options.message) ? options.message.join(" ") : String(options.message),
        hasCause: options.cause.reasons.length > 0,
      });
    }),
  );
  return effect.pipe(
    Effect.exit,
    Effect.provide(
      Layer.mergeAll(
        Logger.layer([sink], { mergeWithExisting: false }),
        Layer.succeed(References.MinimumLogLevel, "Info"),
      ),
    ),
    Effect.map(() => lines),
  );
};

/**
 * The real `update_work_record` parameters behind a handler that cannot fail,
 * so a bad call fails exactly where the MCP toolkit runner sees it.
 */
const WorkRecordTool = Tool.make("update_work_record", {
  parameters: UpdateWorkRecordInput,
  success: Schema.Struct({ record: Schema.String }),
});
const WorkRecordToolkit = Toolkit.make(WorkRecordTool);
const workRecordToolkit = WorkRecordToolkit.pipe(
  Effect.provide(
    WorkRecordToolkit.toLayer({ update_work_record: () => Effect.succeed({ record: "saved" }) }),
  ),
);

/** The same tool with a handler that breaks: a real fault has to stay ERROR. */
const BrokenToolkit = Toolkit.make(WorkRecordTool);
const brokenToolkit = BrokenToolkit.pipe(
  Effect.provide(
    BrokenToolkit.toLayer({
      update_work_record: () => Effect.die(new Error("the record store is on fire")),
    }),
  ),
);

describe("a tool call the bot got wrong in the server log", () => {
  it.effect("a parameter that does not fit is one WARN line with tool, path and message", () =>
    Effect.gen(function* () {
      const built = yield* workRecordToolkit;
      // The way the MCP toolkit runner runs the call and logs a failure.
      const lines = yield* logged(
        built
          .handle("update_work_record", {
            decisions: ["one", "two", "three", "four", "five", "six", "seven"],
          })
          .pipe(Stream.unwrap, Stream.runDrain, Effect.tapCause(Effect.logError)),
      );
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ level: "Warn", hasCause: false });
      expect(lines[0]?.text).toBe(
        'tool call refused: update_work_record: Expected a value with a length of at most 6 at ["decisions"]',
      );
      // The arguments the bot sent never reach the log.
      expect(lines[0]?.text).not.toContain("seven");
    }),
  );

  it.effect("a member or a field of the wrong type names its own path", () =>
    Effect.gen(function* () {
      const built = yield* workRecordToolkit;
      // A malformed call exactly as a bot sends one: the MCP layer decodes the
      // payload, so an argument of the wrong type arrives unchecked.
      const badMember = yield* logged(
        built
          .handle("update_work_record", { decisions: [42] } as never)
          .pipe(Stream.unwrap, Stream.runDrain, Effect.tapCause(Effect.logError)),
      );
      const badField = yield* logged(
        built
          .handle("update_work_record", { evidence: "not-an-array" } as never)
          .pipe(Stream.unwrap, Stream.runDrain, Effect.tapCause(Effect.logError)),
      );
      expect(badMember).toHaveLength(1);
      expect(badMember[0]).toMatchObject({ level: "Warn", hasCause: false });
      expect(badMember[0]?.text).toBe(
        'tool call refused: update_work_record: Expected string at ["decisions"][0]',
      );
      expect(badField).toHaveLength(1);
      expect(badField[0]).toMatchObject({ level: "Warn", hasCause: false });
      expect(badField[0]?.text).toBe(
        'tool call refused: update_work_record: Expected array | undefined at ["evidence"]',
      );
    }),
  );

  it.effect("a missing capability is one WARN line, not an ERROR with a stack", () =>
    Effect.gen(function* () {
      const invocation: McpInvocationContext.McpInvocationScope = {
        environmentId: EnvironmentId.make("environment-1"),
        threadId: ThreadId.make("thread-1"),
        providerSessionId: "provider-session-1",
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        capabilities: new Set(),
        issuedAt: 1,
      };
      const lines = yield* logged(
        McpInvocationContext.requireMcpCapability("bots").pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.tapCause(Effect.logError),
        ),
      );
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ level: "Warn", hasCause: false });
      expect(lines[0]?.text).toBe(
        "tool call refused: McpCapabilityUnavailableError: MCP credential does not grant the bots capability.",
      );
      // The preview toolkit's own capability error, the same kind of answer.
      const preview = yield* logged(
        McpInvocationContext.requireMcpCapability("preview").pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.tapCause(Effect.logError),
        ),
      );
      expect(preview).toHaveLength(1);
      expect(preview[0]).toMatchObject({ level: "Warn", hasCause: false });
      expect(preview[0]?.text).toContain("PreviewAutomationUnavailableError");
      expect(preview[0]?.text).toContain("does not grant the preview capability");
    }),
  );

  it.effect("a handler that breaks is still one ERROR line with its cause", () =>
    Effect.gen(function* () {
      const built = yield* brokenToolkit;
      const lines = yield* logged(
        built
          .handle("update_work_record", {})
          .pipe(Stream.unwrap, Stream.runDrain, Effect.tapCause(Effect.logError)),
      );
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ level: "Error", hasCause: true });
    }),
  );
});
