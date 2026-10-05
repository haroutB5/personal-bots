import { describe, expect, it } from "@effect/vitest";

import {
  classifyBotCheck,
  classifyPageError,
  friendlyNavigationMessage,
  HostOperationError,
  isReplacedNavigation,
} from "./pageOperations.ts";

const raw = (code: string, url = "https://example.invalid/path?token=abc123") =>
  new Error(
    `page.goto: net::${code} at ${url}\nCall log:\n  - navigating to "${url}", waiting until "load"\n`,
  );

describe("friendly navigation errors", () => {
  const cases: ReadonlyArray<readonly [string, RegExp]> = [
    ["ERR_NAME_NOT_RESOLVED", /address could not be found/],
    ["ERR_INTERNET_DISCONNECTED", /no internet connection/],
    ["ERR_CONNECTION_REFUSED", /refused the connection/],
    ["ERR_CONNECTION_TIMED_OUT", /took too long to answer/],
    ["ERR_CONNECTION_RESET", /dropped before it answered/],
    ["ERR_EMPTY_RESPONSE", /dropped before it answered/],
    ["ERR_CERT_AUTHORITY_INVALID", /security certificate/],
    ["ERR_SSL_PROTOCOL_ERROR", /security certificate/],
    ["ERR_TOO_MANY_REDIRECTS", /redirecting in a loop/],
    ["ERR_ABORTED", /interrupted/],
    ["ERR_BLOCKED_BY_CLIENT", /refused to be opened/],
    ["ERR_ADDRESS_UNREACHABLE", /can't be reached/],
    ["ERR_INVALID_URL", /not valid/],
  ];

  for (const [code, words] of cases) {
    it(`says ${code} in plain words, keeps the code, and drops the address and call log`, () => {
      const error = classifyPageError(raw(code));
      expect(error).toBeInstanceOf(HostOperationError);
      expect(error.tag).toBe("PreviewAutomationExecutionError");
      expect(error.message).toMatch(words);
      expect(error.message.endsWith(`(${code})`)).toBe(true);
      expect(error.message).not.toMatch(/page\.goto|net::|Call log|token=abc123|example\.invalid/);
    });
  }

  it("names a code it has no sentence for without Playwright's text", () => {
    const message = friendlyNavigationMessage(raw("ERR_SOMETHING_NEW").message);
    expect(message).toBe("The page could not be opened. (ERR_SOMETHING_NEW)");
  });

  describe("a navigation failure with no network code", () => {
    const google = "https://www.google.com/search?q=private+thing&token=abc123";
    const replaced = (to: string) =>
      new Error(
        `page.goto: Navigation to "${google}" is interrupted by another navigation to "${to}"\nCall log:\n  - navigating to "${google}", waiting until "load"\n`,
      );

    it("says the page could not be opened, without the address, when Google lands on a chrome-error page", () => {
      const error = classifyPageError(replaced("chrome-error://chromewebdata/"));
      expect(error.tag).toBe("PreviewAutomationExecutionError");
      expect(error.message).toBe("The page could not be opened.");
      expect(error.message).not.toMatch(/google|token=abc123|chrome-error|page\.goto|Call log/);
    });

    it("does the same for a navigation replaced by a bot-check page address", () => {
      const error = classifyPageError(replaced("https://www.google.com/sorry/index?continue=x"));
      expect(error.message).toBe("The page could not be opened.");
    });

    it("keeps the tab-gone tag but with plain words when the page was closed", () => {
      const error = classifyPageError(
        new Error(
          `page.goto: Target page, context or browser has been closed\nCall log:\n  - navigating to "${google}"`,
        ),
      );
      expect(error.tag).toBe("PreviewAutomationTabNotFoundError");
      expect(error.message).toBe("The page could not be opened.");
    });

    it("leaves a closed page outside a navigation call as it was", () => {
      const error = classifyPageError(new Error("locator.click: Target closed"));
      expect(error.tag).toBe("PreviewAutomationTabNotFoundError");
      expect(error.message).toBe("locator.click: Target closed");
    });

    it("recognises a replaced navigation and nothing broader", () => {
      expect(isReplacedNavigation(replaced("chrome-error://chromewebdata/"))).toBe(true);
      expect(isReplacedNavigation(raw("ERR_ABORTED"))).toBe(false);
      expect(isReplacedNavigation(new Error("page.goto: Timeout 30000ms exceeded."))).toBe(false);
      expect(
        isReplacedNavigation(new Error("locator.click: interrupted by another navigation")),
      ).toBe(false);
    });
  });

  it("explains a slow page load in seconds and keeps the timeout tag bot tools key on", () => {
    const timeout = Object.assign(
      new Error("page.goto: Timeout 30000ms exceeded.\nCall log:\n  - x"),
      {
        name: "TimeoutError",
      },
    );
    const error = classifyPageError(timeout);
    expect(error.tag).toBe("PreviewAutomationTimeoutError");
    expect(error.message).toBe(
      "The page took longer than 30 s to load. It may still be loading; try again or open something lighter.",
    );
  });

  it("leaves every other failure's wording alone", () => {
    const click = Object.assign(new Error("locator.click: Timeout 5000ms exceeded.\nCall log:"), {
      name: "TimeoutError",
    });
    expect(classifyPageError(click).message).toBe("locator.click: Timeout 5000ms exceeded.");
    expect(friendlyNavigationMessage("locator.click: Timeout 5000ms exceeded.")).toBeNull();
    expect(classifyPageError(new Error("Element is not an <input>")).tag).toBe(
      "PreviewAutomationTargetNotEditableError",
    );
    expect(
      classifyPageError(new Error("Target page, context or browser has been closed")).tag,
    ).toBe("PreviewAutomationTabNotFoundError");
  });

  it("passes an error the host already worded straight through", () => {
    const own = new HostOperationError("PreviewAutomationExecutionError", "Take control first.");
    expect(classifyPageError(own)).toBe(own);
  });
});

describe("bot-check page classification", () => {
  const page = (title: string, text = "", extra: Record<string, unknown> = {}) => ({
    title: title.toLowerCase(),
    text: text.toLowerCase(),
    frames: 0,
    marked: false,
    ...extra,
  });

  it("recognises a Cloudflare-style wait page", () => {
    expect(classifyBotCheck(page("Just a moment...", "Checking your browser"))).toBe("challenge");
    expect(classifyBotCheck(page("Attention Required! | Cloudflare"))).toBe("challenge");
    expect(
      classifyBotCheck(
        page("example.com", "Verifying you are human. This may take a few seconds."),
      ),
    ).toBe("challenge");
  });

  it("recognises a captcha by its frame, its markup or its words", () => {
    expect(classifyBotCheck(page("Sign in", "", { frames: 1 }))).toBe("captcha");
    expect(classifyBotCheck(page("Sign in", "", { marked: true }))).toBe("captcha");
    expect(classifyBotCheck(page("Security check", "Please verify you are a human"))).toBe(
      "captcha",
    );
    expect(classifyBotCheck(page("Robot?", "Are you a robot?"))).toBe("captcha");
  });

  it("recognises a block page", () => {
    expect(classifyBotCheck(page("Access Denied", "You don't have permission"))).toBe("blocked");
    expect(classifyBotCheck(page("Sorry", "We detected unusual traffic from your network"))).toBe(
      "blocked",
    );
  });

  it("leaves ordinary pages alone, including ones that merely mention a moment or a captcha form of words in a long article", () => {
    expect(
      classifyBotCheck(page("Weather today", "Sunny with a chance of rain in a moment")),
    ).toBeNull();
    expect(classifyBotCheck(page("Pricing", "Plans for every team. Contact sales."))).toBeNull();
    expect(classifyBotCheck(null)).toBeNull();
    expect(classifyBotCheck("just a moment")).toBeNull();
    expect(classifyBotCheck({})).toBeNull();
  });
});
