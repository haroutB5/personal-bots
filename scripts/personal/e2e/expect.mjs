// A tiny `expect` for locators and polled values (playwright-core ships no test runner).
// Every matcher waits up to `timeout` (default STEP_TIMEOUT_MS) and throws a plain Error.
import { STEP_TIMEOUT_MS } from "./lib.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(read, accept, describe, timeout) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await read();
      if (accept(last)) return last;
    } catch (error) {
      last = `error: ${String(error?.message ?? error).split("\n")[0]}`;
    }
    if (Date.now() > deadline) throw new Error(`${describe}; last value: ${JSON.stringify(last)}`);
    await sleep(100);
  }
}

const textMatches = (text, wanted) =>
  wanted instanceof RegExp ? wanted.test(text) : text.includes(wanted);

export function expect(target) {
  return {
    /** At least one matching element is on screen (the phone keeps the Bots list mounted, hidden, under a chat). */
    async toBeVisible({ timeout = STEP_TIMEOUT_MS } = {}) {
      await target.filter({ visible: true }).first().waitFor({ state: "attached", timeout });
    },
    async toBeHidden({ timeout = STEP_TIMEOUT_MS } = {}) {
      await until(
        () => target.filter({ visible: true }).count(),
        (n) => n === 0,
        "expected nothing visible",
        timeout,
      );
    },
    async toContainText(wanted, { timeout = STEP_TIMEOUT_MS } = {}) {
      await until(
        () => target.first().innerText(),
        (text) => textMatches(text, wanted),
        `expected text ${wanted}`,
        timeout,
      );
    },
    async toHaveCount(count, { timeout = STEP_TIMEOUT_MS } = {}) {
      await until(
        () => target.count(),
        (n) => n === count,
        `expected ${count} elements`,
        timeout,
      );
    },
  };
}

/** expect.poll(() => value).toMatch(/re/) | .toBe(x) */
expect.poll = (read, { timeout = STEP_TIMEOUT_MS } = {}) => ({
  async toMatch(pattern) {
    await until(read, (value) => pattern.test(String(value)), `expected ${pattern}`, timeout);
  },
  async toBe(wanted) {
    await until(read, (value) => value === wanted, `expected ${JSON.stringify(wanted)}`, timeout);
  },
});
