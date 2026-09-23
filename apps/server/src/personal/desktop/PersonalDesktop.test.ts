// @effect-diagnostics globalTimers:off - the fake driver is promise-based, like the real one.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Fiber from "effect/Fiber";

import type { DesktopDriver } from "./DesktopHelper.ts";
import { DesktopHelperError } from "./DesktopHelper.ts";
import {
  makeDesktopService,
  PersonalDesktopActionError,
  STOPPED_REASON,
} from "./PersonalDesktop.ts";

const ada = { threadId: "t-ada", botId: "b-ada", botName: "Ada" };
const bob = { threadId: "t-bob", botId: "b-bob", botName: "Bob" };

class FakeDriver implements DesktopDriver {
  readonly calls: Array<{ cmd: string; params: Readonly<Record<string, unknown>> }> = [];
  private killListener: (() => void) | null = null;
  /** When set, the next "click" hangs until the test aborts it. */
  hangNextClick = false;
  private hung: ((error: Error) => void) | null = null;

  request(cmd: string, params: Readonly<Record<string, unknown>> = {}) {
    this.calls.push({ cmd, params });
    if (cmd === "click" && this.hangNextClick) {
      this.hangNextClick = false;
      return new Promise<Record<string, unknown>>((_resolve, reject) => {
        this.hung = reject;
      });
    }
    return Promise.resolve({ ok: true });
  }

  onKill(listener: () => void) {
    this.killListener = listener;
  }

  /** The user presses the stop key: the helper aborts what it is doing, then reports it. */
  pressStopKey() {
    this.hung?.(new DesktopHelperError("aborted", "Stopped by the user."));
    this.hung = null;
    this.killListener?.();
  }

  overlays() {
    return this.calls.filter((call) => call.cmd === "overlay").map((call) => call.params.show);
  }

  dispose() {}
}

const failureOf = <A>(exit: Exit.Exit<A, PersonalDesktopActionError>) => {
  if (Exit.isSuccess(exit)) return null;
  const error = Cause.squash(exit.cause);
  return error instanceof PersonalDesktopActionError ? error : null;
};

const tick = () => Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));

