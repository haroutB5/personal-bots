/**
 * The Claude side of the summary, without a Claude CLI, a subscription or a
 * network: the provider instance is a stand-in that records what it was asked.
 *
 * What matters here is the contract the worker relies on: it is the Claude
 * agent instance, on the Haiku 5.5 text-generation default at the medium effort
 * the summary names (Harout, 16 Oct 2026), the prompt and the JSON schema go
 * through untouched, and the answer is read by the one shared parser. A failure
 * is reported as its class only: a `TextGenerationError`'s detail can carry CLI
 * output, and none of it may reach a log.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";

import { CLAUDE_TEXT_GENERATION_DEFAULT_MODEL } from "../../provider/claudeBackgroundModels.ts";
import type { ProviderInstance } from "../../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../../provider/Services/ProviderInstanceRegistry.ts";
import { VOICE_CALL_GREETING_SUMMARY } from "./voiceCallSummary.ts";
import {
  VOICE_CALL_SUMMARY_CLAUDE_EFFORT,
  VoiceCallSummaryClaude,
  claudeLayer,
} from "./voiceCallSummaryClaude.ts";

/** Text an error may carry and a log never may. */
const PRIVATE = "SECRET-OWNER-WORDS-7f3a91";

interface Asked {
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  readonly options: unknown;
  readonly prompt: string;
  readonly schema: unknown;
}

interface WriterOptions {
  /** What Claude's structured call resolves to. */
  readonly answer?: unknown;
  /** Make the call itself fail, as a usage limit or a CLI error does. */
  readonly fail?: TextGenerationError;
  /** Register no Claude provider instance at all. */
  readonly missing?: boolean;
}

const withWriter = <A, E, R>(
  options: WriterOptions,
  body: (service: VoiceCallSummaryClaude["Service"], asked: Array<Asked>) => Effect.Effect<A, E, R>,
) => {
  const asked: Array<Asked> = [];
  const generateStructured = (input: {
    readonly prompt: string;
    readonly outputSchema: unknown;
    readonly modelSelection: {
      readonly instanceId: ProviderInstanceId;
      readonly model: string;
      readonly options?: ReadonlyArray<unknown>;
    };
  }) =>
    Effect.gen(function* () {
      asked.push({
        instanceId: input.modelSelection.instanceId,
        model: input.modelSelection.model,
        options: input.modelSelection.options,
        prompt: input.prompt,
        schema: input.outputSchema,
      });
      if (options.fail !== undefined) return yield* Effect.fail(options.fail);
      return options.answer;
    });
  const instance = {
    id: ProviderInstanceId.make("claudeAgent"),
    textGeneration: { generateStructured },
  } as unknown as ProviderInstance;
  const registry = Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
    getInstance: () => Effect.succeed(options.missing === true ? undefined : instance),
  });
  return Effect.gen(function* () {
    const service = yield* VoiceCallSummaryClaude;
    return yield* body(service, asked);
  }).pipe(Effect.provide(claudeLayer.pipe(Layer.provide(registry))));
};

describe("VoiceCallSummaryClaude", () => {
  it.effect("asks the Claude agent instance on Haiku 5.5 at medium effort", () =>
    withWriter({ answer: { summary: "One line." } }, (service, asked) =>
      Effect.gen(function* () {
        // The release's own expectation: the text-generation default, with the
        // effort this path names so the low background default cannot win.
        expect(CLAUDE_TEXT_GENERATION_DEFAULT_MODEL).toBe("claude-haiku-5-5");
        expect(service.model).toBe("claude-haiku-5-5");
        expect(service.effort).toBe("medium");
        expect(VOICE_CALL_SUMMARY_CLAUDE_EFFORT).toBe("medium");
        yield* service.ask("a transcript");
        expect(asked).toHaveLength(1);
        expect(String(asked[0]!.instanceId)).toBe("claudeAgent");
        expect(asked[0]!.model).toBe("claude-haiku-5-5");
        // The effort is named on the selection, which is what makes the
        // text-generation path keep it instead of folding in its low default.
        expect(asked[0]!.options).toEqual([{ id: "effort", value: "medium" }]);
        expect(asked[0]!.prompt).toBe("a transcript");
        // The JSON contract the prompt describes, handed over as the schema.
        expect(asked[0]!.schema).toBeDefined();
      }),
    ),
  );

  it.effect("reads the answer through the one shared parser, short calls included", () =>
    withWriter(
      {
        answer: {
          summary: "A quick hello.",
          points: [],
          decision: "null",
          open: null,
          shortCall: true,
        },
      },
      (service) =>
        Effect.gen(function* () {
          expect(yield* service.ask("prompt")).toEqual({
            summary: VOICE_CALL_GREETING_SUMMARY,
            points: [],
            decision: null,
            open: null,
          });
        }),
    ),
  );

  it.effect("keeps a real finding rather than collapsing it to the short-call line", () =>
    withWriter(
      {
        answer: {
          summary: "The voice said Court 3 is free 11:00-12:00.",
          points: ["Court 3 free 11:00-12:00 Saturday"],
          decision: null,
          open: null,
          shortCall: true,
        },
      },
      (service) =>
        Effect.gen(function* () {
          expect(yield* service.ask("prompt")).toEqual({
            summary: "The voice said Court 3 is free 11:00-12:00.",
            points: ["Court 3 free 11:00-12:00 Saturday"],
            decision: null,
            open: null,
          });
        }),
    ),
  );

  it.effect("answers null, not a failure, when Claude returned nothing usable", () =>
    withWriter({ answer: { points: [] } }, (service) =>
      Effect.gen(function* () {
        expect(yield* service.ask("prompt")).toBeNull();
      }),
    ),
  );

  it.effect("fails as unavailable when no Claude provider instance is registered", () =>
    withWriter({ missing: true }, (service) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(service.ask("prompt"));
        expect(error).toContain("not registered");
      }),
    ),
  );

  it.effect("reports the error's class, never the words it carried", () =>
    withWriter(
      {
        fail: new TextGenerationError({
          operation: "generateStructured",
          detail: `Claude CLI command failed: ${PRIVATE}`,
        }),
      },
      (service) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(service.ask("prompt"));
          expect(error).toBe("TextGenerationError");
          expect(error).not.toContain(PRIVATE);
        }),
    ),
  );
});
