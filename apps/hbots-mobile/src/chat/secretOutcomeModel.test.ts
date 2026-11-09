import { describe, expect, it } from "vite-plus/test";

import type { SecretRequestHistoryEntry } from "@hbots/personal-client/conversation/secretRequestCards";

import {
  appendSecretOutcome,
  decodeSecretOutcomeHistory,
  encodeSecretOutcomeHistory,
  MAX_SECRET_OUTCOME_RECORDS,
} from "./secretOutcomeModel";

const record = (requestId: string, overrides: Partial<SecretRequestHistoryEntry> = {}) => ({
  requestId,
  threadId: "thread-1",
  createdAtMs: Date.parse("2026-11-06T08:00:00.000Z"),
  name: "GITHUB_TOKEN",
  label: "GitHub token",
  outcome: "provided" as const,
  ...overrides,
});

describe("secret outcome history", () => {
  it("keeps the latest ending once per request", () => {
    const first = appendSecretOutcome([], record("a"));
    const replaced = appendSecretOutcome(first, record("a", { outcome: "declined" }));
    expect(replaced).toEqual([record("a", { outcome: "declined" })]);
  });

  it("caps the file at the newest records", () => {
    let history: SecretRequestHistoryEntry[] = [];
    for (let index = 0; index <= MAX_SECRET_OUTCOME_RECORDS; index += 1) {
      history = appendSecretOutcome(history, record(`request-${index}`));
    }
    expect(history).toHaveLength(MAX_SECRET_OUTCOME_RECORDS);
    expect(history[0]?.requestId).toBe(`request-${MAX_SECRET_OUTCOME_RECORDS}`);
  });

  it("never writes a value even when one is attached at runtime", () => {
    const leaky = { ...record("a"), value: "CANARY-SECRET-VALUE" } as SecretRequestHistoryEntry;
    const encoded = encodeSecretOutcomeHistory([leaky]);
    expect(encoded).not.toContain("CANARY-SECRET-VALUE");
    expect(encoded).not.toContain('"value"');
  });

  it("round-trips the receipt without its value", () => {
    const history = [record("b"), record("a", { outcome: "declined" })];
    expect(decodeSecretOutcomeHistory(JSON.parse(encodeSecretOutcomeHistory(history)))).toEqual(
      history,
    );
  });

  it("drops malformed records and unknown keys", () => {
    const decoded = decodeSecretOutcomeHistory({
      version: 1,
      records: [
        { ...record("good"), value: "CANARY-SECRET-VALUE" },
        { ...record("no-outcome"), outcome: "leaked" },
        { ...record("bad-time"), createdAtMs: "yesterday" },
        null,
      ],
    });
    expect(decoded).toEqual([record("good")]);
  });
});