describe("PersonalDesktop", () => {
  it.live("queues a second bot until the first releases, showing who waits", () =>
    Effect.gen(function* () {
      const driver = new FakeDriver();
      const { service } = yield* makeDesktopService({ driver });
      yield* service.act(ada, "click", (context) => context.driver.request("click"));
      expect((yield* service.status).holder?.botName).toBe("Ada");

      const waiting = yield* service
        .act(bob, "click", (context) => context.driver.request("click", { by: "bob" }))
        .pipe(Effect.forkChild);
      yield* tick();
      const queued = yield* service.status;
      expect(queued.holder?.botName).toBe("Ada");
      expect(queued.waiting.map((entry) => entry.botName)).toEqual(["Bob"]);
      expect(driver.calls.some((call) => call.params.by === "bob")).toBe(false);

      expect(yield* service.release(ada.threadId)).toBe(true);
      yield* Fiber.join(waiting);
      expect(driver.calls.some((call) => call.params.by === "bob")).toBe(true);
      const after = yield* service.status;
      expect(after.holder?.botName).toBe("Bob");
      expect(after.waiting).toEqual([]);
      // Shown for Ada, then re-shown for Bob.
      expect(driver.overlays()).toEqual([true, true]);
    }),
  );

  it.live("the stop key aborts the running action, frees the PC and turns waiters away", () =>
    Effect.gen(function* () {
      const driver = new FakeDriver();
      const { service } = yield* makeDesktopService({ driver });
      yield* service.act(ada, "screenshot", () => Promise.resolve("ok"));
      driver.hangNextClick = true;
      const running = yield* service
        .act(ada, "click", (context) => context.driver.request("click"))
        .pipe(Effect.exit, Effect.forkChild);
      const queued = yield* service
        .act(bob, "click", () => Promise.resolve("never"))
        .pipe(Effect.exit, Effect.forkChild);
      yield* tick();

      driver.pressStopKey();

      const runningExit = yield* Fiber.join(running);
      expect(failureOf(runningExit)?.kind).toBe("stopped");
      expect(failureOf(runningExit)?.reason).toBe(STOPPED_REASON);
      expect(failureOf(yield* Fiber.join(queued))?.kind).toBe("stopped");

      const status = yield* service.status;
      expect(status.holder).toBeNull();
      expect(status.waiting).toEqual([]);
      expect(status.lastStop).toMatchObject({ botName: "Ada", by: "hotkey" });
      expect(driver.overlays().at(-1)).toBe(false);

      // Stopped for the rest of this turn: a retry is refused, not re-granted.
      const retry = yield* service
        .act(ada, "click", () => Promise.resolve("again"))
        .pipe(Effect.exit);
      expect(failureOf(retry)?.kind).toBe("stopped");

      // Once the turn ends, the user's next message may use the PC again.
      yield* service.threadTurnEnded(ada.threadId);
      const later = yield* service.act(ada, "click", () => Promise.resolve("later"));
      expect(later).toBe("later");
    }),
  );

  it.live("the app's Stop button works like the key", () =>
    Effect.gen(function* () {
      const driver = new FakeDriver();
      const { service } = yield* makeDesktopService({ driver });
      yield* service.act(ada, "click", () => Promise.resolve(null));
      const status = yield* service.stop("app");
      expect(status.holder).toBeNull();
      expect(status.lastStop).toMatchObject({ botName: "Ada", by: "app" });
    }),
  );

  it.live("an idle holder loses the PC to the next bot in line", () =>
    Effect.gen(function* () {
      let clock = 0;
      const driver = new FakeDriver();
      const { service, sweep } = yield* makeDesktopService({
        driver,
        now: () => clock,
        idleTimeoutMs: 1_000,
      });
      yield* service.act(ada, "click", () => Promise.resolve(null));
      const waiting = yield* service
        .act(bob, "click", () => Promise.resolve("bob ran"))
        .pipe(Effect.forkChild);
      yield* tick();
      clock = 1_000;
      yield* sweep;
      expect(yield* Fiber.join(waiting)).toBe("bob ran");
      const status = yield* service.status;
      expect(status.holder?.botName).toBe("Bob");
      expect(status.lastStop).toMatchObject({ botName: "Ada", by: "idle" });
    }),
  );

  it.live("a turn that ends lets go of the PC", () =>
    Effect.gen(function* () {
      const driver = new FakeDriver();
      const { service } = yield* makeDesktopService({ driver });
      yield* service.act(ada, "click", () => Promise.resolve(null));
      yield* service.threadTurnEnded(ada.threadId);
      expect((yield* service.status).holder).toBeNull();
      expect(driver.overlays()).toEqual([true, false]);
    }),
  );

  it.live("a bot waiting too long is told who has the PC and leaves the line", () =>
    Effect.gen(function* () {
      const driver = new FakeDriver();
      const { service } = yield* makeDesktopService({ driver, queueWaitMs: 20 });
      yield* service.act(ada, "click", () => Promise.resolve(null));
      const exit = yield* service.act(bob, "click", () => Promise.resolve(null)).pipe(Effect.exit);
      expect(failureOf(exit)?.kind).toBe("busy");
      expect(failureOf(exit)?.reason).toContain("Ada is still using the PC");
      expect((yield* service.status).waiting).toEqual([]);
    }),
  );

  it.live("refuses cleanly where there is no desktop", () =>
    Effect.gen(function* () {
      const { service } = yield* makeDesktopService({ driver: null });
      const exit = yield* service.act(ada, "click", () => Promise.resolve(null)).pipe(Effect.exit);
      expect(failureOf(exit)?.kind).toBe("unavailable");
      expect((yield* service.status).available).toBe(false);
    }),
  );
});
