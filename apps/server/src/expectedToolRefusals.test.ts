import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";

import {
  downgradeExpectedRefusals,
  EXPECTED_TOOL_REFUSAL_TAGS,
  expectedToolRefusals,
} from "./expectedToolRefusals.ts";

class Refusal extends Error {
  readonly _tag: string;
  constructor(tag: string, message: string) {
    super(message);
    this._tag = tag;
  }
}

interface Line {
  readonly level: string;
  readonly text: string;
  readonly hasCause: boolean;
}

/** What the server's logger would write for `effect`, as plain lines. */
const logged = (effect: Effect.Effect<unknown, Error>) => {
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

/** The way the MCP toolkit runner logs a failed tool call. */
const toolFailed = (error: Error) => Effect.fail(error).pipe(Effect.tapCause(Effect.logError));

describe("expected tool refusals in the log", () => {
  it.effect("the owner holding the browser is one INFO line without a stack", () =>
    Effect.gen(function* () {
      const lines = yield* logged(
        toolFailed(
          new Refusal(
            "PreviewAutomationControlInterruptedError",
            "The user has taken control of the shared browser. Wait until they return control.",
          ),
        ),
      );
      expect(lines).toEqual([
        {
          level: "Info",
          text: "tool call refused: PreviewAutomationControlInterruptedError: The user has taken control of the shared browser. Wait until they return control.",
          hasCause: false,
        },
      ]);
    }),
  );

  it.effect("a login mismatch and an untrusted certificate are refusals too", () =>
    Effect.gen(function* () {
      const lines = yield* logged(
        Effect.all([
          toolFailed(new Refusal("BotsToolError", "Login origin mismatch.")),
          toolFailed(
            new Refusal(
              "PreviewAutomationExecutionError",
              "The site's certificate was not trusted.",
            ),
          ),
        ]).pipe(Effect.ignore),
      );
      expect(lines.map((line) => line.level)).toEqual(["Info"]);
      const second = yield* logged(
        toolFailed(new Refusal("PreviewAutomationExecutionError", "certificate")),
      );
      expect(second[0]?.level).toBe("Info");
    }),
  );

  it.effect("a defect, an unknown error and a real tool failure stay ERROR with their cause", () =>
    Effect.gen(function* () {
      const defect = yield* logged(
        Effect.die(new Error("boom")).pipe(Effect.tapCause(Effect.logError)),
      );
      expect(defect).toHaveLength(1);
      expect(defect[0]).toMatchObject({ level: "Error", hasCause: true });

      const unknown = yield* logged(toolFailed(new Refusal("DatabaseFailure", "disk full")));
      expect(unknown[0]).toMatchObject({ level: "Error", hasCause: true });

      const plain = yield* logged(toolFailed(new Refusal("", "no tag")));
      expect(plain[0]).toMatchObject({ level: "Error", hasCause: true });
    }),
  );

  it.effect("a refusal mixed with a defect is still an ERROR", () =>
    Effect.gen(function* () {
      const mixed = Cause.combine(
        Cause.fail(new Refusal("BotsToolError", "refused")),
        Cause.die(new Error("boom")),
      );
      const lines = yield* logged(Effect.logError(mixed));
      expect(lines[0]).toMatchObject({ level: "Error", hasCause: true });
    }),
  );

  it.effect("other levels and plain error messages pass through untouched", () =>
    Effect.gen(function* () {
      const lines = yield* logged(
        Effect.logWarning("careful").pipe(Effect.andThen(Effect.logError("a real error"))),
      );
      expect(lines).toEqual([
        { level: "Warn", text: "careful", hasCause: false },
        { level: "Error", text: "a real error", hasCause: false },
      ]);
    }),
  );

  it("names only declared refusals", () => {
    expect(expectedToolRefusals(Cause.fail(new Refusal("BotsToolError", "x")))).toEqual([
      { tag: "BotsToolError", message: "x" },
    ]);
    expect(expectedToolRefusals(Cause.empty)).toBeNull();
    expect(expectedToolRefusals(Cause.interrupt())).toBeNull();
    expect(EXPECTED_TOOL_REFUSAL_TAGS.has("PreviewAutomationUnavailableError")).toBe(false);
    expect(EXPECTED_TOOL_REFUSAL_TAGS.has("PreviewAutomationTimeoutError")).toBe(false);
  });
});
