// @effect-diagnostics globalTimers:off - the fake driver is promise-based, like the real one.
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";

import type { DesktopDriver } from "./DesktopHelper.ts";
import { DesktopHelperError } from "./DesktopHelper.ts";
import {
  makeDesktopService,
  PersonalDesktopActionError,
  REMOTE_CONTROL_END_DETAIL,
  REMOTE_LOCKED_DETAIL,
  REMOTE_OVERLAY_TEXT,
  type RemoteControlEnd,
  TAKEN_OVER_REASON,
} from "./PersonalDesktop.ts";

const ada = { threadId: "t-ada", botId: "b-ada", botName: "Ada" };
const bob = { threadId: "t-bob", botId: "b-bob", botName: "Bob" };
const frame = { frameWidth: 1536, frameHeight: 960 };

class FakeDriver implements DesktopDriver {
  readonly calls: Array<{ cmd: string; params: Readonly<Record<string, unknown>> }> = [];
  locked = false;
  /** Refuse the next input as the helper does on a locked PC. */
  lockOnNextInput = false;
  hangNextClick = false;
  private killListener: (() => void) | null = null;
  private hung: ((error: Error) => void) | null = null;

  request(cmd: string, params: Readonly<Record<string, unknown>> = {}) {
    this.calls.push({ cmd, params });
    if (cmd === "info") {
      return Promise.resolve({
        locked: this.locked,
        monitors: [{ index: 0, primary: true, x: 0, y: 0, width: 3072, height: 1920, dpi: 192 }],
      });
    }
    if (cmd === "abort") {
      this.hung?.(new DesktopHelperError("aborted", "Stopped by the user."));
      this.hung = null;
      return Promise.resolve({});
    }
    if (params.remote === true && this.lockOnNextInput) {
      this.lockOnNextInput = false;
      return Promise.reject(
        new DesktopHelperError(
          "locked",
          "The PC is locked, or a secure Windows prompt is showing.",
        ),
      );
    }
    if (cmd === "click" && this.hangNextClick) {
      this.hangNextClick = false;
      return new Promise<Record<string, unknown>>((_resolve, reject) => {
        this.hung = reject;
      });
    }
    return Promise.resolve({});
  }

  onKill(listener: () => void) {
    this.killListener = listener;
  }

  pressStopKey() {
    this.hung?.(new DesktopHelperError("aborted", "Stopped by the user."));
    this.hung = null;
    this.killListener?.();
  }

  overlayTexts() {
    return this.calls
      .filter((call) => call.cmd === "overlay")
      .map((call) => (call.params.show === true ? String(call.params.text) : null));
  }

  remoteCalls() {
    return this.calls.filter((call) => call.params.remote === true);
  }

  dispose() {}
}

const failureOf = <A>(exit: Exit.Exit<A, PersonalDesktopActionError>) => {
  if (Exit.isSuccess(exit)) return null;
  const error = Cause.squash(exit.cause);
  return error instanceof PersonalDesktopActionError ? error : null;
};

const tick = () => Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));

const recorder = () => {
  const ended: Array<{ reason: RemoteControlEnd; detail: string | undefined }> = [];
  return {
    ended,
    options: {
      onEnded: (reason: RemoteControlEnd, detail: string | undefined) =>
        ended.push({ reason, detail }),
    },
  };
};

