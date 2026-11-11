import { describe, expect, it, vi } from "vite-plus/test";

import { resyncPushSubscription, subscribeInputFrom } from "./pushRegistrationSync";

const KEYS = { p256dh: "BPublicKey", auth: "AuthSecret" };
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)";

const registrationWith = (existing: { toJSON: () => PushSubscriptionJSON } | null) => {
  const subscribe = vi.fn();
  return {
    subscribe,
    registration: {
      pushManager: { getSubscription: async () => existing, subscribe },
    },
  };
};

const run = async (overrides: {
  permission?: NotificationPermission | "unsupported";
  existing?: { toJSON: () => PushSubscriptionJSON } | null;
  registration?: "none";
}) => {
  const { registration, subscribe: pushManagerSubscribe } = registrationWith(
    overrides.existing === undefined ? null : overrides.existing,
  );
  const send = vi.fn().mockResolvedValue(null);
  const outcome = await resyncPushSubscription({
    permission: overrides.permission ?? "granted",
    userAgent: IPHONE,
    getRegistration: async () => (overrides.registration === "none" ? null : registration),
    send,
  });
  return { outcome, send, pushManagerSubscribe };
};

describe("re-sending the browser's existing subscription", () => {
  it("sends the endpoint and keys the browser already holds, labelled by device", async () => {
    const { outcome, send, pushManagerSubscribe } = await run({
      existing: {
        toJSON: () => ({ endpoint: "https://web.push.apple.com/abc", keys: KEYS }),
      },
    });
    expect(outcome).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      endpoint: "https://web.push.apple.com/abc",
      keys: KEYS,
      deviceLabel: "iPhone",
    });
    expect(pushManagerSubscribe).not.toHaveBeenCalled();
  });

  it("does nothing while permission has not been granted, and never prompts", async () => {
    for (const permission of ["default", "denied", "unsupported"] as const) {
      const { outcome, send, pushManagerSubscribe } = await run({
        permission,
        existing: { toJSON: () => ({ endpoint: "https://web.push.apple.com/abc", keys: KEYS }) },
      });
      expect(outcome).toBe("skipped");
      expect(send).not.toHaveBeenCalled();
      expect(pushManagerSubscribe).not.toHaveBeenCalled();
    }
  });

  it("creates no subscription when the browser has none", async () => {
    const { outcome, send, pushManagerSubscribe } = await run({ existing: null });
    expect(outcome).toBe("skipped");
    expect(send).not.toHaveBeenCalled();
    expect(pushManagerSubscribe).not.toHaveBeenCalled();
  });

  it("does nothing when no background worker is running", async () => {
    const { outcome, send } = await run({ registration: "none" });
    expect(outcome).toBe("skipped");
    expect(send).not.toHaveBeenCalled();
  });

  it("does nothing for an incomplete subscription", async () => {
    const { outcome, send } = await run({
      existing: { toJSON: () => ({ endpoint: "https://web.push.apple.com/abc" }) },
    });
    expect(outcome).toBe("skipped");
    expect(send).not.toHaveBeenCalled();
  });

  it("reports a send that the server refused", async () => {
    const { registration } = registrationWith({
      toJSON: () => ({ endpoint: "https://web.push.apple.com/abc", keys: KEYS }),
    });
    const outcome = await resyncPushSubscription({
      permission: "granted",
      userAgent: IPHONE,
      getRegistration: async () => registration,
      send: async () => "This sign-in cannot register for notifications.",
    });
    expect(outcome).toBe("failed");
  });
});

describe("subscribeInputFrom", () => {
  it("builds the server input, and refuses a subscription missing its endpoint or keys", () => {
    expect(
      subscribeInputFrom({ endpoint: "https://web.push.apple.com/abc", keys: KEYS }, IPHONE),
    ).toEqual({ endpoint: "https://web.push.apple.com/abc", keys: KEYS, deviceLabel: "iPhone" });
    expect(subscribeInputFrom({ keys: KEYS }, IPHONE)).toBeNull();
    expect(
      subscribeInputFrom(
        { endpoint: "https://web.push.apple.com/abc", keys: { auth: "a" } },
        IPHONE,
      ),
    ).toBeNull();
  });
});
