import { describe, expect, it, vi } from "vite-plus/test";

import {
  createPushController,
  type PermissionAnswer,
  type PushNativePort,
  type PushRegistrar,
  type RegisterOutcome,
  type StoredRegistration,
} from "./pushController";
import { REREGISTER_AFTER_MS } from "./pushState";

interface Rig {
  readonly native: PushNativePort & {
    configured: boolean;
    enabled: boolean;
    token: string | null;
    tokenError: Error | null;
    deleted: number;
    settingsOpened: number;
  };
  readonly registrar: PushRegistrar & {
    outcome: RegisterOutcome | Error;
    calls: Array<{ token: string; appVersion: string }>;
    unregistered: string[];
    unregisterNever: boolean;
  };
  readonly store: { value: StoredRegistration | null; cleared: number };
  readonly permission: { answer: PermissionAnswer; asked: number };
  clock: { now: number };
  connected: boolean;
}

function rig(overrides: Partial<{ configured: boolean; enabled: boolean }> = {}) {
  const state: Rig = {
    native: {
      configured: overrides.configured ?? true,
      enabled: overrides.enabled ?? true,
      token: "tok-1",
      tokenError: null,
      deleted: 0,
      settingsOpened: 0,
      isFcmConfigured() {
        return this.configured;
      },
      async fcmToken() {
        if (this.tokenError !== null) throw this.tokenError;
        return this.token;
      },
      async deleteFcmToken() {
        this.deleted += 1;
      },
      notificationsEnabled() {
        return this.enabled;
      },
      openNotificationSettings() {
        this.settingsOpened += 1;
      },
    },
    registrar: {
      outcome: { kind: "ready" },
      calls: [],
      unregistered: [],
      unregisterNever: false,
      async register(input) {
        this.calls.push(input);
        if (this.outcome instanceof Error) throw this.outcome;
        return this.outcome;
      },
      async unregister(token) {
        if (this.unregisterNever) return new Promise<void>(() => undefined);
        this.unregistered.push(token);
      },
    },
    store: { value: null, cleared: 0 },
    permission: { answer: "granted", asked: 0 },
    clock: { now: 10_000 },
    connected: true,
  };
  const controller = createPushController({
    native: () => state.native,
    registrar: () => (state.connected ? state.registrar : null),
    permission: {
      request: async () => {
        state.permission.asked += 1;
        return state.permission.answer;
      },
    },
    store: {
      read: () => state.store.value,
      write: (value) => {
        state.store.value = value;
      },
      clear: () => {
        state.store.value = null;
        state.store.cleared += 1;
      },
    },
    appVersion: () => "1.68.0",
    now: () => state.clock.now,
    unregisterTimeoutMs: 20,
  });
  return { state, controller };
}

