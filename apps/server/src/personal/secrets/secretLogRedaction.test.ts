import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";

import { redactSecretsInLogs } from "./secretLogRedaction.ts";
import { makeSecretRedactor } from "./secretRedaction.ts";

const KEY = "sk-live-AbCdEf0123456789xyzQ";

/** Everything the wrapped logger was asked to write, as one string per call. */
const captured = (redactor: ReturnType<typeof makeSecretRedactor>) => {
  const lines: Array<string> = [];
  const base = Logger.make<unknown, void>((options) => {
    lines.push(
      JSON.stringify({
        message: Array.isArray(options.message)
          ? options.message.map((part) =>
              part instanceof Error ? `${part.message}\n${part.stack}` : part,
            )
          : options.message,
        cause: options.cause.reasons.length === 0 ? null : Cause.pretty(options.cause),
      }),
    );
  });
  const layer = Logger.layer([redactSecretsInLogs(base, redactor)], { mergeWithExisting: false });
  return { lines, layer };
};

describe("redactSecretsInLogs", () => {
  it.effect("masks a saved key in the message parts, an error and a failure", () =>
    Effect.gen(function* () {
      const redactor = makeSecretRedactor();
      redactor.set("VERCEL_TOKEN", KEY);
      const { lines, layer } = captured(redactor);
      yield* Effect.gen(function* () {
        yield* Effect.logInfo(`token ${KEY}`, { nested: { value: KEY } });
        yield* Effect.logError("tool failed", new Error(`bad key ${KEY}`));
        yield* Effect.logWarning("failing", Cause.fail(`denied for ${KEY}`));
      }).pipe(Effect.provide(layer));
      assert.strictEqual(lines.length, 3);
      for (const line of lines) {
        assert.notInclude(line, KEY);
        assert.include(line, "[secret VERCEL_TOKEN]");
      }
    }),
  );

  it.effect("writes untouched lines when no key is known", () =>
    Effect.gen(function* () {
      const redactor = makeSecretRedactor();
      const { lines, layer } = captured(redactor);
      yield* Effect.logInfo(`token ${KEY}`).pipe(Effect.provide(layer));
      assert.include(lines[0]!, KEY);
    }),
  );

  it.effect("the kill switch turns it off", () =>
    Effect.gen(function* () {
      let on = true;
      const redactor = makeSecretRedactor({ enabled: () => on });
      redactor.set("VERCEL_TOKEN", KEY);
      on = false;
      const { lines, layer } = captured(redactor);
      yield* Effect.logInfo(`token ${KEY}`).pipe(Effect.provide(layer));
      assert.include(lines[0]!, KEY);
    }),
  );

  it("is usable as a layer", () => {
    assert.isTrue(Layer.isLayer(Logger.layer([redactSecretsInLogs(Logger.consolePretty())])));
  });
});
