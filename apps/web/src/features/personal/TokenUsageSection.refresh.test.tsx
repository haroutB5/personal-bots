// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  TOKEN_USAGE_REFRESH_MS,
  TokenUsageSection,
  useTokenUsageRefresh,
} from "./TokenUsageSection";
import { TOKEN_USAGE_POLL_MS } from "./tokenUsagePresentation";

const hookState = {
  status: "ready" as "ready" | "warming" | "refreshing" | "unavailable",
  updatedAt: 0 as number | null,
  refresh: vi.fn(),
};

vi.mock("./usePersonalBots", () => ({
  usePersonalTokenUsage: () => ({
    data:
      hookState.status === "ready" || hookState.status === "refreshing"
        ? { status: hookState.status, readAt: "2026-10-04T12:00:00.000Z", windows: [] }
        : { status: hookState.status, readAt: null, windows: [] },
    dataUpdatedAt: hookState.updatedAt,
    error: null,
    isPending: false,
    isSuccess: true,
    refresh: hookState.refresh,
  }),
}));
vi.mock("@tanstack/react-router", () => ({ Link: () => null }));
vi.mock("./BotAvatar", () => ({ BotAvatar: () => null }));

const page = {
  visibility: "visible" as "visible" | "hidden",
  listeners: new Set<() => void>(),
};

function Probe({ status }: { readonly status: "ready" | "warming" }): null {
  useTokenUsageRefresh({ status, dataUpdatedAt: hookState.updatedAt, refresh: hookState.refresh });
  return null;
}

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-04T12:00:00.000Z"));
  hookState.status = "ready";
  hookState.updatedAt = Date.now();
  hookState.refresh = vi.fn();
  page.visibility = "visible";
  page.listeners = new Set();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    setInterval: (...args: Parameters<typeof setInterval>) => globalThis.setInterval(...args),
    clearInterval: (id: number) => globalThis.clearInterval(id),
  });
  vi.stubGlobal("document", {
    get visibilityState() {
      return page.visibility;
    },
    addEventListener: (_type: string, listener: () => void) => page.listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => page.listeners.delete(listener),
  });
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const mount = async (element: React.ReactElement) => {
  await act(async () => {
    renderer = create(element);
  });
};
const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const setVisibility = async (visibility: "visible" | "hidden") => {
  page.visibility = visibility;
  await act(async () => {
    for (const listener of page.listeners) listener();
  });
};

describe("token usage refresh", () => {
  it("refreshes every ten minutes while the card is open", async () => {
    await mount(
      <TokenUsageSection
        environmentId={null}
        bots={[]}
        listedBotIds={new Set()}
        modelLabels={new Map()}
      />,
    );
    await advance(TOKEN_USAGE_REFRESH_MS - 1000);
    expect(hookState.refresh).not.toHaveBeenCalled();
    await advance(1000);
    expect(hookState.refresh).toHaveBeenCalledTimes(1);
    await advance(TOKEN_USAGE_REFRESH_MS);
    expect(hookState.refresh).toHaveBeenCalledTimes(2);
  });

  it("sends nothing once the card is unmounted, however long it waits", async () => {
    await mount(
      <TokenUsageSection
        environmentId={null}
        bots={[]}
        listedBotIds={new Set()}
        modelLabels={new Map()}
      />,
    );
    await advance(TOKEN_USAGE_REFRESH_MS);
    expect(hookState.refresh).toHaveBeenCalledTimes(1);

    await act(async () => renderer?.unmount());
    renderer = undefined;
    await advance(3 * TOKEN_USAGE_REFRESH_MS);
    expect(hookState.refresh).toHaveBeenCalledTimes(1);
    // Nothing is left listening to the page either.
    expect(page.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops asking the moment the card unmounts while the server is still counting", async () => {
    hookState.status = "warming";
    await mount(
      <TokenUsageSection
        environmentId={null}
        bots={[]}
        listedBotIds={new Set()}
        modelLabels={new Map()}
      />,
    );
    await advance(TOKEN_USAGE_POLL_MS * 3);
    expect(hookState.refresh).toHaveBeenCalledTimes(3);

    await act(async () => renderer?.unmount());
    renderer = undefined;
    await advance(TOKEN_USAGE_POLL_MS * 10);
    expect(hookState.refresh).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends nothing while the page is hidden", async () => {
    await mount(<Probe status="warming" />);
    await advance(TOKEN_USAGE_POLL_MS * 2);
    expect(hookState.refresh).toHaveBeenCalledTimes(2);

    await setVisibility("hidden");
    await advance(TOKEN_USAGE_REFRESH_MS * 2);
    expect(hookState.refresh).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("asks once when the page comes back with numbers over ten minutes old, not before", async () => {
    // Fresh numbers: coming back needs nothing.
    hookState.updatedAt = Date.now();
    await mount(
      <TokenUsageSection
        environmentId={null}
        bots={[]}
        listedBotIds={new Set()}
        modelLabels={new Map()}
      />,
    );
    await setVisibility("hidden");
    await advance(5 * 60_000);
    await setVisibility("visible");
    expect(hookState.refresh).not.toHaveBeenCalled();

    await setVisibility("hidden");
    await advance(TOKEN_USAGE_REFRESH_MS);
    expect(hookState.refresh).not.toHaveBeenCalled();
    await setVisibility("visible");
    expect(hookState.refresh).toHaveBeenCalledTimes(1);
  });

  it("does not poll without a viewer: a ready card sets no short timer", async () => {
    await mount(<Probe status="ready" />);
    await advance(TOKEN_USAGE_POLL_MS * 5);
    expect(hookState.refresh).not.toHaveBeenCalled();
  });
});

describe("the query atom", () => {
  it("has no refresh timer of its own", () => {
    // An atom's refresh timer outlives its subscriber for the whole idle
    // retention, so it asked the server (which starts a scan) ten minutes after
    // the card was gone. Only the mounted card may refresh.
    const source = NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "usePersonalBots.ts"),
      "utf8",
    );
    const block = source.slice(
      source.indexOf("export const personalBotsTokenUsage"),
      source.indexOf("const refreshBotsList"),
    );
    expect(block).toContain("tag: WS_METHODS.personalBotsTokenUsage");
    expect(block).not.toMatch(/refreshIntervalMs\s*:/);
    expect(block).not.toContain("refreshTrigger");
  });
});
