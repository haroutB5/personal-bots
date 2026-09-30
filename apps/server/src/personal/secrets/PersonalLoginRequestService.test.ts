import { PersonalBotId, PersonalTaskId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as Schema from "effect/Schema";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../../persistence/Migrations.ts";
import * as PersonalBrowser from "../browser/PersonalBrowser.ts";
import * as PersonalTaskService from "../tasks/PersonalTaskService.ts";
import * as PersonalLoginService from "./PersonalLoginService.ts";
import * as LoginRequests from "./PersonalLoginRequestService.ts";
import { HostOperationError } from "../browser/pageOperations.ts";

const input = {
  taskId: PersonalTaskId.make("task"),
  threadId: ThreadId.make("thread"),
  botId: PersonalBotId.make("bot"),
  origin: "https://example.com",
  reason: "Sign in to continue",
};
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const fixture = () => {
  const state = {
    page: { tabId: "tab", origin: input.origin } as { tabId: string; origin: string } | null,
    saved: [] as unknown[],
    fills: [] as unknown[],
    notes: [] as string[],
    existing: false,
    failFill: false,
  };
  const layer = LoginRequests.layerLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(PersonalBrowser.PersonalBrowser)({
          loginPage: () => Effect.sync(() => state.page),
          fillLogin: (value) =>
            state.failFill
              ? Effect.fail(
                  new HostOperationError(
                    "PreviewAutomationExecutionError",
                    "fixture-user fixture-password",
                  ),
                )
              : Effect.sync(() => {
                  state.fills.push(value);
                  return ["username", "password"] as const;
                }),
        }),
        Layer.mock(PersonalLoginService.PersonalLoginService)({
          list: () =>
            Effect.succeed({ logins: state.existing ? ([{ origin: input.origin }] as never) : [] }),
          create: (value) =>
            Effect.sync(() => {
              state.saved.push(value);
              return {} as never;
            }),
        }),
        Layer.mock(PersonalTaskService.PersonalTaskService)({
          waitForUser: () => Effect.succeed({} as never),
          resumeFromUser: (value) =>
            Effect.sync(() => {
              state.notes.push(value.note);
              return {} as never;
            }),
        }),
      ),
    ),
    Layer.provide(
      Layer.effectDiscard(runMigrations()).pipe(
        Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
      ),
    ),
  );
  return { state, layer };
};
const credentials = (requestId: string, save?: boolean) => ({
  requestId,
  username: Redacted.make("fixture-user"),
  password: Redacted.make("fixture-password"),
  ...(save === undefined ? {} : { save }),
});

describe("secure in-chat login requests", () => {
  it.effect("closes a failed fill without forwarding a driver's credential-bearing error", () => {
    const { state, layer } = fixture();
    return Effect.gen(function* () {
      const service = yield* LoginRequests.PersonalLoginRequestService;
      const request = yield* service.request(input);
      state.failFill = true;
      const result = yield* service.submit(credentials(request.requestId));
      expect(result.status).toBe("fill-failed");
      expect(result.saved).toBe(false);
      expect(state.saved).toHaveLength(0);
      expect(yield* encodeJson([result, state.notes])).not.toMatch(/fixture-user|fixture-password/);
      yield* service.submit(credentials(request.requestId)).pipe(Effect.flip);
    }).pipe(Effect.provide(layer));
  });
  it.effect("serializes simultaneous submissions so only one can fill and save", () => {
    const { state, layer } = fixture();
    return Effect.gen(function* () {
      const service = yield* LoginRequests.PersonalLoginRequestService;
      const request = yield* service.request(input);
      const results = yield* Effect.all(
        [
          service.submit(credentials(request.requestId)).pipe(Effect.result),
          service.submit(credentials(request.requestId)).pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
      expect(state.fills).toHaveLength(1);
      expect(state.saved).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });
  it.effect("refuses a different origin and an existing saved login before making a card", () => {
    const { state, layer } = fixture();
    return Effect.gen(function* () {
      const service = yield* LoginRequests.PersonalLoginRequestService;
      state.page = { tabId: "tab", origin: "https://attacker.example" };
      expect(yield* service.request(input).pipe(Effect.flip)).toMatchObject({
        message: expect.stringContaining("origin"),
      });
      state.page = { tabId: "tab", origin: input.origin };
      state.existing = true;
      expect(yield* service.request(input).pipe(Effect.flip)).toMatchObject({
        message: expect.stringContaining("use_login"),
      });
      expect((yield* service.list({ threadId: input.threadId })).requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });
  it.effect("saves by default, returns only metadata and refuses replay", () => {
    const { state, layer } = fixture();
    return Effect.gen(function* () {
      const service = yield* LoginRequests.PersonalLoginRequestService;
      const request = yield* service.request(input);
      const result = yield* service.submit(credentials(request.requestId));
      expect(result.status).toBe("filled");
      expect(result.saved).toBe(true);
      expect(state.saved).toHaveLength(1);
      expect(state.fills).toHaveLength(1);
      expect(yield* encodeJson([result, state.notes])).not.toMatch(/fixture-user|fixture-password/);
      yield* service.submit(credentials(request.requestId)).pipe(Effect.flip);
      expect(state.fills).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });
  it.effect("does not save when disabled and cancel resumes only with cancelled", () => {
    const { state, layer } = fixture();
    return Effect.gen(function* () {
      const service = yield* LoginRequests.PersonalLoginRequestService;
      const request = yield* service.request(input);
      expect((yield* service.submit(credentials(request.requestId, false))).saved).toBe(false);
      expect(state.saved).toHaveLength(0);
      const next = yield* service.request(input);
      expect((yield* service.cancel({ requestId: next.requestId })).status).toBe("cancelled");
      expect(state.notes.at(-1)).toContain("cancelled");
      yield* service.submit(credentials(next.requestId)).pipe(Effect.flip);
      expect(state.fills).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });
  it.effect("expires after ten minutes and invalidates navigation, including away and back", () => {
    const { state, layer } = fixture();
    return Effect.gen(function* () {
      const service = yield* LoginRequests.PersonalLoginRequestService;
      const request = yield* service.request(input);
      yield* TestClock.adjust("11 minutes");
      yield* service.submit(credentials(request.requestId)).pipe(Effect.flip);
      expect((yield* service.list({ threadId: input.threadId })).requests[0]?.status).toBe(
        "expired",
      );
      const next = yield* service.request(input);
      state.page = { tabId: "other", origin: input.origin };
      expect((yield* service.submit(credentials(next.requestId))).status).toBe("origin-mismatch");
      expect(state.fills).toHaveLength(0);
      expect(state.saved).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });
});
