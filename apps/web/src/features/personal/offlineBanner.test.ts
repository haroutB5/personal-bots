import { describe, expect, it } from "vite-plus/test";

import {
  offlineBannerHiddenForRestart,
  offlineBannerHint,
  offlineBannerText,
  offlineComposerNotice,
} from "./offlineBanner";
import {
  applicationServerKeyFrom,
  isNavigablePath,
  shouldRegisterServiceWorker,
} from "./serviceWorker";
import {
  RESTART_BANNER_GRACE_MS,
  RESTART_EXPECTED_WINDOW_MS,
  type LastSeenPhase,
} from "./updateStatus";

const NOW = Date.parse("2026-09-14T12:00:00Z");

describe("offlineBannerText", () => {
  it("is silent while connected and on the first cold connect", () => {
    expect(offlineBannerText("connected", NOW - 5_000, NOW)).toBeNull();
    expect(offlineBannerText("connecting", null, NOW)).toBeNull();
    expect(offlineBannerText("connecting", NOW - 60_000, NOW)).toBeNull();
    expect(offlineBannerText("available", NOW - 60_000, NOW)).toBeNull();
  });

  it("states the last contact once the laptop is unreachable", () => {
    expect(offlineBannerText("reconnecting", NOW - 5 * 60_000, NOW)).toBe(
      "Reconnecting to your laptop…",
    );
    expect(offlineBannerText("offline", NOW - 10_000, NOW)).toBe(
      "Laptop offline · last contact just now",
    );
    expect(offlineBannerText("error", Date.parse("2026-09-13T20:00:00Z"), NOW)).toBe(
      "Laptop offline · last contact Yesterday",
    );
    expect(offlineBannerText("offline", null, NOW)).toBe("Laptop offline");
  });
});

describe("what the banner and composer promise while the laptop is away", () => {
  it("the composer says a sent message is kept and goes out on reconnect, never that it is blocked", () => {
    expect(offlineComposerNotice("connected")).toBeNull();
    for (const phase of ["offline", "error"] as const) {
      expect(offlineComposerNotice(phase)).toBe(
        "Your laptop is offline. Messages you send now are saved on this device and go out when it reconnects.",
      );
    }
    for (const phase of ["connecting", "reconnecting", "available"] as const) {
      expect(offlineComposerNotice(phase)).toBe(
        "Reconnecting to your laptop. Messages you send now are saved here and go out when it's back.",
      );
    }
  });

  it("the banner hint says messages send when it reconnects, and counts the waiting ones", () => {
    expect(offlineBannerHint(0)).toBe("Messages you send will go out when it reconnects.");
    expect(offlineBannerHint(1)).toBe(
      "1 message is waiting to send. It goes out when it reconnects.",
    );
    expect(offlineBannerHint(3)).toBe(
      "3 messages are waiting to send. They go out when it reconnects.",
    );
  });
});

describe("offlineBannerHiddenForRestart", () => {
  const seen = (overrides: Partial<LastSeenPhase> = {}): LastSeenPhase => ({
    phase: "waiting_for_idle",
    version: "1.66.34",
    atMs: NOW,
    ...overrides,
  });
  const onBots = { pathname: "/bots", lastSeen: seen(), restartingSinceMs: NOW };

  it("steps aside only on the Bots page", () => {
    expect(offlineBannerHiddenForRestart({ ...onBots, nowMs: NOW + 60_000 })).toBe(true);
    expect(offlineBannerHiddenForRestart({ ...onBots, pathname: "/bots/", nowMs: NOW })).toBe(true);
    for (const pathname of ["/bots/team", "/bots/chats/abc", "/tasks", "/computer", "/files"]) {
      expect(offlineBannerHiddenForRestart({ ...onBots, pathname, nowMs: NOW })).toBe(false);
    }
  });

  it("steps aside as soon as the update is armed, before any restarting words", () => {
    expect(
      offlineBannerHiddenForRestart({
        pathname: "/bots",
        lastSeen: seen({ phase: "backing_up" }),
        restartingSinceMs: null,
        nowMs: NOW + 30_000,
      }),
    ).toBe(true);
  });

  it("comes back five minutes after the line went to restarting", () => {
    expect(
      offlineBannerHiddenForRestart({ ...onBots, nowMs: NOW + RESTART_BANNER_GRACE_MS - 1 }),
    ).toBe(true);
    expect(offlineBannerHiddenForRestart({ ...onBots, nowMs: NOW + RESTART_BANNER_GRACE_MS })).toBe(
      false,
    );
  });

  it("comes back once the phase it was waiting on is stale, or was never a restart", () => {
    expect(
      offlineBannerHiddenForRestart({
        pathname: "/bots",
        lastSeen: seen({ atMs: NOW - RESTART_EXPECTED_WINDOW_MS - 1 }),
        restartingSinceMs: NOW,
        nowMs: NOW,
      }),
    ).toBe(false);
    for (const phase of ["smoking", "live_verified", "rolled_back"]) {
      expect(
        offlineBannerHiddenForRestart({
          pathname: "/bots",
          lastSeen: seen({ phase }),
          restartingSinceMs: NOW,
          nowMs: NOW,
        }),
      ).toBe(false);
    }
    expect(
      offlineBannerHiddenForRestart({
        pathname: "/bots",
        lastSeen: null,
        restartingSinceMs: NOW,
        nowMs: NOW,
      }),
    ).toBe(false);
  });
});

describe("service worker gating", () => {
  it("registers only in production, on a secure origin, outside Electron", () => {
    const base = { production: true, secureContext: true, electron: false, supported: true };
    expect(shouldRegisterServiceWorker(base)).toBe(true);
    expect(shouldRegisterServiceWorker({ ...base, production: false })).toBe(false);
    expect(shouldRegisterServiceWorker({ ...base, secureContext: false })).toBe(false);
    expect(shouldRegisterServiceWorker({ ...base, electron: true })).toBe(false);
    expect(shouldRegisterServiceWorker({ ...base, supported: false })).toBe(false);
  });

  it("accepts only same-origin paths from the worker", () => {
    expect(isNavigablePath("/tasks/abc")).toBe(true);
    expect(isNavigablePath("//evil.example/x")).toBe(false);
    expect(isNavigablePath("/\\evil.example/x")).toBe(false);
    expect(isNavigablePath("/\n/evil.example/x")).toBe(false);
    expect(isNavigablePath("https://evil.example/x")).toBe(false);
    expect(isNavigablePath(42)).toBe(false);
  });

  it("decodes a base64url VAPID key into its 65 raw bytes", () => {
    const key =
      "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
    const bytes = applicationServerKeyFrom(key);
    expect(bytes.length).toBe(65);
    expect(bytes[0]).toBe(0x04);
  });
});
