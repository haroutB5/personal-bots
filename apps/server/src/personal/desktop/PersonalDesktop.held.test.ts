// @effect-diagnostics globalTimers:off - the fake driver is promise-based, like the real one.
/**
 * 1.66.6: computer_mouse_down / computer_mouse_up / computer_hold_key and the
 * modifiers on drag and scroll. The point of these tests is the guarantee: a
 * mouse button or key a bot holds is let go on every path where it could
 * otherwise stay pressed, and the new actions obey the same one-bot-at-a-time
 * lock, stop key and takeover as every other desktop action.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";

import * as DesktopActions from "./desktopActions.ts";
import type { DesktopDriver } from "./DesktopHelper.ts";
import { DesktopHelperError } from "./DesktopHelper.ts";
import {
  HELD_RELEASED_NOTE,
  makeDesktopService,
  PersonalDesktopActionError,
  STOPPED_REASON,
  TAKEN_OVER_REASON,
} from "./PersonalDesktop.ts";

const ada = { threadId: "t-ada", botId: "b-ada", botName: "Ada" };
const bob = { threadId: "t-bob", botId: "b-bob", botName: "Bob" };

const NO_SHOT = { screenshot: false } as const;

/** A desktop that answers like the helper, and can be told to fail or hang a command. */
class FakeDriver implements DesktopDriver {
  readonly calls: Array<{
    cmd: string;
    params: Readonly<Record<string, unknown>>;
    timeoutMs: number | undefined;
  }> = [];
  private killListener: (() => void) | null = null;
  /** Commands that reject with this error instead of answering. */
  readonly failing = new Map<string, Error>();
  /** Commands that never answer until the stop key. */
  readonly hanging = new Set<string>();
  private readonly hung: Array<(error: Error) => void> = [];

  request(cmd: string, params: Readonly<Record<string, unknown>> = {}, timeoutMs?: number) {
    this.calls.push({ cmd, params, timeoutMs });
    const failure = this.failing.get(cmd);
    if (failure !== undefined) return Promise.reject(failure);
    if (this.hanging.has(cmd)) {
      return new Promise<Record<string, unknown>>((_resolve, reject) => {
        this.hung.push(reject);
      });
    }
    switch (cmd) {
      case "info":
        return Promise.resolve({
          monitors: [
            { index: 0, primary: true, x: 0, y: 0, width: 800, height: 600, dpi: 96, name: "d" },
          ],
          locked: false,
        });
      case "screenshot":
        return Promise.resolve({ mimeType: "image/png", data: "AAAA" });
      case "cursor":
        return Promise.resolve({ x: 5, y: 5 });
      default:
        return Promise.resolve({ ok: true });
    }
  }

  onKill(listener: () => void) {
    this.killListener = listener;
  }

  /** The user presses the stop key: the helper aborts what it is doing, then reports it. */
  pressStopKey() {
    for (const reject of this.hung.splice(0)) {
      reject(new DesktopHelperError("aborted", "Stopped by the user."));
    }
    this.killListener?.();
  }

  commands() {
    return this.calls.map((call) => call.cmd);
  }
  countOf(cmd: string) {
    return this.calls.filter((call) => call.cmd === cmd).length;
  }
  paramsOf(cmd: string) {
    return this.calls.filter((call) => call.cmd === cmd).map((call) => call.params);
  }

  dispose() {}
}

const failureOf = <A>(exit: Exit.Exit<A, PersonalDesktopActionError>) => {
  if (Exit.isSuccess(exit)) return null;
  const error = Cause.squash(exit.cause);
  return error instanceof PersonalDesktopActionError ? error : null;
};

const tick = () => Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));

const setup = (options: Partial<Omit<Parameters<typeof makeDesktopService>[0], "driver">> = {}) =>
  Effect.gen(function* () {
    const driver = new FakeDriver();
    const made = yield* makeDesktopService({ ...options, driver });
    // A screenshot first, as every bot does: coordinates are pixels in its latest one.
    yield* made.service.act(ada, "screenshot", (context) => DesktopActions.captureShot(context));
    return { driver, ...made };
  });

