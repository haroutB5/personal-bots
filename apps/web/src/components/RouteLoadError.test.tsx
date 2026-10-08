import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const invalidate = vi.fn(async () => undefined);
vi.mock("@tanstack/react-router", () => ({
  ErrorComponent: ({ error }: { error: Error }) => <pre>router default: {error.message}</pre>,
  useRouter: () => ({ invalidate }),
}));

const whenServerBack = vi.fn((_callback: () => void) => () => undefined);
vi.mock("../lib/chunkLoadRecovery", () => ({
  chunkRecovery: () => ({ whenServerBack }),
}));

const reloadOnce = vi.fn(() => true);
vi.mock("../lib/chunkReloadGuard", () => ({
  reloadOnceForChunkLoadError: () => reloadOnce(),
}));

import { RouteLoadError } from "./RouteLoadError";

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  invalidate.mockClear();
  whenServerBack.mockClear();
  reloadOnce.mockReset();
  reloadOnce.mockReturnValue(true);
});
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

const render = async (error: unknown, reset = vi.fn()) => {
  await act(async () => {
    renderer = create(
      <RouteLoadError error={error as Error} reset={reset} info={{ componentStack: "" }} />,
    );
  });
  return { text: JSON.stringify(renderer?.toJSON()), reset };
};

describe("RouteLoadError", () => {
  it("tells a screen whose code could not be fetched so, in place, and not as a crash", async () => {
    const { text } = await render(
      new TypeError("Failed to fetch dynamically imported module: /assets/Team-1.js"),
    );
    expect(text).toContain("This screen isn't on your phone yet");
    expect(text).toContain("Try again");
    expect(text).not.toContain("router default");
  });

  it("waits for the server, then reloads once to fetch the screen's code fresh", async () => {
    await render(new TypeError("Importing a module script failed."));
    expect(whenServerBack).toHaveBeenCalledTimes(1);
    const back = whenServerBack.mock.calls[0]?.[0];
    back?.();
    expect(reloadOnce).toHaveBeenCalledTimes(1);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("if the one reload was already spent, asks the router to load the screen again", async () => {
    reloadOnce.mockReturnValue(false);
    const { reset } = await render(new TypeError("Importing a module script failed."));
    whenServerBack.mock.calls[0]?.[0]?.();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("Try again resets the screen and asks the router to load it again", async () => {
    const { reset } = await render(new TypeError("Importing a module script failed."));
    const button = renderer?.root.findByType("button");
    await act(async () => button?.props.onClick());
    expect(reset).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("keeps the router's own screen for every other error", async () => {
    const { text } = await render(new Error("x is not a function"));
    expect(text).toContain("router default");
    expect(text).not.toContain("isn't on your phone yet");
    expect(whenServerBack).not.toHaveBeenCalled();
  });
});
