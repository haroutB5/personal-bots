import { afterEach, expect, it } from "vite-plus/test";

import {
  clearMessageJump,
  peekMessageJump,
  PENDING_MESSAGE_JUMP_TTL_MS,
  requestMessageJump,
} from "./pendingMessageJump";

afterEach(() => {
  clearMessageJump("t1");
  clearMessageJump("t2");
});

it("holds a request for its chat until it is cleared", () => {
  requestMessageJump("t1", "m1", 1_000);
  expect(peekMessageJump("t1", 1_001)).toBe("m1");
  expect(peekMessageJump("t1", 1_002)).toBe("m1");
  expect(peekMessageJump("t2", 1_001)).toBeNull();
  clearMessageJump("t1");
  expect(peekMessageJump("t1", 1_003)).toBeNull();
});

it("lapses after the expiry", () => {
  requestMessageJump("t1", "m1", 1_000);
  expect(peekMessageJump("t1", 1_000 + PENDING_MESSAGE_JUMP_TTL_MS - 1)).toBe("m1");
  expect(peekMessageJump("t1", 1_000 + PENDING_MESSAGE_JUMP_TTL_MS)).toBeNull();
  expect(peekMessageJump("t1", 1_000)).toBeNull();
});

it("a newer request replaces the older one", () => {
  requestMessageJump("t1", "m1", 1_000);
  requestMessageJump("t1", "m2", 2_000);
  expect(peekMessageJump("t1", 2_001)).toBe("m2");
});