describe("computer_mouse_down / computer_mouse_up", () => {
  it.live("press and release a button at points in the latest screenshot", () =>
    Effect.gen(function* () {
      const { driver, service } = yield* setup();
      yield* service.act(ada, "mouse_down", (context) =>
        DesktopActions.mouseDown(context, { x: 100, y: 50, ...NO_SHOT }),
      );
      expect(driver.paramsOf("button")).toEqual([{ button: "left", down: true, x: 100, y: 50 }]);
      yield* service.act(ada, "move", (context) =>
        DesktopActions.move(context, { x: 300, y: 200, ...NO_SHOT }),
      );
      yield* service.act(ada, "mouse_up", (context) =>
        DesktopActions.mouseUp(context, { x: 300, y: 200, button: "left", ...NO_SHOT }),
      );
      expect(driver.paramsOf("button")).toEqual([
        { button: "left", down: true, x: 100, y: 50 },
        { button: "left", down: false, x: 300, y: 200 },
      ]);
      // A clean press and release leaves nothing to let go of afterwards.
      yield* service.release(ada.threadId);
      yield* tick();
      expect(driver.countOf("releaseAll")).toBe(0);
    }),
  );

  it.live("left is the default, and a point is optional (the pointer stays where it is)", () =>
    Effect.gen(function* () {
      const { driver, service } = yield* setup();
      yield* service.act(ada, "mouse_down", (context) =>
        DesktopActions.mouseDown(context, NO_SHOT),
      );
      expect(driver.paramsOf("button")).toEqual([{ button: "left", down: true }]);
      yield* service.act(ada, "mouse_up", (context) => DesktopActions.mouseUp(context, NO_SHOT));
      expect(driver.paramsOf("button").at(-1)).toEqual({ button: "left", down: false });
    }),
  );

  it.live("refuses a second press of the same button and a release of one that is not held", () =>
    Effect.gen(function* () {
      const { service } = yield* setup();
      const early = yield* service
        .act(ada, "mouse_up", (context) => DesktopActions.mouseUp(context, NO_SHOT))
        .pipe(Effect.exit);
      expect(failureOf(early)?.kind).toBe("invalid");
      expect(failureOf(early)?.reason).toContain("not held down");

      yield* service.act(ada, "mouse_down", (context) =>
        DesktopActions.mouseDown(context, { button: "right", ...NO_SHOT }),
      );
      const twice = yield* service
        .act(ada, "mouse_down", (context) =>
          DesktopActions.mouseDown(context, { button: "right", ...NO_SHOT }),
        )
        .pipe(Effect.exit);
      expect(failureOf(twice)?.reason).toContain("already held down");
    }),
  );

  it.live("a point needs both coordinates and a screenshot to refer to", () =>
    Effect.gen(function* () {
      const driver = new FakeDriver();
      const { service } = yield* makeDesktopService({ driver });
      const blind = yield* service
        .act(ada, "mouse_down", (context) =>
          DesktopActions.mouseDown(context, { x: 1, y: 2, ...NO_SHOT }),
        )
        .pipe(Effect.exit);
      expect(failureOf(blind)?.reason).toContain("computer_screenshot first");
      yield* service.act(ada, "screenshot", (context) => DesktopActions.captureShot(context));
      const half = yield* service
        .act(ada, "mouse_down", (context) =>
          DesktopActions.mouseDown(context, { x: 1, ...NO_SHOT }),
        )
        .pipe(Effect.exit);
      expect(failureOf(half)?.reason).toContain("both x and y");
      expect(driver.countOf("button")).toBe(0);
    }),
  );

  it.live("a failing step lets the button go and tells the bot so", () =>
    Effect.gen(function* () {
      const { driver, service } = yield* setup();
      yield* service.act(ada, "mouse_down", (context) =>
        DesktopActions.mouseDown(context, { x: 10, y: 10, ...NO_SHOT }),
      );
      driver.failing.set(
        "move",
        new DesktopHelperError("user_active", "The user is using the mouse."),
      );
      const exit = yield* service
        .act(ada, "move", (context) => DesktopActions.move(context, { x: 50, y: 50, ...NO_SHOT }))
        .pipe(Effect.exit);
      expect(failureOf(exit)?.kind).toBe("user_active");
      expect(failureOf(exit)?.reason).toContain(HELD_RELEASED_NOTE);
      expect(driver.countOf("releaseAll")).toBe(1);
      // The helper is told what the service thinks is down, so a restarted helper still lets go.
      expect(driver.paramsOf("releaseAll")[0]).toEqual({
        buttons: ["left"],
        keys: false,
        abort: true,
      });

      // It is no longer held: releasing it again is refused, with the reason.
      const late = yield* service
        .act(ada, "mouse_up", (context) => DesktopActions.mouseUp(context, NO_SHOT))
        .pipe(Effect.exit);
      expect(failureOf(late)?.reason).toContain("let go automatically");
    }),
  );

  it.live("the release is not announced when nothing was held", () =>
    Effect.gen(function* () {
      const { driver, service } = yield* setup();
      driver.failing.set("move", new DesktopHelperError("failed", "boom"));
      const exit = yield* service
        .act(ada, "move", (context) => DesktopActions.move(context, { x: 5, y: 5, ...NO_SHOT }))
        .pipe(Effect.exit);
      expect(failureOf(exit)?.reason).not.toContain(HELD_RELEASED_NOTE);
      expect(driver.countOf("releaseAll")).toBe(0);
    }),
  );

  it.live("a release that fails is tried once more", () =>
    Effect.gen(function* () {
      const { driver, service } = yield* setup();
      yield* service.act(ada, "mouse_down", (context) =>
        DesktopActions.mouseDown(context, NO_SHOT),
      );
      driver.failing.set(
        "releaseAll",
        new DesktopHelperError("helper_exited", "The helper stopped."),
      );
      yield* service.release(ada.threadId);
      yield* tick();
      expect(driver.countOf("releaseAll")).toBe(2);
    }),
  );

  it.live("a press that fails to reach the helper is still released", () =>
    Effect.gen(function* () {
      const { driver, service } = yield* setup();
      // The helper timing out may have pressed the button before it stopped answering.
      driver.failing.set(
        "button",
        new DesktopHelperError("timeout", 'The desktop action "button" timed out.'),
      );
      const exit = yield* service
        .act(ada, "mouse_down", (context) => DesktopActions.mouseDown(context, NO_SHOT))
        .pipe(Effect.exit);
      expect(failureOf(exit)?.reason).toContain(HELD_RELEASED_NOTE);
      expect(driver.countOf("releaseAll")).toBe(1);
    }),
  );

  it.live("handing the PC back, the end of the turn and the owner's Stop all let go", () =>
    Effect.gen(function* () {
      for (const ending of ["release", "turn", "stop"] as const) {
        const { driver, service } = yield* setup();
        yield* service.act(ada, "mouse_down", (context) =>
          DesktopActions.mouseDown(context, NO_SHOT),
        );
        if (ending === "release") yield* service.release(ada.threadId);
        else if (ending === "turn") yield* service.threadTurnEnded(ada.threadId);
        else yield* service.stop("app");
        yield* tick();
        expect(driver.countOf("releaseAll"), ending).toBe(1);
      }
    }),
  );

  it.live("the owner taking over the PC remotely lets go of the bot's button", () =>
    Effect.gen(function* () {
      const { driver, service } = yield* setup();
      yield* service.act(ada, "mouse_down", (context) =>
        DesktopActions.mouseDown(context, NO_SHOT),
      );
      const session = yield* service.takeControl({ onEnded: () => undefined });
      yield* tick();
      expect(driver.countOf("releaseAll")).toBe(1);
      // Told the user took over, and refused until the turn ends.
      const refused = yield* service
        .act(ada, "mouse_up", (context) => DesktopActions.mouseUp(context, NO_SHOT))
        .pipe(Effect.exit);
      expect(failureOf(refused)?.reason).toBe(TAKEN_OVER_REASON);
      session.end("released");
    }),
  );

  it.live("losing the PC to the idle timeout lets go", () =>
    Effect.gen(function* () {
      let clock = 1_000_000;
      const { driver, service, sweep } = yield* setup({ now: () => clock, idleTimeoutMs: 120_000 });
      yield* service.act(ada, "mouse_down", (context) =>
        DesktopActions.mouseDown(context, NO_SHOT),
      );
      clock += 121_000;
      yield* sweep;
      yield* tick();
      expect(driver.countOf("releaseAll")).toBe(1);
      expect((yield* service.status).holder).toBeNull();
    }),
  );

  it.live("a button held for over a minute is let go while the bot still has the PC", () =>
    Effect.gen(function* () {
      let clock = 5_000_000;
      const { driver, service, sweep } = yield* setup({
        now: () => clock,
        idleTimeoutMs: 600_000,
        mouseHoldMaxMs: 60_000,
      });
      yield* service.act(ada, "mouse_down", (context) =>
        DesktopActions.mouseDown(context, NO_SHOT),
      );
      clock += 30_000;
      yield* sweep;
      yield* tick();
      expect(driver.countOf("releaseAll")).toBe(0);
      clock += 31_000;
      yield* sweep;
      yield* tick();
      expect(driver.countOf("releaseAll")).toBe(1);
      // The cap lets go without ending the action the bot may be running at that moment.
      expect(driver.paramsOf("releaseAll")[0]).toEqual({
        buttons: ["left"],
        keys: false,
        abort: false,
      });
      expect((yield* service.status).holder?.botName).toBe("Ada");
      // A sweep after that has nothing left to let go of.
      yield* sweep;
      yield* tick();
      expect(driver.countOf("releaseAll")).toBe(1);
    }),
  );

  it.live("the PC lock and the queue wording cover the new actions", () =>
    Effect.gen(function* () {
      const { driver, service } = yield* setup({ queueWaitMs: 20 });
      yield* service.act(ada, "mouse_down", (context) =>
        DesktopActions.mouseDown(context, NO_SHOT),
      );
      // Bob waits in line: nothing of his reaches the helper while Ada holds the PC.
      const blocked = yield* service
        .act(bob, "mouse_down", (context) => DesktopActions.mouseDown(context, NO_SHOT))
        .pipe(Effect.exit);
      expect(failureOf(blocked)?.kind).toBe("busy");
      expect(failureOf(blocked)?.reason).toContain("Ada is using the PC");
      expect(failureOf(blocked)?.reason).toContain("number 1 in line");
      expect(driver.countOf("button")).toBe(1);
      const blockedHold = yield* service
        .act(bob, "hold_key", (context) =>
          DesktopActions.holdKey(context, { keys: "shift", durationMs: 100, ...NO_SHOT }),
        )
        .pipe(Effect.exit);
      expect(failureOf(blockedHold)?.kind).toBe("busy");
      expect(driver.countOf("hold")).toBe(0);
      // The banner is for Ada, and when she hands back her button is let go before Bob's first action.
      yield* service.release(ada.threadId);
      const order: string[] = [];
      yield* service.act(bob, "mouse_down", (context) => {
        order.push(...driver.commands());
        return DesktopActions.mouseDown(context, NO_SHOT);
      });
      expect(order.lastIndexOf("releaseAll")).toBeGreaterThan(order.lastIndexOf("button"));
      expect(driver.paramsOf("overlay").map((params) => params.show)).toEqual([true, true]);
    }),
  );
});

