import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { AvatarOrbitLayer } from "../BotAvatar";
import { PcAvatar } from "./PcAvatar";

/*
 * The comet is handed in by ComputerScreen, never imported by the lazy pane
 * (1.67.2: importing it made rolldown hoist a shared chunk, +1 request on
 * every app open). These cases pin the contract PcAvatar promises its caller.
 */
describe("PcAvatar comet hand-off", () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(() => {
    act(() => {
      renderer?.unmount();
    });
    renderer = null;
    vi.unstubAllGlobals();
  });

  const comet = <AvatarOrbitLayer shape="roundedSquare" />;

  it("draws the handed-in comet only while busy", () => {
    act(() => {
      renderer = create(<PcAvatar pose="busy" orbit={comet} />);
    });
    const busy = JSON.stringify(renderer!.toJSON());
    expect(busy).toContain("bot-avatar-orbit");
    expect(busy).toContain("bot-avatar-ring bot-avatar-ring-roundedSquare-0");

    for (const pose of ["calm", "paused", "strain"] as const) {
      act(() => {
        renderer!.update(<PcAvatar pose={pose} orbit={comet} />);
      });
      expect(JSON.stringify(renderer!.toJSON())).not.toContain("bot-avatar-orbit");
    }
  });

  it("stays a plain avatar when no comet is handed in", () => {
    act(() => {
      renderer = create(<PcAvatar pose="busy" />);
    });
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("bot-avatar-orbit");
  });
});
