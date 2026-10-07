import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import type { TraceRecord, TraceSink } from "@t3tools/shared/observability";

import {
  redactSecretsInLogs,
  redactSecretsInTraceSink,
  redactSecretsInTracer,
} from "./secretLogRedaction.ts";
import { makeSecretRedactor } from "./secretRedaction.ts";

const KEY = "sk-live-AbCdEf0123456789xyzQ";

const json = (value: unknown) =>
  JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === "bigint" ? String(entry) : entry,
  );

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

describe("redactSecretsInLogs on the tracer logger", () => {
  it.effect("keeps a key out of the span events server.trace.ndjson is written from", () =>
    Effect.gen(function* () {
      const redactor = makeSecretRedactor();
      redactor.set("VERCEL_TOKEN", KEY);
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const layer = Logger.layer([redactSecretsInLogs(Logger.tracerLogger, redactor)], {
        mergeWithExisting: false,
      });
      yield* Effect.logInfo(`calling with ${KEY}`).pipe(
        Effect.withSpan("work"),
        Effect.provide(layer),
        Effect.provideService(Tracer.Tracer, tracer),
      );
      const events = json(spans.flatMap((span) => span.events));
      assert.include(events, "calling with");
      assert.notInclude(events, KEY);
      assert.include(events, "[secret VERCEL_TOKEN]");
    }),
  );
});

describe("redactSecretsInTraceSink", () => {
  it("masks a key in every record before it is queued", () => {
    const redactor = makeSecretRedactor();
    redactor.set("VERCEL_TOKEN", KEY);
    const pushed: Array<TraceRecord> = [];
    const sink = {
      filePath: "x",
      push: (record: TraceRecord) => pushed.push(record),
    } as unknown as TraceSink;
    const guarded = redactSecretsInTraceSink(sink, redactor);
    guarded.push({
      type: "effect-span",
      name: "tool",
      attributes: { settings: `token ${KEY}` },
      events: [{ name: "log", attributes: { message: `bad ${KEY}` } }],
      exit: { _tag: "Failure", cause: `Error: denied for ${KEY}` },
    } as unknown as TraceRecord);
    const text = JSON.stringify(pushed);
    assert.notInclude(text, KEY);
    assert.include(text, "[secret VERCEL_TOKEN]");
    assert.strictEqual(guarded.filePath, "x");
  });
});

describe("redactSecretsInTracer", () => {
  it("masks a key in attributes, event attributes and a failing end before the exporter gets them", () => {
    const redactor = makeSecretRedactor();
    redactor.set("VERCEL_TOKEN", KEY);
    const spans: Array<Tracer.NativeSpan> = [];
    const inner = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const guarded = redactSecretsInTracer(inner, redactor);
    const span = guarded.span({
      name: "exported",
      parent: Option.none(),
      annotations: new Map() as never,
      links: [],
      startTime: 0n,
      kind: "internal",
      root: true,
      sampled: true,
    } as never);
    span.attribute("auth", `Bearer ${KEY}`);
    span.attribute("count", 3);
    span.event("log", 1n, { message: `key ${KEY}` });
    span.end(2n, Exit.fail(`rejected ${KEY}`));
    const native = spans[0]!;
    assert.notInclude(JSON.stringify([...native.attributes]), KEY);
    assert.strictEqual(native.attributes.get("count"), 3);
    assert.notInclude(json(native.events), KEY);
    assert.strictEqual(native.status._tag, "Ended");
    const ended = native.status as { readonly exit: Exit.Exit<unknown, unknown> };
    assert.isTrue(Exit.isFailure(ended.exit));
    assert.notInclude(Exit.isFailure(ended.exit) ? Cause.pretty(ended.exit.cause) : "", KEY);
    assert.include(
      Exit.isFailure(ended.exit) ? Cause.pretty(ended.exit.cause) : "",
      "[secret VERCEL_TOKEN]",
    );
    // The wrapper hands back the span's own identity fields.
    assert.strictEqual(span.name, "exported");
    assert.strictEqual(span.spanId, native.spanId);
  });
});