describe("PersonalDesktop remote control", () => {
  it.live(
    "takes the PC from a bot mid-action: the bot is stopped and told the user took over",
    () =>
      Effect.gen(function* () {
        const driver = new FakeDriver();
        const lines: string[] = [];
        const { service } = yield* makeDesktopService({ driver, log: (line) => lines.push(line) });
        yield* service.act(ada, "screenshot", () => Promise.resolve("ok"));
        driver.hangNextClick = true;
        const running = yield* service
          .act(ada, "click", (context) => context.driver.request("click"))
          .pipe(Effect.exit, Effect.forkChild);
        yield* tick();

        const { options } = recorder();
        const session = yield* service.takeControl(options);

        // The bot's running action was aborted inside the helper.
        expect(driver.calls.some((call) => call.cmd === "abort")).toBe(true);
        const runningExit = yield* Fiber.join(running);
        expect(failureOf(runningExit)?.kind).toBe("stopped");
        expect(failureOf(runningExit)?.reason).toBe(TAKEN_OVER_REASON);
        // Refused for the rest of its turn, with the same sentence.
        const retry = yield* service
          .act(ada, "click", () => Promise.resolve(null))
          .pipe(Effect.exit);
        expect(failureOf(retry)?.reason).toBe(TAKEN_OVER_REASON);

        const status = yield* service.status;
        expect(status.holder).toMatchObject({ botName: "You", kind: "user" });
        expect(status.lastStop).toMatchObject({ botName: "Ada", by: "app" });
        expect(driver.overlayTexts().at(-1)).toBe(REMOTE_OVERLAY_TEXT);
        expect(session.active()).toBe(true);
        expect(lines).toEqual([
          "desktop remote control: started (took the PC from Ada), 0 waiting",
        ]);
      }),
  );

  it.live("bots in line keep waiting behind the user and get the PC when control ends", () =>
    Effect.gen(function* () {
      const driver = new FakeDriver();
      const { service } = yield* makeDesktopService({ driver });
      yield* service.act(ada, "click", () => Promise.resolve(null));
      const bobWaits = yield* service
        .act(bob, "click", () => Promise.resolve("bob ran"))
        .pipe(Effect.forkChild);
      yield* tick();

      const { options, ended } = recorder();
      const session = yield* service.takeControl(options);
      yield* tick();
      let status = yield* service.status;
      expect(status.holder?.kind).toBe("user");
      expect(status.waiting.map((entry) => entry.botName)).toEqual(["Bob"]);

      // A bot that turns up now queues too.
      const adaAgain = { ...ada, threadId: "t-ada-2" };
      const adaWaits = yield* service
        .act(adaAgain, "click", () => Promise.resolve("ada ran"))
        .pipe(Effect.forkChild);
      yield* tick();
      expect((yield* service.status).waiting.map((entry) => entry.botName)).toEqual(["Bob", "Ada"]);

      session.end("released");
      expect(yield* Fiber.join(bobWaits)).toBe("bob ran");
      status = yield* service.status;
      expect(status.holder?.botName).toBe("Bob");
      expect(ended).toEqual([]);
      expect(session.active()).toBe(false);
      expect(driver.overlayTexts().at(-1)).toContain("Bob is using your PC");
      yield* service.release(bob.threadId);
      expect(yield* Fiber.join(adaWaits)).toBe("ada ran");
    }),
  );

  it.live("a bot kept waiting hears that the user is controlling the PC", () =>
    Effect.gen(function* () {
      const driver = new FakeDriver();
      const { service } = yield* makeDesktopService({ driver, queueWaitMs: 20 });
      yield* service.takeControl(recorder().options);
      const exit = yield* service.act(bob, "click", () => Promise.resolve(null)).pipe(Effect.exit);
      expect(failureOf(exit)?.kind).toBe("busy");
      expect(failureOf(exit)?.reason).toContain(
        "The user is controlling the PC remotely right now. Nothing was done.",
      );
      expect(failureOf(exit)?.reason).toContain("number 1 in line");
    }),
  );

  it.live(
    "sends the owner's input as remote, mapped to physical pixels, one at a time in order",
    () =>
      Effect.gen(function* () {
        const driver = new FakeDriver();
        const lines: string[] = [];
        const { service } = yield* makeDesktopService({ driver, log: (line) => lines.push(line) });
        const session = yield* service.takeControl(recorder().options);
        yield* Effect.promise(() =>
          Promise.all([
            session.input({ _tag: "Pointer", action: "click", x: 768, y: 480, ...frame }),
            session.input({ _tag: "Text", text: "secret words" }),
            session.input({ _tag: "Keys", keys: "enter" }),
          ]),
        );
        expect(driver.remoteCalls().map((call) => call.cmd)).toEqual(["click", "type", "keys"]);
        expect(driver.remoteCalls()[0]?.params).toMatchObject({ x: 1537, y: 961, button: "left" });
        session.end("released");
        // One line per session, and never what was typed.
        expect(lines).toHaveLength(2);
        expect(lines[1]).toMatch(
          /^desktop remote control: ended \(released\) after [\d.]+ s, 3 inputs$/,
        );
        expect(lines.join("\n")).not.toContain("secret");
      }),
  );

  it.live("refuses a point outside the frame and an unknown key, doing nothing", () =>
    Effect.gen(function* () {
      const driver = new FakeDriver();
      const { service } = yield* makeDesktopService({ driver });
      const session = yield* service.takeControl(recorder().options);
      const outside = yield* Effect.promise(() =>
        session.input({ _tag: "Pointer", action: "click", x: 1536, y: 10, ...frame }).then(
          () => null,
          (error: unknown) => error,
        ),
      );
      expect(outside).toBeInstanceOf(PersonalDesktopActionError);
      expect((outside as PersonalDesktopActionError).reason).toBe(
        "That point is outside the picture of your PC.",
      );
      const badKey = yield* Effect.promise(() =>
        session.input({ _tag: "Keys", keys: "hyper+x" }).then(
          () => null,
          (error: unknown) => error,
        ),
      );
      expect((badKey as PersonalDesktopActionError).kind).toBe("invalid");
      expect(driver.remoteCalls()).toEqual([]);
      expect(session.active()).toBe(true);
    }),
  );

  it.live("refuses to take a locked PC, saying it can't be unlocked remotely", () =>
    Effect.gen(function* () {
      const driver = new FakeDriver();
      driver.locked = true;
      const { service } = yield* makeDesktopService({ driver });
      yield* service.act(ada, "screenshot", () => Promise.resolve(null));
      const exit = yield* service.takeControl(recorder().options).pipe(Effect.exit);
      expect(failureOf(exit)).toMatchObject({ kind: "locked", reason: REMOTE_LOCKED_DETAIL });
      // Nobody was stopped for nothing.
      expect((yield* service.status).holder?.botName).toBe("Ada");
    }),
  );

  it.live("a PC that locks mid-session refuses the input and ends control", () =>
    Effect.gen(function* () {
      const driver = new FakeDriver();
      const { service } = yield* makeDesktopService({ driver });
      const { options, ended } = recorder();
      const session = yield* service.takeControl(options);
      driver.lockOnNextInput = true;
      const error = yield* Effect.promise(() =>
        session.input({ _tag: "Text", text: "hi" }).then(
          () => null,
          (failure: unknown) => failure,
        ),
      );
      expect((error as PersonalDesktopActionError).reason).toBe(REMOTE_LOCKED_DETAIL);
      expect(ended).toEqual([{ reason: "locked", detail: REMOTE_LOCKED_DETAIL }]);
      expect(session.active()).toBe(false);
      expect((yield* service.status).holder).toBeNull();
    }),
  );

  it.live("ends after the idle timeout without input and hands the PC to the next bot", () =>
    Effect.gen(function* () {
      let clock = 0;
      const driver = new FakeDriver();
      const { service, sweep } = yield* makeDesktopService({
        driver,
        now: () => clock,
        idleTimeoutMs: 1_000,
      });
      const { options, ended } = recorder();
      const session = yield* service.takeControl(options);
      const bobWaits = yield* service
        .act(bob, "click", () => Promise.resolve("bob ran"))
        .pipe(Effect.forkChild);
      yield* tick();
      clock = 900;
      yield* Effect.promise(() =>
        session.input({ _tag: "Pointer", action: "move", x: 1, y: 1, ...frame }),
      );
      clock = 1_500;
      yield* sweep;
      expect(session.active()).toBe(true);
      clock = 1_900;
      yield* sweep;
      expect(ended).toEqual([{ reason: "idle", detail: REMOTE_CONTROL_END_DETAIL.idle }]);
      expect(yield* Fiber.join(bobWaits)).toBe("bob ran");
      // The owner going idle is not a bot being stopped.
      expect((yield* service.status).lastStop).toBeNull();
    }),
  );

  it.live("Esc pressed at the PC ends remote control and turns the line away", () =>
    Effect.gen(function* () {
      const driver = new FakeDriver();
      const { service } = yield* makeDesktopService({ driver });
      const { options, ended } = recorder();
      const session = yield* service.takeControl(options);
      const bobWaits = yield* service
        .act(bob, "click", () => Promise.resolve(null))
        .pipe(Effect.exit, Effect.forkChild);
      yield* tick();
      driver.pressStopKey();
      expect(ended).toEqual([{ reason: "esc", detail: REMOTE_CONTROL_END_DETAIL.esc }]);
      expect(failureOf(yield* Fiber.join(bobWaits))?.kind).toBe("stopped");
      expect(session.active()).toBe(false);
      const status = yield* service.status;
      expect(status.holder).toBeNull();
      expect(driver.overlayTexts().at(-1)).toBeNull();
    }),
  );

  it.live("a second device takes over: the first hears so, and no bot slips in between", () =>
    Effect.gen(function* () {
      const driver = new FakeDriver();
      const { service } = yield* makeDesktopService({ driver });
      const phone = recorder();
      const first = yield* service.takeControl(phone.options);
      const bobWaits = yield* service
        .act(bob, "click", () => Promise.resolve(null))
        .pipe(Effect.forkChild);
      yield* tick();
      const laptop = yield* service.takeControl(recorder().options);
      expect(phone.ended).toEqual([
        { reason: "replaced", detail: REMOTE_CONTROL_END_DETAIL.replaced },
      ]);
      expect(first.active()).toBe(false);
      expect(laptop.active()).toBe(true);
      const status = yield* service.status;
      expect(status.holder?.kind).toBe("user");
      expect(status.waiting.map((entry) => entry.botName)).toEqual(["Bob"]);
      // The old handle can no longer end the new session.
      first.end("closed");
      expect(laptop.active()).toBe(true);
      laptop.end("closed");
      yield* Fiber.join(bobWaits);
    }),
  );

  it.live("lets go of a mouse button still held by a drag when control ends", () =>
    Effect.gen(function* () {
      const driver = new FakeDriver();
      const { service } = yield* makeDesktopService({ driver });
      const session = yield* service.takeControl(recorder().options);
      yield* Effect.promise(() =>
        session.input({ _tag: "Pointer", action: "down", x: 10, y: 10, ...frame }),
      );
      session.end("closed");
      yield* tick();
      const buttons = driver.remoteCalls().filter((call) => call.cmd === "button");
      expect(buttons.map((call) => call.params.down)).toEqual([true, false]);
      const after = yield* Effect.promise(() =>
        session.input({ _tag: "Text", text: "late" }).then(
          () => null,
          (error: unknown) => error,
        ),
      );
      expect((after as PersonalDesktopActionError).reason).toBe("Remote control has ended.");
    }),
  );

  it.live("the app's Stop also ends remote control", () =>
    Effect.gen(function* () {
      const driver = new FakeDriver();
      const { service } = yield* makeDesktopService({ driver });
      const { options, ended } = recorder();
      yield* service.takeControl(options);
      yield* service.stop("app");
      expect(ended.map((entry) => entry.reason)).toEqual(["stopped"]);
      expect((yield* service.status).holder).toBeNull();
    }),
  );
});
