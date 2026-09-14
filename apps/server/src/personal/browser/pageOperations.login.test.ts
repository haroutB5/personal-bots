import { describe, expect, it } from "vite-plus/test";

import type { BrowserElementHandle, BrowserPage } from "./driver.ts";
import { performFillLogin } from "./pageOperations.ts";

interface FakeOptions {
  /** Called when the password handle is resolved; lets a test navigate first. */
  readonly onResolve?: () => void;
  readonly crossOriginAction?: boolean;
  readonly detached?: boolean;
}

const makePage = (url: string, options: FakeOptions = {}) => {
  const typed: Array<{ readonly locator: string | null; readonly text: string }> = [];
  const filled: Array<{ readonly locator: string; readonly text: string }> = [];
  const disposed: string[] = [];
  let currentUrl = url;
  const page = {
    url: () => currentUrl,
    countLocator: async (locator: string) => {
      if (locator.includes("[action")) return options.crossOriginAction === true ? 1 : 0;
      if (locator.startsWith("form:has(:focus)")) return 0;
      if (locator === 'form:has(input[type="password"]:visible:not([disabled]))') return 1;
      if (locator.includes('input[autocomplete="username"]')) return 1;
      if (locator.includes('input[type="password"]')) return 1;
      return 0;
    },
    typeText: async (input: { readonly locator: string | null; readonly text: string }) => {
      typed.push(input);
    },
    resolveElement: async (locator: string): Promise<BrowserElementHandle | null> => {
      options.onResolve?.();
      return {
        fill: async (text: string) => {
          // Playwright invalidates a handle whose element left the document.
          if (options.detached === true) throw new Error("Element is not attached to the DOM");
          filled.push({ locator, text });
        },
        dispose: async () => {
          disposed.push(locator);
        },
      };
    },
  } as unknown as BrowserPage;
  return { page, typed, filled, disposed, navigate: (next: string) => (currentUrl = next) };
};

describe("saved-login browser fill", () => {
  it("targets username then password fields without returning either value", async () => {
    const fake = makePage("https://example.com/sign-in");
    const result = await performFillLogin(
      fake.page,
      {
        expectedOrigin: "https://example.com",
        username: "person@example.com",
        password: "not-model-visible",
      },
      1_000,
    );

    expect(result).toEqual(["username", "password"]);
    expect(fake.typed).toHaveLength(1);
    expect(fake.typed[0]?.locator).toContain('input[autocomplete="username"]');
    expect(fake.filled).toHaveLength(1);
    expect(fake.filled[0]?.locator).toContain('input[type="password"]');
    expect(fake.disposed).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("person@example.com");
    expect(JSON.stringify(result)).not.toContain("not-model-visible");
  });

  it("refuses subdomains because the current origin must match exactly", async () => {
    const fake = makePage("https://login.example.com/sign-in");

    await expect(
      performFillLogin(
        fake.page,
        {
          expectedOrigin: "https://example.com",
          username: "person@example.com",
          password: "password-value",
        },
        1_000,
      ),
    ).rejects.toThrow("only be used on https://example.com");
    expect(fake.typed).toEqual([]);
    expect(fake.filled).toEqual([]);
  });

  it("rechecks origin after username entry before typing the password", async () => {
    const fake = makePage("https://example.com/sign-in");
    fake.page.typeText = async (input) => {
      fake.typed.push(input);
      fake.navigate("https://attacker.example/sign-in");
    };

    await expect(
      performFillLogin(
        fake.page,
        {
          expectedOrigin: "https://example.com",
          username: "person@example.com",
          password: "password-value",
        },
        1_000,
      ),
    ).rejects.toThrow("only be used on https://example.com");
    expect(fake.typed).toHaveLength(1);
    expect(fake.typed[0]?.text).toBe("person@example.com");
    expect(fake.filled).toEqual([]);
  });

  // I2: a navigation that lands *after* the last origin check used to be
  // survivable, because a locator re-resolves onto whatever page is current.
  it("aborts when the page navigates between the origin check and the fill", async () => {
    const fake = makePage("https://example.com/sign-in", { detached: true });

    await expect(
      performFillLogin(
        fake.page,
        {
          expectedOrigin: "https://example.com",
          username: "person@example.com",
          password: "password-value",
        },
        1_000,
      ),
    ).rejects.toThrow("became unavailable");
    expect(fake.filled).toEqual([]);
    // The handle is released even on the abort path.
    expect(fake.disposed).toHaveLength(1);
  });

  it("checks the origin again after the password handle is resolved", async () => {
    // An SSO redirect that completes while the handle is being resolved.
    let navigate: (url: string) => void = () => undefined;
    const redirecting = makePage("https://example.com/sign-in", {
      onResolve: () => navigate("https://accounts.idp.com/"),
    });
    navigate = redirecting.navigate;

    await expect(
      performFillLogin(
        redirecting.page,
        {
          expectedOrigin: "https://example.com",
          username: "person@example.com",
          password: "password-value",
        },
        1_000,
      ),
    ).rejects.toThrow("only be used on https://example.com");
    expect(redirecting.filled).toEqual([]);
  });

  // I4: origin equality ignores the path, and the model picks the page, so a
  // form on the granted origin that posts elsewhere is not a fill target.
  it("refuses a login form whose action posts to another origin", async () => {
    const fake = makePage("https://example.com/user-content/page", { crossOriginAction: true });

    await expect(
      performFillLogin(
        fake.page,
        {
          expectedOrigin: "https://example.com",
          username: "person@example.com",
          password: "password-value",
        },
        1_000,
      ),
    ).rejects.toThrow("submits to a different origin");
    expect(fake.typed).toEqual([]);
    expect(fake.filled).toEqual([]);
  });
});
