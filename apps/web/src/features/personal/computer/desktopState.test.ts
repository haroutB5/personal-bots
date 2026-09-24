import type { PersonalDesktopStatus } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: () => ({}),
  createEnvironmentRpcSubscriptionAtomFamily: () => () => ({}),
}));
vi.mock("~/connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("~/state/query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));

import { desktopHolderLine, desktopStreamUrl } from "./desktopState";

const STATUS: PersonalDesktopStatus = {
  available: true,
  holder: null,
  waiting: [],
  lastStop: null,
  stopHotkey: "Esc",
};

describe("desktop live view helpers", () => {
  it("builds the stream URL from the Computer tab's access, keeping a relay prefix and the ticket", () => {
    expect(
      desktopStreamUrl({
        httpBase: "https://relay.example/env/abc/api/personal/browser",
        wsBase: "wss://relay.example/env/abc/api/personal/browser",
        query: { wsTicket: "t-1" },
        credentials: false,
      }),
    ).toBe("wss://relay.example/env/abc/api/personal/desktop/stream?wsTicket=t-1");
    expect(
      desktopStreamUrl({
        httpBase: "https://pc.local/api/personal/browser",
        wsBase: "wss://pc.local/api/personal/browser",
        query: {},
        credentials: true,
      }),
    ).toBe("wss://pc.local/api/personal/desktop/stream");
    expect(
      desktopStreamUrl({
        httpBase: "x",
        wsBase: "wss://pc.local/other",
        query: {},
        credentials: true,
      }),
    ).toBeNull();
  });

  it("says who is using the PC, and who waits", () => {
    expect(desktopHolderLine(null).text).toBe("Checking the PC");
    expect(desktopHolderLine(STATUS)).toEqual({ text: "No bot is using your PC", busy: false });
    expect(
      desktopHolderLine({
        ...STATUS,
        holder: {
          threadId: "t1",
          botId: "b1",
          botName: "Assistant",
          since: "2026-09-24T07:00:00.000Z",
          lastActionAt: "2026-09-24T07:00:05.000Z",
        },
        waiting: [{ threadId: "t2", botId: "b2", botName: "IT" }],
      }),
    ).toEqual({ text: "Assistant is using your PC · 1 waiting", busy: true });
    expect(desktopHolderLine({ ...STATUS, available: false }).busy).toBe(false);
  });
});
