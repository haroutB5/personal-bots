import { describe, expect, it } from "vite-plus/test";

import { type ConversationItem, type VoiceCallCardItem, placeCallCards } from "./conversationModel";

const message = (id: string, role: "user" | "assistant", at: string): ConversationItem => ({
  kind: "message",
  id,
  message: { id, role, text: id, createdAt: at } as never,
});

const call = (callId: string, atMs: number): VoiceCallCardItem => ({
  callId,
  atMs,
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
