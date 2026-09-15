import { describe, expect, it } from "vite-plus/test";

import type { BrowserElementHandle, BrowserPage } from "./driver.ts";
import { performFillLogin } from "./pageOperations.ts";

/**
 * The login form as markup, not as a verdict. The fake resolves it with the
 * same algorithm a browser uses for `form.action` and `element.formAction`
 * (WHATWG URL parsing against the document's base URL, which strips leading
 * whitespace and lowercases the scheme), so a test can state what the page
 * says and let resolution decide whether the fill is refused.
 */
interface FormFixture {
  /** The `action` content attribute; absent or empty reflects the document URL. */
  readonly action?: string;
  /** A `<base href>` on the page. */
  readonly base?: string;
  /** A submit button's `formaction` content attribute. */
  readonly formaction?: string;
  /** The password field is not inside a form at all. */
  readonly noForm?: boolean;
  /** The page reports no password field although Playwright matched one. */
  readonly noPasswordField?: boolean;
}

interface FakeOptions {
  /** Called when the password handle is resolved; lets a test navigate first. */
  readonly onResolve?: () => void;
  readonly detached?: boolean;
  readonly form?: FormFixture;
}

const makePage = (url: string, options: FakeOptions = {}) => {
  const typed: Array<{ readonly locator: string | null; readonly text: string }> = [];
  const filled: Array<{ readonly locator: string; readonly text: string }> = [];
  const disposed: string[] = [];
  let currentUrl = url;
  let form: FormFixture = options.form ?? {};

  /** Mirrors the IDL getters: an absent or empty attribute reflects the page URL. */
  const resolve = (value: string | undefined, baseUri: string) => {
    if (value === undefined || value === "") return currentUrl;
    try {
      return new URL(value, baseUri).href;
    } catch {
      return value;
    }
  };

  const page = {
    url: () => currentUrl,
    countLocator: async (locator: string) => {
      if (locator.startsWith("form:has(:focus)")) return 0;
      if (locator === 'form:has(input[type="password"]:visible:not([disabled]))') return 1;
      if (locator.includes('input[autocomplete="username"]')) return 1;
      if (locator.includes('input[type="password"]')) return 1;
      return 0;
    },
    evaluate: async () => {
      const baseUri = form.base === undefined ? currentUrl : new URL(form.base, currentUrl).href;
      if (form.noPasswordField === true) {
        return { found: false, hasForm: false, baseUri, action: null, submitters: [] };
      }
      if (form.noForm === true) {
        return { found: true, hasForm: false, baseUri, action: null, submitters: [] };
      }
      return {
        found: true,
        hasForm: true,
        baseUri,
        action: resolve(form.action, baseUri),
        submitters: form.formaction === undefined ? [] : [resolve(form.formaction, baseUri)],
      };
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
  return {
    page,
    typed,
    filled,
    disposed,
    navigate: (next: string) => (currentUrl = next),
    rewriteForm: (next: FormFixture) => (form = next),
  };
};

const fill = (page: BrowserPage) =>
  performFillLogin(
    page,
    {
      expectedOrigin: "https://example.com",
      username: "person@example.com",
      password: "not-model-visible",
    },
    1_000,
  );

describe("saved-login browser fill", () => {
  it("targets username then password fields without returning either value", async () => {
    const fake = makePage("https://example.com/sign-in", { form: { action: "/session" } });
    const result = await fill(fake.page);

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

    await expect(fill(fake.page)).rejects.toThrow("only be used on https://example.com");
    expect(fake.typed).toEqual([]);
    expect(fake.filled).toEqual([]);
  });

  // The fill compares browser-normalized origins, so look-alikes that differ
  // only in spelling are refused and spellings of the same origin are not.
  describe("origin normalization", () => {
    const refused = [
      ["a subdomain", "https://login.example.com/sign-in"],
      ["a non-default port", "https://example.com:8443/sign-in"],
      ["plain http", "http://example.com/sign-in"],
      // Comet's "perplexity.ai." spoof: a trailing dot is a different origin.
      ["a trailing-dot host", "https://example.com./sign-in"],
      // Cyrillic "а" in place of Latin "a"; the URL parser turns it to punycode.
      ["an IDN look-alike", "https://exаmple.com/sign-in"],
      ["the look-alike's punycode form", "https://xn--exmple-4nf.com/sign-in"],
      ["a look-alike suffix", "https://example.com.attacker.example/sign-in"],
    ] as const;

    for (const [name, url] of refused) {
      it(`refuses ${name}`, async () => {
        const fake = makePage(url);

        await expect(fill(fake.page)).rejects.toThrow("only be used on https://example.com");
        expect(fake.typed).toEqual([]);
        expect(fake.filled).toEqual([]);
      });
    }

    const accepted = [
      ["an uppercase host", "https://EXAMPLE.com/sign-in"],
      ["an explicit default port", "https://example.com:443/sign-in"],
    ] as const;

    for (const [name, url] of accepted) {
      it(`fills ${name}, which is the same origin`, async () => {
        const fake = makePage(url);

        await expect(fill(fake.page)).resolves.toEqual(["username", "password"]);
        expect(fake.filled).toHaveLength(1);
      });
    }
  });

  it("rechecks origin after username entry before typing the password", async () => {
    const fake = makePage("https://example.com/sign-in");
    fake.page.typeText = async (input) => {
      fake.typed.push(input);
      fake.navigate("https://attacker.example/sign-in");
    };

    await expect(fill(fake.page)).rejects.toThrow("only be used on https://example.com");
    expect(fake.typed).toHaveLength(1);
    expect(fake.typed[0]?.text).toBe("person@example.com");
    expect(fake.filled).toEqual([]);
  });

  // I2: a navigation that lands *after* the last origin check used to be
  // survivable, because a locator re-resolves onto whatever page is current.
  it("aborts when the page navigates between the origin check and the fill", async () => {
    const fake = makePage("https://example.com/sign-in", { detached: true });

    await expect(fill(fake.page)).rejects.toThrow("became unavailable");
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

    await expect(fill(redirecting.page)).rejects.toThrow("only be used on https://example.com");
    expect(redirecting.filled).toEqual([]);
  });

  // I4 / audit #4: origin equality ignores the path, and the model picks the
  // page, so a form on the granted origin that posts elsewhere is not a fill
  // target. Each case below is invisible to attribute-prefix matching and is
  // caught only because the destination is resolved as a URL.
  describe("resolved form destinations", () => {
    const refused = [
      ["an absolute cross-origin action", { action: "https://collector.example/take" }],
      ["an uppercase scheme", { action: "HTTPS://COLLECTOR.EXAMPLE/take" }],
      ["leading whitespace before the scheme", { action: "   https://collector.example/take" }],
      ["a protocol-relative action", { action: "//collector.example/take" }],
      // The action itself is relative and same-origin-looking; only resolution
      // against the cross-origin <base> reveals where it goes.
      [
        "a relative action under a cross-origin base",
        { base: "https://collector.example/", action: "take" },
      ],
      [
        "a submit button's formaction",
        { action: "/session", formaction: "https://collector.example/take" },
      ],
    ] as const satisfies ReadonlyArray<readonly [string, FormFixture]>;

    for (const [name, form] of refused) {
      it(`refuses ${name}`, async () => {
        const fake = makePage("https://example.com/user-content/page", { form });

        await expect(fill(fake.page)).rejects.toThrow("submits to a different origin");
        expect(fake.typed).toEqual([]);
        expect(fake.filled).toEqual([]);
      });
    }

    it("allows a same-origin base, a relative action and a same-origin formaction", async () => {
      const fake = makePage("https://example.com/sign-in", {
        form: { base: "https://example.com/app/", action: "session", formaction: "/session?otp=1" },
      });

      await expect(fill(fake.page)).resolves.toEqual(["username", "password"]);
      expect(fake.filled).toHaveLength(1);
    });

    it("allows a password field that is not inside a form", async () => {
      const fake = makePage("https://example.com/sign-in", { form: { noForm: true } });

      await expect(fill(fake.page)).resolves.toEqual(["username", "password"]);
    });

    // The audit's other half: the action was only checked before the username
    // was typed, and typing is an event the page reacts to.
    it("refuses an action the username keystrokes rewrote", async () => {
      const fake = makePage("https://example.com/sign-in", { form: { action: "/session" } });
      fake.page.typeText = async (input) => {
        fake.typed.push(input);
        fake.rewriteForm({ action: "https://collector.example/take" });
      };

      await expect(fill(fake.page)).rejects.toThrow("submits to a different origin");
      expect(fake.typed).toHaveLength(1);
      expect(fake.filled).toEqual([]);
    });

    it("fails closed when the page stops reporting the password field", async () => {
      const fake = makePage("https://example.com/sign-in", { form: { noPasswordField: true } });

      await expect(fill(fake.page)).rejects.toThrow("changed while it was being checked");
      expect(fake.filled).toEqual([]);
    });
  });
});