describe("computer_hold_key", () => {
  it.live("holds the chord for the time asked and waits that long for the helper", () =>
    Effect.gen(function* () {
      const { driver, service } = yield* setup();
      yield* service.act(ada, "hold_key", (context) =>
        DesktopActions.holdKey(context, { keys: "ctrl+shift", durationMs: 1500, ...NO_SHOT }),
      );
      expect(driver.paramsOf("hold")).toEqual([
        { keys: [0x11, 0x10], durationMs: 1500, repeat: false },
      ]);
      expect(driver.calls.find((call) => call.cmd === "hold")?.timeoutMs).toBe(13_500);
      // A normal hold needs no extra release.
      yield* service.release(ada.threadId);
      yield* tick();
      expect(driver.countOf("releaseAll")).toBe(0);
    }),
  );

  it.live("a navigation key held for 30 s repeats like a keyboard; longer is refused", () =>
    Effect.gen(function* () {
      const { driver, service } = yield* setup();
      yield* service.act(ada, "hold_key", (context) =>
        DesktopActions.holdKey(context, { keys: "pagedown", durationMs: 30_000, ...NO_SHOT }),
      );
      expect(driver.paramsOf("hold")).toEqual([{ keys: [0x22], durationMs: 30_000, repeat: true }]);
      const tooLong = yield* service
        .act(ada, "hold_key", (context) =>
          DesktopActions.holdKey(context, { keys: "pagedown", durationMs: 30_001, ...NO_SHOT }),
        )
        .pipe(Effect.exit);
      expect(failureOf(tooLong)?.kind).toBe("invalid");
      expect(failureOf(tooLong)?.reason).toContain("30000");
      expect(driver.countOf("hold")).toBe(1);
    }),
  );

  it.live("cannot be used to type: plain printable keys are short, single and never repeat", () =>
    Effect.gen(function* () {
      const { driver, service } = yield* setup();
      yield* service.act(ada, "hold_key", (context) =>
        DesktopActions.holdKey(context, { keys: "a", durationMs: 2000, ...NO_SHOT }),
      );
      expect(driver.paramsOf("hold")).toEqual([{ keys: [0x41], durationMs: 2000, repeat: false }]);
      for (const keys of ["a", "shift+a", "7", "/", "space"]) {
        const exit = yield* service
          .act(ada, "hold_key", (context) =>
            DesktopActions.holdKey(context, { keys, durationMs: 2500, ...NO_SHOT }),
          )
          .pipe(Effect.exit);
        expect(failureOf(exit)?.reason, keys).toContain("computer_type");
      }
      // Two printable keys cannot be held together (that would spell something).
      const spelled = yield* service
        .act(ada, "hold_key", (context) =>
          DesktopActions.holdKey(context, { keys: "a+b", durationMs: 500, ...NO_SHOT }),
        )
        .pipe(Effect.exit);
      expect(failureOf(spelled)?.reason).toContain("at most one key besides the modifiers");
      // A shortcut is not text: ctrl, alt or win with a letter may be held and repeats.
      yield* service.act(ada, "hold_key", (context) =>
        DesktopActions.holdKey(context, { keys: "ctrl+z", durationMs: 3000, ...NO_SHOT }),
      );
      expect(driver.paramsOf("hold").at(-1)).toEqual({
        keys: [0x11, 0x5a],
        durationMs: 3000,
        repeat: true,
      });
      expect(driver.countOf("hold")).toBe(2);
    }),
  );

  it.live("a hold that times out or fails is let go, and the bot is told", () =>
    Effect.gen(function* () {
      const { driver, service } = yield* setup();
      driver.failing.set(
        "hold",
        new DesktopHelperError("timeout", 'The desktop action "hold" timed out.'),
      );
      const exit = yield* service
        .act(ada, "hold_key", (context) =>
          DesktopActions.holdKey(context, { keys: "shift", durationMs: 1000, ...NO_SHOT }),
        )
        .pipe(Effect.exit);
      expect(failureOf(exit)?.reason).toContain(HELD_RELEASED_NOTE);
      expect(driver.countOf("releaseAll")).toBe(1);
    }),
  );

  it.live("the user's stop key ends a hold in progress and the keys are let go", () =>
    Effect.gen(function* () {
      const { driver, service } = yield* setup();
      driver.hanging.add("hold");
      const running = yield* service
        .act(ada, "hold_key", (context) =>
          DesktopActions.holdKey(context, { keys: "down", durationMs: 20_000, ...NO_SHOT }),
        )
        .pipe(Effect.exit, Effect.forkChild);
      yield* tick();
      driver.pressStopKey();
      const exit = yield* Fiber.join(running);
      expect(failureOf(exit)?.kind).toBe("stopped");
      expect(failureOf(exit)?.reason).toContain(STOPPED_REASON);
      yield* tick();
      expect(driver.countOf("releaseAll")).toBeGreaterThanOrEqual(1);
      expect((yield* service.status).holder).toBeNull();
    }),
  );

  it.live("the end of the turn lets go of a hold the helper was still running", () =>
    Effect.gen(function* () {
      const { driver, service } = yield* setup();
      driver.hanging.add("hold");
      const running = yield* service
        .act(ada, "hold_key", (context) =>
          DesktopActions.holdKey(context, { keys: "shift", durationMs: 5_000, ...NO_SHOT }),
        )
        .pipe(Effect.exit, Effect.forkChild);
      yield* tick();
      yield* service.threadTurnEnded(ada.threadId);
      yield* tick();
      expect(driver.countOf("releaseAll")).toBe(1);
      driver.pressStopKey();
      yield* Fiber.join(running);
    }),
  );
});

