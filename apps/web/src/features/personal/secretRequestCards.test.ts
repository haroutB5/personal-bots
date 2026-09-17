import {
  PersonalBotId,
  PersonalSecretRequestId,
  ThreadId,
  type PersonalSecretRequest,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";

import { deriveSecretRequestCards, threadIdsAwaitingSecret } from "./secretRequestCards";

const request = (
  key: string,
  threadId: string,
  createdAt: string,
  name = "GITHUB_TOKEN",
): PersonalSecretRequest => ({
  requestId: PersonalSecretRequestId.make(key),
  taskId: null,
  rootTaskId: null,
  threadId: ThreadId.make(threadId),
  botId: PersonalBotId.make("bot-1"),
  name,
  label: `${name} label`,
  purpose: "Test.",
  status: "pending",
  shared: false,
  createdAt: DateTime.makeUnsafe(createdAt),
  fulfilledAt: null,
});

it("shows only the open chat's pending requests, oldest first", () => {
  const mine = request("a", "thread-1", "2026-09-14T10:05:00.000Z");
  const older = request("b", "thread-1", "2026-09-14T10:00:00.000Z", "NPM_TOKEN");
  const elsewhere = request("c", "thread-2", "2026-09-14T10:01:00.000Z");

  const cards = deriveSecretRequestCards(
    [mine, older, elsewhere],
    "thread-1",
    new Map(),
    new Map(),
  );

  expect(cards.map((card) => [card.kind, card.requestId])).toEqual([
    ["pending", "b"],
    ["pending", "a"],
  ]);
});

it("keeps an answered request on screen with what this device did", () => {
  const asked = request("a", "thread-1", "2026-09-14T10:00:00.000Z");
  const seen = new Map([["a", asked]]);

  // `listPending` drops the row the moment it is answered.
  const provided = deriveSecretRequestCards([], "thread-1", seen, new Map([["a", "provided"]]));
  expect(provided).toEqual([
    {
      kind: "provided",
      requestId: "a",
      createdAtMs: Date.parse("2026-09-14T10:00:00.000Z"),
      name: "GITHUB_TOKEN",
      label: "GITHUB_TOKEN label",
    },
  ]);

  const declined = deriveSecretRequestCards([], "thread-1", seen, new Map([["a", "declined"]]));
  expect(declined.map((card) => card.kind)).toEqual(["declined"]);

  // Settled somewhere else (another phone, or the bot already had the value):
  // the card says it is no longer waiting rather than claiming an ending.
  const closed = deriveSecretRequestCards([], "thread-1", seen, new Map());
  expect(closed.map((card) => card.kind)).toEqual(["closed"]);
});

it("does not carry another chat's remembered request into this one", () => {
  const other = request("a", "thread-2", "2026-09-14T10:00:00.000Z");
  expect(deriveSecretRequestCards([], "thread-1", new Map([["a", other]]), new Map())).toEqual([]);
});

it("names every chat a bot is parked on a secret in", () => {
  expect(
    threadIdsAwaitingSecret([
      request("a", "thread-1", "2026-09-14T10:00:00.000Z"),
      request("b", "thread-1", "2026-09-14T10:01:00.000Z", "NPM_TOKEN"),
      request("c", "thread-2", "2026-09-14T10:02:00.000Z"),
    ]),
  ).toEqual(new Set(["thread-1", "thread-2"]));
  expect(threadIdsAwaitingSecret([])).toEqual(new Set());
});
