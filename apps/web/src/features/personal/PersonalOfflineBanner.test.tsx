import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";

import { enqueueOutboxEntry, resetOutboxForTesting } from "./outbox";
import { PersonalOfflineBanner } from "./PersonalOfflineBanner";
import {
  publishUpdateRestartSignal,
  resetUpdateRestartSignalForTesting,
  RESTART_BANNER_GRACE_MS,
  RESTART_EXPECTED_WINDOW_MS,
} from "./updateStatus";

const connection = vi.hoisted(() => ({ phase: "connected" as EnvironmentConnectionPhase }));
vi.mock("~/state/environments", () => ({ useEnvironment: () => ({ connection }) }));
vi.mock("./usePersonalBots", () => ({ usePersonalEnvironmentId: () => "test-environment" }));

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  resetUpdateRestartSignalForTesting();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("reconnect banner", () => {
  it("stays quiet during a brief resume but explains a prolonged reconnection", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", globalThis);
    connection.phase = "reconnecting";
    await act(async () => {
      renderer = create(<PersonalOfflineBanner pathname="/bots" />);
    });
    expect(renderer!.toJSON()).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(1_499);
    });
    expect(renderer!.toJSON()).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Reconnecting to your laptop");
    connection.phase = "connected";
    await act(async () => renderer!.update(<PersonalOfflineBanner pathname="/bots" />));
    expect(renderer!.toJSON()).toBeNull();
    connection.phase = "reconnecting";
    await act(async () => renderer!.update(<PersonalOfflineBanner pathname="/bots" />));
    expect(renderer!.toJSON()).toBeNull();
  });
});

describe("banner while an update is landing", () => {
  it("steps aside on the Bots page for the calm update line, and comes back when the restart runs long", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", globalThis);
    connection.phase = "reconnecting";
    const startedAt = Date.now();
    publishUpdateRestartSignal(
      { phase: "activating", version: "1.66.34", atMs: startedAt - 30_000 },
      true,
      startedAt,
    );
    await act(async () => {
      renderer = create(<PersonalOfflineBanner pathname="/bots" />);
    });
    // Well past the reconnect debounce, and still quiet: the update line speaks.
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(renderer!.toJSON()).toBeNull();
    // Five minutes of "Restarting for update" is no longer a normal restart.
    await act(async () => {
      vi.advanceTimersByTime(RESTART_BANNER_GRACE_MS - 5_000 + 100);
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Reconnecting to your laptop");
  });

  it("leaves every other page exactly as it was, even mid-update", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", globalThis);
    connection.phase = "reconnecting";
    const startedAt = Date.now();
    publishUpdateRestartSignal(
      { phase: "activating", version: "1.66.34", atMs: startedAt - 30_000 },
      true,
      startedAt,
    );
    await act(async () => {
      renderer = create(<PersonalOfflineBanner pathname="/bots/team" />);
    });
    await act(async () => {
      vi.advanceTimersByTime(1_500);
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Reconnecting to your laptop");
  });

  it("comes back on the Bots page once the phase it was waiting on is stale", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", globalThis);
    connection.phase = "reconnecting";
    const startedAt = Date.now();
    publishUpdateRestartSignal(
      { phase: "backing_up", version: null, atMs: startedAt - RESTART_EXPECTED_WINDOW_MS - 1 },
      true,
      startedAt,
    );
    await act(async () => {
      renderer = create(<PersonalOfflineBanner pathname="/bots" />);
    });
    await act(async () => {
      vi.advanceTimersByTime(1_500);
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Reconnecting to your laptop");
  });
});

describe("banner while messages wait", () => {
  it("tells the owner messages go out when the laptop is back, and how many are waiting", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", globalThis);
    resetOutboxForTesting(null);
    connection.phase = "offline";
    await act(async () => {
      renderer = create(<PersonalOfflineBanner pathname="/bots" />);
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain(
      "Messages you send will go out when it reconnects.",
    );
    enqueueOutboxEntry({
      id: "m1",
      kind: "turn",
      environmentId: "test-environment",
      threadId: "t1",
      groupId: null,
      text: "hi",
      sendText: "hi",
      createdAt: "2026-10-08T12:00:00.000Z",
      replyTo: null,
      turn: null,
      attachments: [],
    });
    await act(async () => renderer!.update(<PersonalOfflineBanner pathname="/bots" />));
    expect(JSON.stringify(renderer!.toJSON())).toContain(
      "1 message is waiting to send. It goes out when it reconnects.",
    );
    connection.phase = "connected";
    await act(async () => renderer!.update(<PersonalOfflineBanner pathname="/bots" />));
    expect(renderer!.toJSON()).toBeNull();
    resetOutboxForTesting(undefined);
  });
});