describe("modifiers on drag and scroll", () => {
  it.live("are sent to the helper as virtual keys, the same names click takes", () =>
    Effect.gen(function* () {
      const { driver, service } = yield* setup();
      yield* service.act(ada, "drag", (context) =>
        DesktopActions.drag(context, {
          fromX: 1,
          fromY: 2,
          toX: 30,
          toY: 40,
          modifiers: "shift",
          ...NO_SHOT,
        }),
      );
      yield* service.act(ada, "scroll", (context) =>
        DesktopActions.scroll(context, {
          direction: "up",
          amount: 2,
          modifiers: "ctrl+alt",
          ...NO_SHOT,
        }),
      );
      yield* service.act(ada, "click", (context) =>
        DesktopActions.click(context, { x: 3, y: 4, modifiers: "ctrl", ...NO_SHOT }),
      );
      expect(driver.paramsOf("drag")[0]).toMatchObject({ fromX: 1, toY: 40, modifiers: [0x10] });
      expect(driver.paramsOf("scroll")[0]).toMatchObject({
        dy: -2,
        dx: 0,
        modifiers: [0x11, 0x12],
      });
      expect(driver.paramsOf("click")[0]).toMatchObject({ modifiers: [0x11] });
    }),
  );

  it.live("default to none, and anything but a named key is refused before the PC is touched", () =>
    Effect.gen(function* () {
      const { driver, service } = yield* setup();
      yield* service.act(ada, "drag", (context) =>
        DesktopActions.drag(context, { fromX: 1, fromY: 2, toX: 3, toY: 4, ...NO_SHOT }),
      );
      yield* service.act(ada, "scroll", (context) =>
        DesktopActions.scroll(context, { direction: "down", ...NO_SHOT }),
      );
      expect(driver.paramsOf("drag")[0]).toMatchObject({ modifiers: [] });
      expect(driver.paramsOf("scroll")[0]).toMatchObject({ modifiers: [], dy: 3 });
      for (const modifiers of ["a", "ctrl+a", "enter+q"]) {
        const exit = yield* service
          .act(ada, "drag", (context) =>
            DesktopActions.drag(context, {
              fromX: 1,
              fromY: 2,
              toX: 3,
              toY: 4,
              modifiers,
              ...NO_SHOT,
            }),
          )
          .pipe(Effect.exit);
        // Letters and Enter are real keys, not modifiers.
        expect(failureOf(exit)?.kind, modifiers).toBe("invalid");
      }
      expect(driver.countOf("drag")).toBe(1);
    }),
  );

  it.live("a failed drag or scroll with modifiers is reported without leaving anything held", () =>
    Effect.gen(function* () {
      const { driver, service } = yield* setup();
      driver.failing.set(
        "drag",
        new DesktopHelperError("user_active", "The user started using the mouse."),
      );
      const exit = yield* service
        .act(ada, "drag", (context) =>
          DesktopActions.drag(context, {
            fromX: 1,
            fromY: 2,
            toX: 3,
            toY: 4,
            modifiers: "shift",
            ...NO_SHOT,
          }),
        )
        .pipe(Effect.exit);
      expect(failureOf(exit)?.kind).toBe("user_active");
      // The helper's own finally lets the modifier go; the service holds no record of it.
      expect(driver.countOf("releaseAll")).toBe(0);
    }),
  );
});
