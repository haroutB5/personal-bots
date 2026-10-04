import { describe, expect, it } from "@effect/vitest";

import { UsageBotAggregator } from "./botUsage.ts";
import { initialCodexScanState, parseCodexLine, type UsageRecord } from "./usageTranscripts.ts";

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    provider: "claude",
    timestampMs: Date.parse("2026-08-10T12:00:00.000Z"),
    model: "claude-opus-5-5",
    sessionId: "session-a",
    totals: {
      uncachedInputTokens: 100,
      cachedInputTokens: 1000,
      cacheCreationTokens: 10,
      outputTokens: 50,
      reasoningTokens: 0,
    },
    reportedCostUsd: null,
    fast: false,
    dedupeKey: null,
    ...overrides,
  };
}

function aggregator(timeZone = "UTC", sinceDay = "2026-08-01", untilDay = "2026-08-31") {
  return new UsageBotAggregator({ timeZone, sinceDay, untilDay });
}

describe("UsageBotAggregator", () => {
  it("sums the four buckets per (day, session, provider, model)", () => {
    const agg = aggregator();
    agg.add(record());
    agg.add(record({ timestampMs: Date.parse("2026-08-10T13:00:00.000Z") }));
    agg.add(record({ sessionId: "session-b" }));
    agg.add(record({ model: "claude-sonnet-5-5" }));
    agg.add(record({ timestampMs: Date.parse("2026-08-11T09:00:00.000Z") }));

    const cells = agg.finish();
    expect(cells).toHaveLength(4);
    const first = cells.find(
      (cell) =>
        cell.day === "2026-08-10" &&
        cell.sessionId === "session-a" &&
        cell.model === "claude-opus-5-5",
    );
    expect(first).toMatchObject({
      records: 2,
      totals: {
        uncachedInputTokens: 200,
        cachedInputTokens: 2000,
        cacheCreationTokens: 20,
        outputTokens: 100,
      },
    });
    // Reasoning is inside output; it is not a bucket of its own here.
    expect(first?.totals).not.toHaveProperty("reasoningTokens");
  });

  it("counts a record with the same dedupe key once, across files", () => {
    const agg = aggregator();
    const copy = record({ dedupeKey: "msg_1:req_1" });
    const firstFile = agg.beginFile();
    const secondFile = agg.beginFile();
    expect(firstFile.add(copy)).toBe(true);
    // Claude copies a message's records forward when a session is resumed.
    expect(secondFile.add({ ...copy })).toBe(false);
    expect(agg.finish()).toHaveLength(1);
    expect(agg.finish()[0]?.records).toBe(1);
    expect(agg.duplicatesDropped).toBe(1);
  });

  it("keeps records without a dedupe key", () => {
    const agg = aggregator();
    agg.add(record());
    agg.add(record());
    expect(agg.finish()[0]?.records).toBe(2);
  });

  it("keeps only the days inside the window, ends included", () => {
    const agg = aggregator("UTC", "2026-08-10", "2026-08-12");
    agg.add(record({ timestampMs: Date.parse("2026-08-09T23:59:59.000Z") }));
    agg.add(record({ timestampMs: Date.parse("2026-08-10T00:00:00.000Z") }));
    agg.add(record({ timestampMs: Date.parse("2026-08-12T23:59:59.000Z") }));
    agg.add(record({ timestampMs: Date.parse("2026-08-13T00:00:00.000Z") }));
    expect(agg.finish().map((cell) => cell.day)).toEqual(["2026-08-10", "2026-08-12"]);
    expect(agg.outOfWindow).toBe(2);
  });

  it("cuts days in the requested time zone", () => {
    // 04:05Z is still the 6th in Los Angeles (UTC-7) and already the 7th in UTC.
    const instant = Date.parse("2026-08-07T04:05:13.944Z");
    const inLosAngeles = aggregator("America/Los_Angeles");
    inLosAngeles.add(record({ timestampMs: instant }));
    expect(inLosAngeles.finish()[0]?.day).toBe("2026-08-06");

    const inUtc = aggregator("UTC");
    inUtc.add(record({ timestampMs: instant }));
    expect(inUtc.finish()[0]?.day).toBe("2026-08-07");
  });

  it("puts the edge of a local day on the right side, in both directions", () => {
    // Europe/London is UTC+1 in August: local midnight is 23:00Z.
    const agg = aggregator("Europe/London", "2026-08-10", "2026-08-10");
    agg.add(record({ timestampMs: Date.parse("2026-08-09T22:59:59.000Z") }));
    agg.add(record({ timestampMs: Date.parse("2026-08-09T23:00:00.000Z") }));
    agg.add(record({ timestampMs: Date.parse("2026-08-10T22:59:59.000Z") }));
    agg.add(record({ timestampMs: Date.parse("2026-08-10T23:00:00.000Z") }));
    expect(agg.finish()[0]?.records).toBe(2);
  });

  it("falls back to UTC for a time zone it does not know", () => {
    const agg = aggregator("Not/AZone");
    agg.add(record({ timestampMs: Date.parse("2026-08-07T23:30:00.000Z") }));
    expect(agg.finish()[0]?.day).toBe("2026-08-07");
  });

  it("keeps records with no session id, under an empty session", () => {
    const agg = aggregator();
    agg.add(record({ sessionId: "" }));
    expect(agg.finish()[0]?.sessionId).toBe("");
  });

  describe("Codex", () => {
    const codexEvent = (overrides: Partial<UsageRecord> = {}) =>
      record({ provider: "codex", model: "gpt-6-astra", sessionId: "rollout-1", ...overrides });

    it("counts two equal events inside one rollout, and drops a moved copy of it", () => {
      const agg = aggregator();
      const original = agg.beginFile();
      // Timestamps have second precision, so two real turns can look identical.
      expect(original.add(codexEvent())).toBe(true);
      expect(original.add(codexEvent())).toBe(true);
      const movedCopy = agg.beginFile();
      expect(movedCopy.add(codexEvent())).toBe(false);
      expect(movedCopy.add(codexEvent())).toBe(false);
      expect(agg.finish()[0]?.records).toBe(2);
    });

    it("does not merge events of different sessions", () => {
      const agg = aggregator();
      const file = agg.beginFile();
      file.add(codexEvent());
      file.add(codexEvent({ sessionId: "rollout-2" }));
      expect(agg.finish()).toHaveLength(2);
    });

    it("takes cached input out of the uncached bucket (Codex reports it inclusive)", () => {
      const state = initialCodexScanState();
      const lines = [
        JSON.stringify({
          timestamp: "2026-08-10T12:00:00.000Z",
          type: "session_meta",
          payload: { id: "rollout-1" },
        }),
        JSON.stringify({
          timestamp: "2026-08-10T12:00:01.000Z",
          type: "turn_context",
          payload: { model: "gpt-6-astra" },
        }),
        JSON.stringify({
          timestamp: "2026-08-10T12:00:02.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: {
                input_tokens: 1000,
                cached_input_tokens: 800,
                output_tokens: 40,
                reasoning_output_tokens: 10,
              },
            },
          },
        }),
      ];
      const agg = aggregator();
      const file = agg.beginFile();
      for (const line of lines) {
        const parsed = parseCodexLine(line, state);
        if (parsed !== null) file.add(parsed);
      }
      expect(agg.finish()[0]).toMatchObject({
        provider: "codex",
        sessionId: "rollout-1",
        totals: {
          uncachedInputTokens: 200,
          cachedInputTokens: 800,
          cacheCreationTokens: 0,
          outputTokens: 40,
        },
      });
    });
  });
});
