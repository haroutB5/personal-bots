import { describe, expect, it, vi } from "vite-plus/test";

import {
  RECONNECT_CHECK_MIN_GAP_MS,
  startReconnectCheck,
  type ConnectionSource,
  type UpdaterView,
} from "./reconnectCheck";

function fakeConnection() {
  const listeners = new Set<(connected: boolean) => void>();
  const source: ConnectionSource = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    source,
    set: (connected: boolean) => listeners.forEach((listener) => listener(connected)),
    listeners,
  };
}

function fakeUpdater() {
  const listeners = new Set<(view: UpdaterView) => void>();
  const emit = (view: UpdaterView) => listeners.forEach((listener) => listener(view));
  return {
    source: {
      subscribe: (listener: (view: UpdaterView) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    listeners,
    downloading: (version: string) =>
      emit({ state: "downloading", target: { version }, rejected: null }),
    failed: () => emit({ state: "idle", target: null, rejected: null }),
    rejected: (version: string) => emit({ state: "idle", target: null, rejected: version }),
    ready: (version: string) => emit({ state: "ready", target: { version }, rejected: null }),
  };
}

function setup(options: { readonly on?: () => boolean } = {}) {
  const connection = fakeConnection();
  const updater = fakeUpdater();
  const clock = { at: 1_000_000 };
  const check = vi.fn();
  const stop = startReconnectCheck({
    connection: connection.source,
    updates: updater.source,
    check,
    isOn: options.on ?? (() => true),
    now: () => clock.at,
  });
  return { connection, updater, clock, check, stop };
}

const SECOND = 1_000;

describe("check for an update when the connection returns", () => {
  it("checks once when the connection comes back after a drop", () => {
    const { connection, clock, check } = setup();
    connection.set(false);
    connection.set(true);
    clock.at += 5 * 60 * SECOND;
    connection.set(false);
    clock.at += 20 * SECOND;
    connection.set(true);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("does not add a second check when the app first connects, a moment after the launch check", () => {
    const { connection, clock, check } = setup();
    connection.set(false);
    clock.at += 800;
    connection.set(true);
    expect(check).not.toHaveBeenCalled();
  });

  it("checks the first connect when the launch check was long ago, as with a server that was down", () => {
    const { connection, clock, check } = setup();
    connection.set(false);
    clock.at += RECONNECT_CHECK_MIN_GAP_MS + SECOND;
    connection.set(true);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("checks once for two reconnects inside a minute", () => {
    const { connection, clock, check } = setup();
    connection.set(true);
    clock.at += 10 * 60 * SECOND;
    connection.set(false);
    connection.set(true);
    clock.at += 20 * SECOND;
    connection.set(false);
    connection.set(true);
    clock.at += 20 * SECOND;
    connection.set(false);
    connection.set(true);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("checks again once a minute has passed since the last check", () => {
    const { connection, clock, check } = setup();
    connection.set(true);
    clock.at += 10 * 60 * SECOND;
    connection.set(false);
    connection.set(true);
    clock.at += RECONNECT_CHECK_MIN_GAP_MS;
    connection.set(false);
    connection.set(true);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("does nothing while the connection stays up or stays down", () => {
    const { connection, clock, check } = setup();
    connection.set(true);
    clock.at += 10 * 60 * SECOND;
    connection.set(true);
    connection.set(true);
    connection.set(false);
    connection.set(false);
    expect(check).not.toHaveBeenCalled();
  });

  it("checks nothing when the kill switch is off, and the same drop checks once it is on", () => {
    const state = { on: false };
    const { connection, clock, check } = setup({ on: () => state.on });
    connection.set(true);
    clock.at += 10 * 60 * SECOND;
    connection.set(false);
    connection.set(true);
    expect(check).not.toHaveBeenCalled();

    state.on = true;
    clock.at += 10 * 60 * SECOND;
    connection.set(false);
    connection.set(true);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("an off switch does not start the minute, so the first allowed reconnect still checks", () => {
    const state = { on: false };
    const { connection, clock, check } = setup({ on: () => state.on });
    clock.at += 10 * 60 * SECOND;
    connection.set(false);
    connection.set(true);
    state.on = true;
    clock.at += 5 * SECOND;
    connection.set(false);
    connection.set(true);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("stops listening when stopped", () => {
    const { connection, updater, clock, check, stop } = setup();
    stop();
    clock.at += 10 * 60 * SECOND;
    connection.set(false);
    connection.set(true);
    expect(connection.listeners.size).toBe(0);
    expect(updater.listeners.size).toBe(0);
    expect(check).not.toHaveBeenCalled();
  });
});

const MINUTE = 60 * SECOND;

describe("back off after a failed download", () => {
  function reconnects(setupResult: ReturnType<typeof setup>) {
    const { connection } = setupResult;
    connection.set(false);
    connection.set(true);
  }

  function launchDone(setupResult: ReturnType<typeof setup>) {
    setupResult.clock.at += 10 * MINUTE;
  }

  it("holds a reconnect check for 5 minutes after the first failure, then allows it", () => {
    const s = setup();
    launchDone(s);
    s.updater.downloading("1.67.28");
    s.updater.failed();

    s.clock.at += 5 * MINUTE - 1;
    reconnects(s);
    expect(s.check).not.toHaveBeenCalled();

    s.clock.at += 1;
    reconnects(s);
    expect(s.check).toHaveBeenCalledTimes(1);
  });

  it("holds 15 minutes after the second failure of the same release", () => {
    const s = setup();
    launchDone(s);
    s.updater.downloading("1.67.28");
    s.updater.failed();
    s.clock.at += 5 * MINUTE;
    reconnects(s);
    s.updater.downloading("1.67.28");
    s.updater.failed();

    s.clock.at += 15 * MINUTE - 1;
    reconnects(s);
    expect(s.check).toHaveBeenCalledTimes(1);

    s.clock.at += 1;
    reconnects(s);
    expect(s.check).toHaveBeenCalledTimes(2);
  });

  it("holds 60 minutes after the third failure and after every later one", () => {
    const s = setup();
    launchDone(s);
    const fail = () => {
      s.updater.downloading("1.67.28");
      s.updater.failed();
    };
    fail();
    s.clock.at += 5 * MINUTE;
    reconnects(s);
    fail();
    s.clock.at += 15 * MINUTE;
    reconnects(s);
    fail();
    expect(s.check).toHaveBeenCalledTimes(2);

    s.clock.at += 60 * MINUTE - 1;
    reconnects(s);
    expect(s.check).toHaveBeenCalledTimes(2);
    s.clock.at += 1;
    reconnects(s);
    expect(s.check).toHaveBeenCalledTimes(3);

    fail();
    s.clock.at += 60 * MINUTE - 1;
    reconnects(s);
    expect(s.check).toHaveBeenCalledTimes(3);
    s.clock.at += 1;
    reconnects(s);
    expect(s.check).toHaveBeenCalledTimes(4);
  });

  it("counts the wait from the failure, not from the last check", () => {
    const s = setup();
    launchDone(s);
    s.updater.downloading("1.67.28");
    s.clock.at += 4 * MINUTE;
    s.updater.failed();

    s.clock.at += 5 * MINUTE - 1;
    reconnects(s);
    expect(s.check).not.toHaveBeenCalled();
    s.clock.at += 1;
    reconnects(s);
    expect(s.check).toHaveBeenCalledTimes(1);
  });

  it("a held reconnect does not start the 60 second floor", () => {
    const s = setup();
    launchDone(s);
    s.updater.downloading("1.67.28");
    s.updater.failed();
    s.clock.at += 4 * MINUTE;
    reconnects(s);

    s.clock.at += MINUTE;
    reconnects(s);
    expect(s.check).toHaveBeenCalledTimes(1);
  });

  it("starts again from the first step after a download that finished", () => {
    const s = setup();
    launchDone(s);
    s.updater.downloading("1.67.28");
    s.updater.failed();
    s.updater.downloading("1.67.28");
    s.updater.failed();
    s.updater.downloading("1.67.28");
    s.updater.ready("1.67.28");

    s.clock.at += RECONNECT_CHECK_MIN_GAP_MS;
    reconnects(s);
    expect(s.check).toHaveBeenCalledTimes(1);

    s.updater.downloading("1.67.29");
    s.updater.failed();
    s.clock.at += 5 * MINUTE;
    reconnects(s);
    expect(s.check).toHaveBeenCalledTimes(2);
  });

  it("starts again from the first step when a different release is offered", () => {
    const s = setup();
    launchDone(s);
    s.updater.downloading("1.67.28");
    s.updater.failed();
    s.updater.downloading("1.67.28");
    s.updater.failed();

    s.updater.downloading("1.67.29");
    s.updater.failed();
    s.clock.at += 5 * MINUTE;
    reconnects(s);
    expect(s.check).toHaveBeenCalledTimes(1);
  });

  it("starts again from the first step in a new process, with no wait carried over", () => {
    const first = setup();
    launchDone(first);
    first.updater.downloading("1.67.28");
    first.updater.failed();
    first.stop();

    const second = setup();
    launchDone(second);
    reconnects(second);
    expect(second.check).toHaveBeenCalledTimes(1);
  });

  it("does not hold for a release the phone rejected, which it will not download again", () => {
    const s = setup();
    launchDone(s);
    s.updater.downloading("1.67.28");
    s.updater.rejected("1.67.28");

    reconnects(s);
    expect(s.check).toHaveBeenCalledTimes(1);
  });

  it("does not hold when the updater was already idle", () => {
    const s = setup();
    launchDone(s);
    s.updater.failed();

    reconnects(s);
    expect(s.check).toHaveBeenCalledTimes(1);
  });

  it("keeps the 60 second floor when nothing failed", () => {
    const s = setup();
    launchDone(s);
    s.updater.downloading("1.67.28");
    s.updater.ready("1.67.28");
    reconnects(s);
    s.clock.at += RECONNECT_CHECK_MIN_GAP_MS - 1;
    reconnects(s);
    expect(s.check).toHaveBeenCalledTimes(1);

    s.clock.at += 1;
    reconnects(s);
    expect(s.check).toHaveBeenCalledTimes(2);
  });
});
