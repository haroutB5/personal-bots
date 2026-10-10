import { expect, it } from "vite-plus/test";
import { normalizeJsonResult } from "./jsonResult.ts";
import * as Schema from "effect/Schema";

it("preserves supported JSON, shared objects and special property names", () => {
  const shared = { value: "same" };
  const input = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(
    '{"__proto__":1,"constructor":2}',
  );
  expect(
    normalizeJsonResult({ input, shared, again: shared, number: 3, text: "ok", bool: true }),
  ).toEqual({ input, shared, again: shared, number: 3, text: "ok", bool: true });
});
it("rejects values JSON would silently lose or replace", () => {
  for (const value of [NaN, Infinity, 1n, Symbol("x"), () => {}, new Map()]) {
    expect(() => normalizeJsonResult({ value })).toThrow(/unsupported JSON/);
  }
  const circular: { self?: unknown } = {};
  circular.self = circular;
  expect(() => normalizeJsonResult(circular)).toThrow(/circular JSON/);
});
