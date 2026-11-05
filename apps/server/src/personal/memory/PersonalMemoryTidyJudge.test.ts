import { ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { PersonalProviders } from "../engine/PersonalProviders.ts";
import { PersonalProvidersError } from "../engine/errors.ts";
import { PersonalMemoryTidyJudge, judgeLayer } from "./PersonalMemoryTidyService.ts";

interface Asked {
  readonly instanceId: string;
  readonly model: string;
  readonly options: unknown;
  readonly prompt: string;
}

const withJudge = <A, E>(
  port: {
    readonly generator?: "none" | "fails" | "answers";
    readonly lookupFails?: boolean;
  },
  body: (judge: PersonalMemoryTidyJudge["Service"], asked: Array<Asked>) => Effect.Effect<A, E>,
) => {
  const asked: Array<Asked> = [];
  const generate = (input: {
    readonly prompt: string;
    readonly modelSelection: {
      readonly instanceId: ProviderInstanceId;
      readonly model: string;
      readonly options?: ReadonlyArray<unknown>;
    };
  }) =>
    Effect.suspend(() => {
      asked.push({
        instanceId: input.modelSelection.instanceId,
        model: input.modelSelection.model,
        options: input.modelSelection.options,
        prompt: input.prompt,
      });
      return port.generator === "fails"
        ? Effect.fail(
            new TextGenerationError({
              operation: "generateStructured",
              detail: "usage limit reached",
            }),
          )
        : Effect.succeed({ changes: [] });
    });
  const providers = Layer.mock(PersonalProviders)({
    structuredGenerator: () =>
      port.lookupFails === true
        ? Effect.fail(
            new PersonalProvidersError({
              operation: "structuredGenerator",
              detail: "registry down",
            }),
          )
        : Effect.succeed(
            port.generator === "none" ? Option.none() : Option.some(generate as never),
          ),
  });
  return Effect.gen(function* () {
    const judge = yield* PersonalMemoryTidyJudge;
    return yield* body(judge, asked);
  }).pipe(Effect.provide(judgeLayer.pipe(Layer.provide(providers))));
};

describe("PersonalMemoryTidy judge over PersonalProviders", () => {
  it.effect("asks the Claude agent instance through the port", () =>
    withJudge({ generator: "answers" }, (judge, asked) =>
      Effect.gen(function* () {
        yield* judge.judge("tidy these").pipe(Effect.ignore);
        expect(asked).toHaveLength(1);
        expect(asked[0]!.instanceId).toBe("claudeAgent");
        expect(asked[0]!.model).toBe(judge.model);
        expect(asked[0]!.prompt).toBe("tidy these");
      }),
    ),
  );

  it.effect("says the provider is unavailable when the port has no generator", () =>
    withJudge({ generator: "none" }, (judge) =>
      Effect.gen(function* () {
        const reason = yield* judge.judge("p").pipe(Effect.flip);
        expect(reason).toBe("The Claude provider is not available.");
      }),
    ),
  );

  it.effect("reports a generation failure by its message", () =>
    withJudge({ generator: "fails" }, (judge) =>
      Effect.gen(function* () {
        const reason = yield* judge.judge("p").pipe(Effect.flip);
        expect(reason).toContain("usage limit reached");
      }),
    ),
  );

  it.effect("reports a port lookup failure by its message", () =>
    withJudge({ lookupFails: true }, (judge) =>
      Effect.gen(function* () {
        const reason = yield* judge.judge("p").pipe(Effect.flip);
        expect(reason).toContain("registry down");
      }),
    ),
  );
});
