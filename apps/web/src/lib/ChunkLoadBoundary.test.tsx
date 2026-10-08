import { lazy, Suspense } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ChunkLoadBoundary } from "./ChunkLoadBoundary";

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // React logs a caught render error; the tests below expect them.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const render = async (element: React.ReactElement) => {
  await act(async () => {
    renderer = create(element);
  });
  return JSON.stringify(renderer?.toJSON());
};

describe("ChunkLoadBoundary", () => {
  it("draws its children when nothing fails", async () => {
    const out = await render(
      <ChunkLoadBoundary>
        <p>team</p>
      </ChunkLoadBoundary>,
    );
    expect(out).toContain("team");
  });

  it("holds a lazy piece whose code cannot be fetched and draws nothing for it, leaving the rest", async () => {
    const Broken = lazy(() =>
      Promise.reject(new TypeError("Failed to fetch dynamically imported module: /assets/x.js")),
    );
    const out = await render(
      <div>
        <p>chat</p>
        <ChunkLoadBoundary>
          <Suspense fallback={null}>
            <Broken />
          </Suspense>
        </ChunkLoadBoundary>
      </div>,
    );
    expect(out).toContain("chat");
    expect(out).not.toContain("Failed to fetch");
  });

  it("draws the fallback when one is given", async () => {
    const Broken = lazy(() => Promise.reject(new TypeError("Importing a module script failed.")));
    const out = await render(
      <ChunkLoadBoundary fallback={<span>unavailable</span>}>
        <Suspense fallback={null}>
          <Broken />
        </Suspense>
      </ChunkLoadBoundary>,
    );
    expect(out).toContain("unavailable");
  });

  it("does not hide any other error: it goes on to the next error screen", async () => {
    const Bug = () => {
      throw new Error("x is not a function");
    };
    await expect(
      render(
        <ChunkLoadBoundary>
          <Bug />
        </ChunkLoadBoundary>,
      ),
    ).rejects.toThrow("x is not a function");
  });
});