describe("push controller: refresh", () => {
  it("starts as checking", () => {
    expect(rig().controller.getStatus()).toEqual({ kind: "checking" });
  });

  it("is unconfigured, and touches nothing, when the build has no Firebase", async () => {
    const { state, controller } = rig({ configured: false });
    await controller.refresh();
    expect(controller.getStatus()).toEqual({ kind: "unconfigured" });
    expect(state.registrar.calls).toEqual([]);
    expect(state.permission.asked).toBe(0);
  });

  it("is unconfigured when the native module is not linked", async () => {
    const controller = createPushController({
      native: () => null,
      registrar: () => null,
      permission: { request: async () => "granted" },
      store: { read: () => null, write: () => undefined, clear: () => undefined },
      appVersion: () => "1",
    });
    await controller.refresh();
    expect(controller.getStatus()).toEqual({ kind: "unconfigured" });
  });

  it("is blocked, without registering, while Android notifications are off", async () => {
    const { state, controller } = rig({ enabled: false });
    await controller.refresh();
    expect(controller.getStatus()).toEqual({ kind: "blocked" });
    expect(state.registrar.calls).toEqual([]);
  });

  it("registers the token and is on when the server says ready", async () => {
    const { state, controller } = rig();
    await controller.refresh();
    expect(state.registrar.calls).toEqual([{ token: "tok-1", appVersion: "1.68.0" }]);
    expect(controller.getStatus()).toEqual({ kind: "on", tokenRegisteredAt: 10_000 });
    expect(state.store.value).toMatchObject({ token: "tok-1", delivery: "ready" });
  });

  it("is server-off when the server answers disabled, and still remembers the token", async () => {
    const { state, controller } = rig();
    state.registrar.outcome = { kind: "disabled" };
    await controller.refresh();
    expect(controller.getStatus()).toEqual({ kind: "server-off" });
    expect(state.store.value).toMatchObject({ token: "tok-1", delivery: "disabled" });
  });

  it("is an error with the message when the server call fails", async () => {
    const { state, controller } = rig();
    state.registrar.outcome = { kind: "failed", message: "Offline" };
    await controller.refresh();
    expect(controller.getStatus()).toEqual({ kind: "error", message: "Offline" });
    expect(state.store.value).toBeNull();
  });

  it("turns a thrown registrar into an error", async () => {
    const { state, controller } = rig();
    state.registrar.outcome = new Error("boom");
    await controller.refresh();
    expect(controller.getStatus()).toEqual({ kind: "error", message: "boom" });
  });

  it("is an error when Google gives no token", async () => {
    const { state, controller } = rig();
    state.native.token = null;
    await controller.refresh();
    expect(controller.getStatus().kind).toBe("error");
    expect(state.registrar.calls).toEqual([]);
  });

  it("is an error when asking Google throws", async () => {
    const { state, controller } = rig();
    state.native.tokenError = new Error("SERVICE_NOT_AVAILABLE");
    await controller.refresh();
    expect(controller.getStatus()).toEqual({ kind: "error", message: "SERVICE_NOT_AVAILABLE" });
  });

  it("stays checking until a connection can reach the server, then registers", async () => {
    const { state, controller } = rig();
    state.connected = false;
    await controller.refresh();
    expect(controller.getStatus()).toEqual({ kind: "checking" });
    state.connected = true;
    await controller.refresh();
    expect(controller.getStatus().kind).toBe("on");
  });

  it("does not send the same token again inside the trust window", async () => {
    const { state, controller } = rig();
    await controller.refresh();
    state.clock.now += REREGISTER_AFTER_MS - 1;
    await controller.refresh();
    expect(state.registrar.calls).toHaveLength(1);
  });

  it("sends it again after the window, for a new token and for a new app version", async () => {
    const { state, controller } = rig();
    await controller.refresh();
    state.clock.now += REREGISTER_AFTER_MS;
    await controller.refresh();
    expect(state.registrar.calls).toHaveLength(2);
    state.native.token = "tok-2";
    await controller.refresh();
    expect(state.registrar.calls.at(-1)?.token).toBe("tok-2");
  });

  it("keeps the server-off answer of a trusted token across launches", async () => {
    const first = rig();
    first.state.registrar.outcome = { kind: "disabled" };
    await first.controller.refresh();
    const second = rig();
    second.state.store.value = first.state.store.value;
    await second.controller.refresh();
    expect(second.controller.getStatus()).toEqual({ kind: "server-off" });
    expect(second.state.registrar.calls).toEqual([]);
  });

  it("registers once for overlapping refreshes", async () => {
    const { state, controller } = rig();
    await Promise.all([controller.refresh(), controller.refresh(), controller.refresh()]);
    expect(state.registrar.calls).toHaveLength(1);
  });

  it("notifies subscribers once per change", async () => {
    const { controller } = rig();
    const listener = vi.fn();
    const stop = controller.subscribe(listener);
    await controller.refresh();
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    await controller.refresh({ force: true });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("push controller: permission", () => {
  it("asks Android, then registers when the user allows", async () => {
    const { state, controller } = rig({ enabled: false });
    state.permission.answer = "granted";
    state.native.enabled = false;
    const asked = controller.enable();
    state.native.enabled = true;
    await asked;
    expect(state.permission.asked).toBe(1);
    expect(controller.getStatus().kind).toBe("on");
  });

  it("is blocked when the user refuses", async () => {
    const { state, controller } = rig({ enabled: false });
    state.permission.answer = "denied";
    await controller.enable();
    expect(controller.getStatus()).toEqual({ kind: "blocked" });
    expect(state.registrar.calls).toEqual([]);
    expect(state.native.settingsOpened).toBe(0);
  });

  it("opens Android settings when it will not ask again", async () => {
    const { state, controller } = rig({ enabled: false });
    state.permission.answer = "blocked";
    await controller.enable();
    expect(controller.getStatus()).toEqual({ kind: "blocked" });
    expect(state.native.settingsOpened).toBe(1);
  });

  it("opens Android settings below Android 13, where there is no prompt", async () => {
    const { state, controller } = rig({ enabled: false });
    state.permission.answer = "not-needed";
    await controller.enable();
    expect(state.native.settingsOpened).toBe(1);
    expect(controller.getStatus()).toEqual({ kind: "blocked" });
  });

  it("does not ask when notifications are already on", async () => {
    const { state, controller } = rig();
    await controller.enable();
    expect(state.permission.asked).toBe(0);
    expect(controller.getStatus().kind).toBe("on");
  });

  it("never asks on a build without Firebase", async () => {
    const { state, controller } = rig({ configured: false, enabled: false });
    await controller.enable();
    expect(state.permission.asked).toBe(0);
    expect(controller.getStatus()).toEqual({ kind: "unconfigured" });
  });
});

describe("push controller: token refresh", () => {
  it("registers a new token from Firebase", async () => {
    const { state, controller } = rig();
    await controller.refresh();
    await controller.onTokenRefresh("tok-9");
    expect(state.registrar.calls.at(-1)).toEqual({ token: "tok-9", appVersion: "1.68.0" });
    expect(state.store.value?.token).toBe("tok-9");
  });

  it("ignores a refresh on a build without Firebase", async () => {
    const { state, controller } = rig({ configured: false });
    await controller.onTokenRefresh("tok-9");
    expect(state.registrar.calls).toEqual([]);
  });

  it("ignores a refresh while notifications are blocked", async () => {
    const { state, controller } = rig({ enabled: false });
    await controller.onTokenRefresh("tok-9");
    expect(state.registrar.calls).toEqual([]);
  });
});

describe("push controller: teardown", () => {
  it("unregisters on the server, forgets the token and deletes the Firebase token on sign-out", async () => {
    const { state, controller } = rig();
    await controller.refresh();
    await controller.teardown({ remote: true });
    expect(state.registrar.unregistered).toEqual(["tok-1"]);
    expect(state.store.value).toBeNull();
    expect(state.native.deleted).toBe(1);
    expect(controller.getStatus()).toEqual({ kind: "checking" });
  });

  it("does not call the server after a revoke, but still forgets everything locally", async () => {
    const { state, controller } = rig();
    await controller.refresh();
    await controller.teardown({ remote: false });
    expect(state.registrar.unregistered).toEqual([]);
    expect(state.store.value).toBeNull();
    expect(state.native.deleted).toBe(1);
  });

  it("does not wait for a server that never answers", async () => {
    const { state, controller } = rig();
    await controller.refresh();
    state.registrar.unregisterNever = true;
    await controller.teardown({ remote: true });
    expect(state.store.value).toBeNull();
    expect(state.native.deleted).toBe(1);
  });

  it("does not throw when the server call fails", async () => {
    const { state, controller } = rig();
    await controller.refresh();
    state.registrar.unregister = async () => {
      throw new Error("offline");
    };
    await expect(controller.teardown({ remote: true })).resolves.toBeUndefined();
    expect(state.store.value).toBeNull();
  });

  it("does not throw when Google cannot delete the token", async () => {
    const { state, controller } = rig();
    await controller.refresh();
    state.native.deleteFcmToken = async () => {
      throw new Error("no");
    };
    await expect(controller.teardown({ remote: false })).resolves.toBeUndefined();
  });

  it("keeps a registration that was still in flight from landing after sign-out", async () => {
    const { state, controller } = rig();
    let release: (outcome: RegisterOutcome) => void = () => undefined;
    state.registrar.register = (input) => {
      state.registrar.calls.push(input);
      return new Promise<RegisterOutcome>((resolve) => {
        release = resolve;
      });
    };
    const pending = controller.refresh();
    await vi.waitFor(() => expect(state.registrar.calls).toHaveLength(1));
    await controller.teardown({ remote: false });
    release({ kind: "ready" });
    await pending;
    expect(state.store.value).toBeNull();
    expect(controller.getStatus()).toEqual({ kind: "checking" });
  });
});
