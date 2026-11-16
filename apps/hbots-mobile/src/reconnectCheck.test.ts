import { describe, expect, it, vi } from "vite-plus/test";

import {
  RECONNECT_CHECK_MIN_GAP_MS,
  startReconnectCheck,
  type ConnectionSource,
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

function setup(options: { readonly on?: () => boolean } = {}) {
  const connection = fakeConnection();
  const clock = { at: 1_000_000 };
  const check = vi.fn();
  const stop = startReconnectCheck({
    connection: connection.source,
    check,
    isOn: options.on ?? (() => true),
    now: () => clock.at,
  });
  return { connection, clock, check, stop };
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
    const { connection, clock, check, stop } = setup();
    stop();
    clock.at += 10 * 60 * SECOND;
    connection.set(false);
    connection.set(true);
    expect(connection.listeners.size).toBe(0);
    expect(check).not.toHaveBeenCalled();
  });
});
