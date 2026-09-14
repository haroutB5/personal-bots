import { describe, expect, it } from "vite-plus/test";

import type { BrowserPage } from "./driver.ts";
import { performFillLogin } from "./pageOperations.ts";

const makePage = (url: string) => {
  const typed: Array<{ readonly locator: string | null; readonly text: string }> = [];
  let currentUrl = url;
  const page = {
    url: () => currentUrl,
    countLocator: async (locator: string) => {
      if (locator.startsWith("form:has(:focus)")) return 0;
      if (locator === 'form:has(input[type="password"]:visible:not([disabled]))') return 1;
      if (locator.includes('input[autocomplete="username"]')) return 1;
      if (locator.includes('input[type="password"]')) return 1;
      return 0;
    },
    typeText: async (input: { readonly locator: string | null; readonly text: string }) => {
      typed.push(input);
    },
  } as unknown as BrowserPage;
  return { page, typed, navigate: (next: string) => (currentUrl = next) };
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
    expect(fake.typed).toHaveLength(2);
    expect(fake.typed[0]?.locator).toContain('input[autocomplete="username"]');
    expect(fake.typed[1]?.locator).toContain('input[type="password"]');
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
  });
});
