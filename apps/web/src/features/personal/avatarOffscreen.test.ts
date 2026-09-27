import { afterEach, describe, expect, it, vi } from "vite-plus/test";

type Callback = (entries: Array<{ target: FakeElement; isIntersecting: boolean }>) => void;

class FakeElement {
  readonly attributes = new Set<string>();
  toggleAttribute(name: string, force: boolean) {
    if (force) this.attributes.add(name);
    else this.attributes.delete(name);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("pauseWhileOffscreen", () => {
  it("marks an avatar off screen while it is out of view, and clears it when unwatched", async () => {
    let callback: Callback | null = null;
    const observed = new Set<FakeElement>();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: Callback) {
          callback = cb;
        }
        observe(element: FakeElement) {
          observed.add(element);
        }
        unobserve(element: FakeElement) {
          observed.delete(element);
        }
      },
    );
    const { pauseWhileOffscreen } = await import("./avatarOffscreen");
    const first = new FakeElement();
    const second = new FakeElement();
    const stopFirst = pauseWhileOffscreen(first as unknown as Element);
    pauseWhileOffscreen(second as unknown as Element);
    expect(observed.size).toBe(2);

    callback!([
      { target: first, isIntersecting: false },
      { target: second, isIntersecting: true },
    ]);
    expect(first.attributes.has("data-offscreen")).toBe(true);
    expect(second.attributes.has("data-offscreen")).toBe(false);

    callback!([{ target: first, isIntersecting: true }]);
    expect(first.attributes.has("data-offscreen")).toBe(false);

    callback!([{ target: first, isIntersecting: false }]);
    stopFirst();
    expect(first.attributes.has("data-offscreen")).toBe(false);
    expect(observed.has(first)).toBe(false);
  });

  it("does nothing where IntersectionObserver is missing", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const { pauseWhileOffscreen } = await import("./avatarOffscreen");
    const element = new FakeElement();
    const stop = pauseWhileOffscreen(element as unknown as Element);
    stop();
    expect(element.attributes.size).toBe(0);
  });
});
