import { afterEach, describe, expect, it, vi } from "vite-plus/test";

function createStorage(overrides: Partial<Storage> = {}): Storage {
  const store = new Map<string, string>();
  return {
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.doUnmock("react");
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("theme failure handling", () => {
  it("preserves exact storage causes and operation context", async () => {
    const readCause = new Error("storage read blocked");
    const writeCause = new Error("storage quota exceeded");
    vi.stubGlobal("window", {
      localStorage: createStorage({
        getItem: () => {
          throw readCause;
        },
        setItem: () => {
          throw writeCause;
        },
      }),
    });

    const { readThemePreference, ThemeStorageError, writeThemePreference } =
      await import("./useTheme");

    try {
      readThemePreference();
      expect.unreachable("expected the theme read to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ThemeStorageError);
      expect(error).toMatchObject({
        operation: "read",
        storageKey: "t3code:theme",
        cause: readCause,
      });
    }

    try {
      writeThemePreference("dark");
      expect.unreachable("expected the theme write to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ThemeStorageError);
      expect(error).toMatchObject({
        operation: "write",
        storageKey: "t3code:theme",
        theme: "dark",
        cause: writeCause,
      });
    }
  });

  it("reads the persisted T3 Chat theme preference", async () => {
    vi.stubGlobal("window", {
      localStorage: createStorage({
        getItem: () => "t3-chat",
      }),
    });

    const { readThemePreference } = await import("./useTheme");

    expect(readThemePreference()).toBe("t3-chat");
  });

  it("falls back during initial theme application and logs only safe attributes", async () => {
    const cause = new Error("private browsing storage failure");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("window", {
      localStorage: createStorage({
        getItem: () => {
          throw cause;
        },
      }),
      matchMedia: () => ({ matches: false }),
    });
    vi.stubGlobal("document", {
      documentElement: {
        classList: { toggle: vi.fn() },
      },
    });

    await expect(import("./useTheme")).resolves.toBeDefined();

    expect(errorLog).toHaveBeenCalledWith(
      "Failed to read theme preference for t3code:theme.",
      expect.objectContaining({
        operation: "read",
        storageKey: "t3code:theme",
        errorTag: "ThemeStorageError",
      }),
    );
    const attributes = errorLog.mock.calls[0]?.[1];
    expect(attributes).not.toHaveProperty("cause");
    expect(JSON.stringify(attributes)).not.toContain(cause.message);
  });

  it("retries a failed storage read only after a relevant storage event", async () => {
    const cause = new Error("persistent storage failure");
    const themeGetItem = vi.fn((): string | null => {
      throw cause;
    });
    const getItem = vi.fn((key: string) => (key === "t3code:theme" ? themeGetItem() : null));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    let readSnapshot: (() => unknown) | undefined;
    let subscribeToTheme: ((listener: () => void) => () => void) | undefined;
    let storageHandler: ((event: StorageEvent) => void) | undefined;
    vi.doMock("react", () => ({
      useCallback: <A>(callback: A) => callback,
      useEffect: () => undefined,
      useSyncExternalStore: (
        subscribe: (listener: () => void) => () => void,
        getSnapshot: () => unknown,
      ) => {
        subscribeToTheme = subscribe;
        readSnapshot = getSnapshot;
        return getSnapshot();
      },
    }));
    vi.stubGlobal("window", {
      addEventListener: (type: string, listener: (event: StorageEvent) => void) => {
        if (type === "storage") storageHandler = listener;
      },
      localStorage: createStorage({ getItem }),
      matchMedia: () => ({
        matches: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
      removeEventListener: () => undefined,
    });

    const { useTheme } = await import("./useTheme");
    useTheme();
    readSnapshot?.();
    readSnapshot?.();

    expect(themeGetItem).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledTimes(1);

    const unsubscribe = subscribeToTheme?.(() => undefined);
    storageHandler?.({ key: "t3code:theme" } as StorageEvent);
    readSnapshot?.();

    expect(themeGetItem).toHaveBeenCalledTimes(2);
    expect(errorLog).toHaveBeenCalledTimes(2);
    unsubscribe?.();
  });

  it("preserves desktop sync causes and retries after a failed cosmetic sync", async () => {
    const cause = new Error("desktop IPC unavailable");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const setTheme = vi.fn().mockRejectedValue(cause);
    vi.stubGlobal("window", { desktopBridge: { setTheme } });

    const { DesktopThemeSyncError, syncDesktopTheme, syncDesktopThemePreference } =
      await import("./useTheme");

    const error = await syncDesktopThemePreference({ setTheme }, "dark").then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(DesktopThemeSyncError);
    expect(error).toMatchObject({ theme: "dark", cause });

    setTheme.mockClear();
    syncDesktopTheme("dark");
    await Promise.resolve();
    await Promise.resolve();
    syncDesktopTheme("dark");
    await Promise.resolve();
    await Promise.resolve();

    expect(setTheme).toHaveBeenCalledTimes(2);
    expect(errorLog).toHaveBeenCalledWith(
      "Failed to sync the dark theme to the desktop shell.",
      expect.objectContaining({
        theme: "dark",
        errorTag: "DesktopThemeSyncError",
      }),
    );
    for (const [, attributes] of errorLog.mock.calls) {
      expect(attributes).not.toHaveProperty("cause");
      expect(JSON.stringify(attributes)).not.toContain(cause.message);
    }
  });
});

describe("browser chrome colour", () => {
  function stubChromePage(options: { tokenColor: string; bodyInlineColor: string }) {
    const metas = [{ content: "#ffffff", setAttribute: vi.fn() }];
    metas[0]!.setAttribute.mockImplementation((_name: string, value: string) => {
      metas[0]!.content = value;
    });
    const documentElement = { dataset: {}, style: { backgroundColor: "#ffffff" } };
    const body = { style: { backgroundColor: options.bodyInlineColor } };
    vi.stubGlobal("document", {
      documentElement,
      body,
      head: { append: () => undefined },
      querySelector: () => null,
      querySelectorAll: () => metas,
    });
    // The body reads back whatever inline colour is on it, exactly like a browser.
    vi.stubGlobal("getComputedStyle", (element: unknown) => ({
      backgroundColor: element === body ? body.style.backgroundColor : "rgba(0, 0, 0, 0)",
      getPropertyValue: (name: string) =>
        name === "--app-chrome-background" ? options.tokenColor : "",
    }));
    return { metas, documentElement, body };
  }

  it("takes the theme token on a page with no sidebar, not the inline colour it wrote earlier", async () => {
    // Import first: the module applies the theme on load when it sees a document.
    const { syncBrowserChromeTheme } = await import("./useTheme");
    const page = stubChromePage({ tokenColor: "#0a0a0a", bodyInlineColor: "#ffffff" });

    syncBrowserChromeTheme();

    expect(page.metas[0]!.content).toBe("#0a0a0a");
    expect(page.documentElement.style.backgroundColor).toBe("#0a0a0a");
    expect(page.body.style.backgroundColor).toBe("#0a0a0a");
  });

  it("follows the token when the appearance changes, instead of freezing the first colour", async () => {
    const { syncBrowserChromeTheme } = await import("./useTheme");
    const page = stubChromePage({ tokenColor: "#ffffff", bodyInlineColor: "" });
    syncBrowserChromeTheme();
    expect(page.body.style.backgroundColor).toBe("#ffffff");

    const getComputed = globalThis.getComputedStyle;
    vi.stubGlobal("getComputedStyle", (element: unknown) => {
      const styles = getComputed(element as Element);
      return {
        backgroundColor: styles.backgroundColor,
        getPropertyValue: (name: string) => (name === "--app-chrome-background" ? "#0a0a0a" : ""),
      };
    });
    syncBrowserChromeTheme();

    expect(page.metas[0]!.content).toBe("#0a0a0a");
    expect(page.body.style.backgroundColor).toBe("#0a0a0a");
  });
});
