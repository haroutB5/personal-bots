/** Run with node apps/server/scripts/qa/login-origin-redirect.test.ts (local Chrome required). */
import * as NodeAssert from "node:assert/strict";
import * as NodeModule from "node:module";
import * as NodeProcess from "node:process";
import type { BrowserPage } from "../../src/personal/browser/driver.ts";
import { performFillLogin } from "../../src/personal/browser/pageOperations.ts";

const { chromium } = NodeModule.createRequire(new URL("../../package.json", import.meta.url))(
  "playwright-core",
) as typeof import("playwright-core");
const approvedOrigin = "https://approved.login.test";
const destinationOrigin = "https://other.login.test";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  for (const usernameFirst of [false, true]) {
    const page = await browser.newPage();
    await page.route("**/*", (route) => {
      const approved = new URL(route.request().url()).origin === approvedOrigin;
      return route.fulfill({
        contentType: "text/html",
        body: `<form><input autocomplete="username" ${approved ? "readonly" : ""}>
          ${!approved || !usernameFirst ? '<input type="password">' : ""}</form>
          ${approved ? `<script>setTimeout(() => location.href = '${destinationOrigin}/signin', 400)</script>` : ""}`,
      });
    });
    await page.goto(`${approvedOrigin}/signin`);
    // These are the actual Playwright primitives used by driver.ts. Locator
    // fill retries into replacement documents; element handles cannot do so.
    const adapter = {
      url: () => page.url(),
      countLocator: (locator: string) => page.locator(locator).count(),
      evaluate: (script: string) => page.evaluate(script),
      typeText: ({
        locator,
        text,
        timeoutMs,
      }: {
        locator: string;
        text: string;
        timeoutMs: number;
      }) => page.locator(locator).first().fill(text, { timeout: timeoutMs }),
      resolveElement: async (locator: string, timeoutMs: number) => {
        const handle = await page.locator(locator).first().elementHandle({ timeout: timeoutMs });
        return handle === null
          ? null
          : {
              fill: (text: string, timeout: number) => handle.fill(text, { timeout }),
              dispose: () => handle.dispose(),
            };
      },
    } as unknown as BrowserPage;
    const navigated = page.waitForURL(`${destinationOrigin}/signin`);
    const failed = await performFillLogin(
      adapter,
      { expectedOrigin: approvedOrigin, username: "fixture-user", password: "fixture-password" },
      2_000,
    ).then(
      () => false,
      () => true,
    );
    await navigated;
    const usernameWritten =
      (await page.locator('input[autocomplete="username"]').inputValue()) !== "";
    const passwordWritten = (await page.locator('input[type="password"]').inputValue()) !== "";
    NodeProcess.stdout.write(
      `${JSON.stringify({ usernameFirst, failed, usernameWritten, passwordWritten })}\n`,
    );
    NodeAssert.equal(failed, true);
    NodeAssert.equal(usernameWritten, false, "username reached a replacement origin");
    NodeAssert.equal(passwordWritten, false, "password reached a replacement origin");
    await page.close();
  }
} finally {
  await browser.close();
}
