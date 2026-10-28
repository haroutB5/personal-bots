import { describe, expect, it } from "vite-plus/test";

import { isProviderLimitText, providerLimitRetryInfo } from "./providerLimitRetry.ts";

describe("providerLimitRetry", () => {
  it("reads the wordings that stop a turn on a limit", () => {
    for (const text of [
      "Free usage limit reached",
      "Usage limit reached. Retry",
      "Rate limit exceeded (429)",
      "Too many requests",
      "quota exhausted",
      "Selected model is at capacity. Please try a different model.",
      "model is overloaded",
      "Free usage exceeded, try a different model",
    ]) {
      expect(isProviderLimitText(text), text).toBe(true);
    }
  });

  it("leaves an ordinary failure alone", () => {
    for (const text of [
      "Insufficient Balance",
      "Session already has an active ACP prompt: ses_1",
      "Maximum call stack size exceeded",
      "",
      undefined,
      null,
    ]) {
      expect(isProviderLimitText(text), String(text)).toBe(false);
    }
  });

  it("attaches a normalized retry without inventing a reset time", () => {
    expect(providerLimitRetryInfo("Free   usage limit\nreached")).toEqual({
      kind: "rate_limited",
      reason: "Free usage limit reached",
    });
    expect(providerLimitRetryInfo("x".repeat(500))).toBeUndefined();
    expect(providerLimitRetryInfo(`quota ${"x".repeat(500)}`)).toMatchObject({
      kind: "rate_limited",
    });
    expect(providerLimitRetryInfo(`quota ${"x".repeat(500)}`)?.reason).toHaveLength(200);
    expect(providerLimitRetryInfo("Insufficient Balance")).toBeUndefined();
  });
});
