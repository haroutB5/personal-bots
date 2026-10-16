import { describe, expect, it } from "vite-plus/test";

import {
  type ConversationItem,
  type VoiceCallCardItem,
  placeCallCards,
  voiceCallSummaryPending,
} from "./conversationModel";

const message = (id: string, role: "user" | "assistant", at: string): ConversationItem => ({
  kind: "message",
  id,
  message: { id, role, text: id, createdAt: at } as never,
});

const call = (callId: string, atMs: number): VoiceCallCardItem => ({
  callId,
  atMs,
  endedAtMs: atMs + 252_000,
  live: false,
  durationMs: 252_000,
  endedLine: "You hung up.",
  sentCount: 1,
  voiceName: "Charon",
  transcript: [],
});

describe("placeCallCards", () => {
  it("puts a call where it started, not at the end of the chat", () => {
    const items = [
      message("m1", "user", "2026-10-15T10:00:00.000Z"),
      message("m2", "assistant", "2026-10-15T10:00:30.000Z"),
      message("m3", "assistant", "2026-10-15T12:00:00.000Z"),
    ];
    const placed = placeCallCards(items, [call("c1", Date.parse("2026-10-15T11:00:00.000Z"))]);
    expect(placed.map((item) => item.id)).toEqual(["m1", "m2", "call:c1", "m3"]);
  });

  it("keeps two calls in the order they started", () => {
    const items = [message("m1", "user", "2026-10-15T10:00:00.000Z")];
    const placed = placeCallCards(items, [
      call("late", Date.parse("2026-10-15T12:00:00.000Z")),
      call("early", Date.parse("2026-10-15T11:00:00.000Z")),
    ]);
    expect(placed.map((item) => item.id)).toEqual(["m1", "call:early", "call:late"]);
  });

  it("puts a call older than every loaded row first", () => {
    const items = [message("m1", "user", "2026-10-15T10:00:00.000Z")];
    const placed = placeCallCards(items, [call("c1", Date.parse("2026-10-15T09:00:00.000Z"))]);
    expect(placed.map((item) => item.id)).toEqual(["call:c1", "m1"]);
  });

  it("changes nothing when there are no calls", () => {
    const items = [message("m1", "user", "2026-10-15T10:00:00.000Z")];
    expect(placeCallCards(items, [])).toEqual(items);
  });
});

// Astra re-check R4: the window used to run from the call's START, so a call
// longer than the window was already stale when it hung up and its finished
// summary never refreshed.
describe("voiceCallSummaryPending", () => {
  const ended = (endedAtMs: number): VoiceCallCardItem => ({
    ...call("c1", endedAtMs - 30 * 60_000),
    endedAtMs,
  });

  it("keeps asking for a long call's summary after it ended", () => {
    const end = Date.parse("2026-10-15T12:00:00.000Z");
    // A 30-minute call that ended one minute ago: the old start-based window
    // was 10 minutes, so this card was never polled.
    expect(voiceCallSummaryPending([ended(end)], end + 60_000)).toBe(true);
  });

  it("stops asking once the call ended longer ago than the window", () => {
    const end = Date.parse("2026-10-15T12:00:00.000Z");
    expect(voiceCallSummaryPending([ended(end)], end + 11 * 60_000)).toBe(false);
  });

  it("never asks again once the card has its summary", () => {
    const end = Date.parse("2026-10-15T12:00:00.000Z");
    const withSummary: VoiceCallCardItem = {
      ...ended(end),
      summary: { summary: "He asked about a court.", points: [], decision: null, open: null },
    };
    expect(voiceCallSummaryPending([withSummary], end + 1_000)).toBe(false);
  });

  it("says nothing about no cards at all", () => {
    expect(voiceCallSummaryPending([], Date.now())).toBe(false);
  });
});
