// @effect-diagnostics globalTimers:off - the fake driver is promise-based, like the real one.
import { describe, expect, it } from "@effect/vitest";
import type { PersonalDesktopActivityEvent, PersonalDesktopStreamItem } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { DesktopHelperError, type DesktopDriver } from "./DesktopHelper.ts";
import { makeDesktopService } from "./PersonalDesktop.ts";

const ada = { threadId: "t-ada", botId: "b-ada", botName: "Ada" };

class FakeDriver implements DesktopDriver {
  readonly calls: string[] = [];
  request(cmd: string) {
    this.calls.push(cmd);
    return Promise.resolve({ ok: true });
  }
  onKill() {}
  dispose() {}
}

const nextEvent = (service: { readonly activity: Stream.Stream<PersonalDesktopStreamItem> }) =>
  Effect.gen(function* () {
    const head = yield* service.activity.pipe(
      Stream.dropWhile((item) => item._tag === "Recent"),
      Stream.take(1),
      Stream.runHead,
    );
    return Option.isSome(head) && head.value._tag === "Activity" ? head.value.event : null;
  });

describe("desktop activity", () => {
  it.live("records an action's kind, summary and click fractions", () =>
    Effect.gen(function* () {
      const driver = new FakeDriver();
      const { service } = yield* makeDesktopService({ driver });
      yield* service.act(ada, "click", () =>
        Promise.resolve({
          activity: { summary: "clicked at 42%, 61%", x: 0.42, y: 0.61, monitor: 0 },
        }),
      );
      const head = yield* service.activity.pipe(Stream.take(1), Stream.runHead);
      expect(Option.isSome(head)).toBe(true);
      if (Option.isNone(head) || head.value._tag !== "Recent") return;
      const event = head.value.events.at(-1) as PersonalDesktopActivityEvent;
      expect(event).toMatchObject({
        kind: "click",
        summary: "clicked at 42%, 61%",
        status: "succeeded",
        source: "desktop",
        threadId: ada.threadId,
        botId: ada.botId,
        botName: ada.botName,
        x: 0.42,
        y: 0.61,
        monitor: 0,
      });
    }),
  );

  it.live("emits a live event for each later action, and never the typed text", () =>
    Effect.gen(function* () {
      const driver = new FakeDriver();
      const { service } = yield* makeDesktopService({ driver });
      const pending = yield* nextEvent(service).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* service.act(ada, "type", () =>
        Promise.resolve({ activity: { summary: "typed 24 characters", chars: 24 } }),
      );
      const event = yield* Fiber.join(pending);
      expect(event).toMatchObject({ kind: "type", chars: 24 });
      expect(event?.summary).toBe("typed 24 characters");
    }),
  );

  it.live("records a refused action as failed, with no coordinates", () =>
    Effect.gen(function* () {
      const driver = new FakeDriver();
      const { service } = yield* makeDesktopService({ driver });
      yield* service
        .act(ada, "click", () => Promise.reject(new Error("outside the picture")))
        .pipe(Effect.exit);
      const head = yield* service.activity.pipe(Stream.take(1), Stream.runHead);
      if (Option.isNone(head) || head.value._tag !== "Recent") return;
      const event = head.value.events.at(-1) as PersonalDesktopActivityEvent;
      expect(event.status).toBe("failed");
      expect(event.kind).toBe("click");
      expect(event.x).toBeUndefined();
    }),
  );

  it.live("records a take-back as refused, and says which kind", () =>
    Effect.gen(function* () {
      const driver = new FakeDriver();
      const { service } = yield* makeDesktopService({ driver });
      yield* service
        .act(ada, "click", () =>
          Promise.reject(new DesktopHelperError("user_active", "The screensaver is up")),
        )
        .pipe(Effect.exit);
      const head = yield* service.activity.pipe(Stream.take(1), Stream.runHead);
      if (Option.isNone(head) || head.value._tag !== "Recent") return;
      const event = head.value.events.at(-1) as PersonalDesktopActivityEvent;
      // The PC said no: the feed reads "refused", not "failed" (QA's L3), and
      // the reason appears once (QA's L5).
      expect(event).toMatchObject({
        kind: "click",
        summary: "click (user active)",
        status: "failed",
        outcome: "refused",
      });
    }),
  );

  it.live("names a point refusal as the window under the pointer, not the user", () =>
    Effect.gen(function* () {
      const driver = new FakeDriver();
      const { service } = yield* makeDesktopService({ driver });
      yield* service
        .act(ada, "click", () =>
          Promise.reject(
            new DesktopHelperError("point_blocked", "A browser window is under that point"),
          ),
        )
        .pipe(Effect.exit);
      const head = yield* service.activity.pipe(Stream.take(1), Stream.runHead);
      if (Option.isNone(head) || head.value._tag !== "Recent") return;
      const event = head.value.events.at(-1) as PersonalDesktopActivityEvent;
      expect(event).toMatchObject({
        kind: "click",
        summary: "click (window under the pointer)",
        status: "failed",
        outcome: "refused",
      });
    }),
  );

  it.live("records the user's Stop against the bot that held the PC", () =>
    Effect.gen(function* () {
      const driver = new FakeDriver();
      const { service } = yield* makeDesktopService({ driver });
      yield* service.act(ada, "screenshot", () => Promise.resolve("ok"));
      yield* service.stop("app");
      const head = yield* service.activity.pipe(Stream.take(1), Stream.runHead);
      if (Option.isNone(head) || head.value._tag !== "Recent") return;
      const event = head.value.events.at(-1) as PersonalDesktopActivityEvent;
      expect(event).toMatchObject({
        kind: "stop",
        summary: "stopped from the app",
        status: "succeeded",
        botName: "Ada",
      });
    }),
  );
});
