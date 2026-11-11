import * as Cause from "effect/Cause";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { PushRegistrationSync } from "./PushRegistrationSync";

const mocks = vi.hoisted(() => ({
  phase: "connected" as string,
  environmentId: "env-1" as string | null,
  subscribe: vi.fn(),
  readyServiceWorker: vi.fn(),
}));

vi.mock("./PersonalOfflineBanner", () => ({ usePersonalConnectionPhase: () => mocks.phase }));
vi.mock("./usePersonalBots", () => ({ usePersonalEnvironmentId: () => mocks.environmentId }));
vi.mock("./usePersonalAutomation", () => ({ personalPushSubscribe: "push-subscribe" }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.subscribe }));
vi.mock("./serviceWorker", () => ({
  readyServiceWorker: () => mocks.readyServiceWorker(),
}));

const SUBSCRIPTION = {
  toJSON: () => ({
    endpoint: "https://web.push.apple.com/abc",
    keys: { p256dh: "BPublicKey", auth: "AuthSecret" },
  }),
};

let renderer: ReactTestRenderer;
const mount = async () => {
  await act(async () => {
    renderer = create(<PushRegistrationSync />);
  });
};
const rerender = async () => {
  await act(async () => renderer.update(<PushRegistrationSync />));
};

beforeEach(() => {
  // oxlint-disable-next-line t3code/require-disposable-render -- headless component under this file's react-test-renderer harness, which owns the act environment
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Notification", { permission: "granted" });
  mocks.phase = "connected";
  mocks.environmentId = "env-1";
  mocks.subscribe.mockReset().mockResolvedValue({ _tag: "Success" });
  mocks.readyServiceWorker
    .mockReset()
    .mockResolvedValue({ pushManager: { getSubscription: async () => SUBSCRIPTION } });
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
});

describe("PushRegistrationSync", () => {
  it("re-sends the browser's subscription once the laptop is connected, once per page load", async () => {
    await mount();
    await rerender();
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
    expect(mocks.subscribe.mock.calls[0]?.[0]).toMatchObject({
      environmentId: "env-1",
      input: {
        endpoint: "https://web.push.apple.com/abc",
        keys: { p256dh: "BPublicKey", auth: "AuthSecret" },
      },
    });
  });

  it("re-sends once per connection", async () => {
    await mount();
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
    await rerender();
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
    mocks.phase = "reconnecting";
    await rerender();
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
    mocks.phase = "connected";
    await rerender();
    expect(mocks.subscribe).toHaveBeenCalledTimes(2);
    await rerender();
    expect(mocks.subscribe).toHaveBeenCalledTimes(2);
  });

  it("waits for the connection, then sends", async () => {
    mocks.phase = "connecting";
    await mount();
    expect(mocks.subscribe).not.toHaveBeenCalled();
    mocks.phase = "connected";
    await rerender();
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
  });

  it("sends nothing before notifications are allowed", async () => {
    vi.stubGlobal("Notification", { permission: "default" });
    await mount();
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });

  it("tries again after a reconnect when the server refused the first send", async () => {
    mocks.subscribe.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail({ message: "refused" }),
    });
    await mount();
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
    mocks.phase = "reconnecting";
    await rerender();
    mocks.phase = "connected";
    await rerender();
    expect(mocks.subscribe).toHaveBeenCalledTimes(2);
  });
});
