import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  PERSONAL_ROUTINE_EVENT_PAYLOAD_MAX_BYTES,
  PERSONAL_ROUTINE_HOOK_ROUTE_PREFIX,
  PersonalTaskId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/unstable/http";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  PersonalRoutineService,
  type PersonalRoutineFireEventInput,
  type PersonalRoutineFireEventResult,
} from "./PersonalRoutineService.ts";
import {
  personalRoutineHookMethodRouteLayer,
  personalRoutineHookRouteLayer,
} from "./hookRoutes.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const VALID_TOKEN = "a".repeat(43);

const fixture = (
  outcome: PersonalRoutineFireEventResult = {
    _tag: "Fired",
    taskId: PersonalTaskId.make("task-1"),
  },
) => {
  const calls: Array<PersonalRoutineFireEventInput> = [];
  const { handler, dispose } = HttpRouter.toWebHandler(
    Layer.mergeAll(personalRoutineHookRouteLayer, personalRoutineHookMethodRouteLayer).pipe(
      Layer.provideMerge(
        Layer.succeed(PersonalRoutineService, {
          fireEvent: (input: PersonalRoutineFireEventInput) =>
            Effect.sync(() => {
              calls.push(input);
              return outcome;
            }),
        } as unknown as PersonalRoutineService["Service"]),
      ),
      Layer.provideMerge(Layer.mergeAll(NodeHttpPlatform.layer, NodeServices.layer)),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return { handler, calls };
};

const hookUrl = (token: string) => `http://t3.test${PERSONAL_ROUTINE_HOOK_ROUTE_PREFIX}/${token}`;

const post = (token: string, init?: RequestInit) =>
  new Request(hookUrl(token), { method: "POST", ...init });

describe("personal routine webhook route", () => {
  it("fires the routine the token names and accepts the delivery", async () => {
    const { handler, calls } = fixture();
    const response = await handler(
      post(VALID_TOKEN, {
        body: '{"action":"closed"}',
        headers: { "content-type": "application/json" },
      }),
    );
    expect(response.status).toBe(202);
    expect(calls).toEqual([
      {
        hookToken: VALID_TOKEN,
        contentType: "application/json",
        body: '{"action":"closed"}',
      },
    ]);
  });

  it("answers an unknown token with a bare 404 that names nothing", async () => {
    const { handler } = fixture({ _tag: "NotFound" });
    const response = await handler(post("b".repeat(43), { body: "{}" }));
    expect(response.status).toBe(404);
    const text = await response.text();
    expect(text).toBe("Not Found");
    // No routine title, bot name or token echo anywhere in the response.
    expect(text).not.toContain("routine");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses an over-rate delivery with 429 and does not queue it", async () => {
    const { handler } = fixture({ _tag: "RateLimited", retryAfterSeconds: 17 });
    const response = await handler(post(VALID_TOKEN, { body: "{}" }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("17");
  });

  it("rejects a body over the cap without firing the routine", async () => {
    const { handler, calls } = fixture();
    const oversize = "x".repeat(PERSONAL_ROUTINE_EVENT_PAYLOAD_MAX_BYTES + 1);
    const declared = await handler(
      post(VALID_TOKEN, {
        body: oversize,
        headers: { "content-length": String(oversize.length) },
      }),
    );
    expect(declared.status).toBe(413);
    // ...and again when the sender lies about (or omits) the length.
    const streamed = await handler(post(VALID_TOKEN, { body: oversize }));
    expect(streamed.status).toBe(413);
    expect(calls).toEqual([]);
  });

  it("accepts a body exactly at the cap", async () => {
    const { handler, calls } = fixture();
    const atCap = "x".repeat(PERSONAL_ROUTINE_EVENT_PAYLOAD_MAX_BYTES);
    const response = await handler(post(VALID_TOKEN, { body: atCap }));
    expect(response.status).toBe(202);
    expect(calls[0]?.body.length).toBe(PERSONAL_ROUTINE_EVENT_PAYLOAD_MAX_BYTES);
  });

  it("answers GET with 405 and never reaches the service", async () => {
    const { handler, calls } = fixture();
    const response = await handler(new Request(hookUrl(VALID_TOKEN)));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(calls).toEqual([]);
  });
});
