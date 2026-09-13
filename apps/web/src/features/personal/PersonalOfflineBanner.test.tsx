import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";

import { PersonalOfflineBanner } from "./PersonalOfflineBanner";

const connection = vi.hoisted(() => ({ phase: "connected" as EnvironmentConnectionPhase }));
vi.mock("~/state/environments", () => ({ useEnvironment: () => ({ connection }) }));
vi.mock("./usePersonalBots", () => ({ usePersonalEnvironmentId: () => "test-environment" }));

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
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
      renderer = create(<PersonalOfflineBanner />);
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
    await act(async () => renderer!.update(<PersonalOfflineBanner />));
    expect(renderer!.toJSON()).toBeNull();
    connection.phase = "reconnecting";
    await act(async () => renderer!.update(<PersonalOfflineBanner />));
    expect(renderer!.toJSON()).toBeNull();
  });
});
