import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { McpServer } from "effect/unstable/ai";

import { makeSecretRedactor } from "../personal/secrets/secretRedaction.ts";
import { guardMcpServer } from "./McpSecretGuard.ts";

const KEY = "sk-live-AbCdEf0123456789xyzQ";
const encodeJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

type Handler = (payload: unknown) => Effect.Effect<unknown>;

/** A server whose registered handlers can be called with any payload. */
const fakeServer = () => {
  const handlers = new Map<string, Handler>();
  const server = {
    tools: [],
    addTool: (options: { readonly tool: { readonly name: string }; readonly handle: Handler }) => {
      handlers.set(options.tool.name, options.handle);
      return Effect.void;
    },
  } as unknown as McpServer.McpServer["Service"];
  return { server, handlers };
};

const register = (guarded: McpServer.McpServer["Service"], name: string, seen: Array<unknown>) =>
  guarded.addTool({
    tool: { name } as never,
    annotations: undefined as never,
    handle: (payload) => {
      seen.push(payload);
      return Effect.succeed({} as never);
    },
  });

describe("guardMcpServer", () => {
  it.effect("hands every tool a payload with saved key values masked, in any field", () =>
    Effect.gen(function* () {
      const redactor = makeSecretRedactor();
      redactor.set("VERCEL_TOKEN", KEY);
      const { server, handlers } = fakeServer();
      const seen: Array<unknown> = [];
      yield* register(guardMcpServer(server, redactor), "notify_user", seen);
      yield* handlers.get("notify_user")!({
        title: `Deploy with ${KEY}`,
        body: { nested: [`Authorization: Bearer ${KEY}`, 3, true, null] },
        brief: `use {{secret:VERCEL_TOKEN}} for ${encodeURIComponent(KEY)}`,
        count: 2,
      });
      const text = encodeJsonText(seen[0]);
      expect(text).not.toContain(KEY);
      expect(text).toContain("[secret VERCEL_TOKEN]");
      // A placeholder is a name, not a value: it passes through.
      expect(text).toContain("{{secret:VERCEL_TOKEN}}");
      expect((seen[0] as { count: number }).count).toBe(2);
    }),
  );

  it.effect("passes the payload through untouched when nothing is saved", () =>
    Effect.gen(function* () {
      const { server, handlers } = fakeServer();
      const seen: Array<unknown> = [];
      yield* register(guardMcpServer(server, makeSecretRedactor()), "t", seen);
      const payload = { text: "plain" };
      yield* handlers.get("t")!(payload);
      expect(seen[0]).toBe(payload);
    }),
  );

  it("keeps the rest of the server (its tool list) as it was", () => {
    const { server } = fakeServer();
    const guarded = guardMcpServer(server, makeSecretRedactor());
    expect(guarded.tools).toBe(server.tools);
  });
});
