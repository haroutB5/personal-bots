import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { decodeJsonReply, fromRunner } from "./textGenerationOperations.ts";

// regression: #23726 a reply that echoes the schema key replaced the seed title with "title"
it.effect("fails a thread title reply that is only the schema key", () =>
  Effect.gen(function* () {
    const textGeneration = fromRunner("Stub", (request) =>
      decodeJsonReply(request, "Stub", '{"title":"title","needsRefinement":false}'),
    );

    const outcome = yield* textGeneration
      .generateThreadTitle({
        cwd: process.cwd(),
        message: "$implement Issue #140",
        modelSelection: {
          instanceId: ProviderInstanceId.make("pi"),
          model: "anthropic/claude-haiku-4-5",
        },
      })
      .pipe(Effect.match({ onFailure: (error) => error, onSuccess: (result) => result }));

    assert.instanceOf(outcome, TextGenerationError);
    assert.strictEqual(outcome.operation, "generateThreadTitle");
  }),
);

it.effect("exposes generateStructured on fromRunner with an absolute cwd", () =>
  Effect.gen(function* () {
    let seenCwd: string | null = null;
    const textGeneration = fromRunner("Stub", (request) => {
      seenCwd = request.cwd;
      return decodeJsonReply(request, "Stub", '{"reply":"ok"}');
    });

    assert.isDefined(textGeneration.generateStructured);
    const result = yield* textGeneration.generateStructured!({
      prompt: "Reply with ok.",
      outputSchema: Schema.Struct({ reply: Schema.String }),
      modelSelection: {
        instanceId: ProviderInstanceId.make("opencode"),
        model: "opencode/big-pickle",
      },
    });

    assert.deepStrictEqual(result, { reply: "ok" });
    assert.isTrue(seenCwd !== null && /^([A-Za-z]:[\\/]|\/)/.test(seenCwd));
  }),
);
