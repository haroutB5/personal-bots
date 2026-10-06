import type { PersonalBotThread } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { chatActivityMs } from "./chatActivity";

const shell = (over: Partial<Record<string, unknown>>) =>
  ({
    createdAt: "2026-09-25T19:56:00.000Z",
    updatedAt: "2026-09-28T20:10:05.321Z",
    latestUserMessageAt: null,
    latestTurn: null,
    ...over,
  }) as unknown as EnvironmentThreadShell;

describe("chatActivityMs", () => {
  it("ignores updatedAt and takes the latest message or turn time", () => {
    expect(chatActivityMs(shell({}))).toBe(Date.parse("2026-09-25T19:56:00.000Z"));
    expect(
      chatActivityMs(
        shell({
          latestUserMessageAt: "2026-09-25T20:00:00.000Z",
          latestTurn: {
            requestedAt: "2026-09-25T20:00:00.000Z",
            startedAt: "2026-09-25T20:00:01.000Z",
            completedAt: "2026-09-25T20:09:17.316Z",
          },
        }),
      ),
    ).toBe(Date.parse("2026-09-25T20:09:17.316Z"));
    // A turn still running counts from when it started.
    expect(
      chatActivityMs(
        shell({
          latestTurn: {
            requestedAt: "2026-09-28T21:00:00.000Z",
            startedAt: "2026-09-28T21:00:01.000Z",
            completedAt: null,
          },
        }),
      ),
    ).toBe(Date.parse("2026-09-28T21:00:01.000Z"));
  });

  it("uses the server's last message time when it is newer", () => {
    const link = {
      lastActivityAt: DateTime.makeUnsafe("2026-09-27T08:00:00.000Z"),
    } as unknown as PersonalBotThread;
    expect(chatActivityMs(shell({}), link)).toBe(Date.parse("2026-09-27T08:00:00.000Z"));
    expect(chatActivityMs(shell({}), { lastActivityAt: null })).toBe(
      Date.parse("2026-09-25T19:56:00.000Z"),
    );
  });
});

describe("chatActivityMs memo (1.64.1)", () => {
  it("returns the same answer as a fresh shell with the same fields", () => {
    const fields = {
      latestUserMessageAt: "2026-09-25T20:00:00.000Z",
      latestTurn: {
        requestedAt: "2026-09-25T20:00:00.000Z",
        startedAt: "2026-09-25T20:00:01.000Z",
        completedAt: "2026-09-25T20:09:17.316Z",
      },
    };
    const link = { lastActivityAt: DateTime.makeUnsafe("2026-09-25T21:00:00.000Z") } as Pick<
      PersonalBotThread,
      "lastActivityAt"
    >;
    const first = shell(fields);
    const expected = chatActivityMs(shell(fields), link);
    expect(chatActivityMs(first, link)).toBe(expected);
    expect(chatActivityMs(first, link)).toBe(expected);
    expect(expected).toBe(Date.parse("2026-09-25T21:00:00.000Z"));
  });

  it("recomputes when a shell is changed in place or given another link", () => {
    const mutable = shell({ latestUserMessageAt: "2026-09-25T20:00:00.000Z" }) as unknown as {
      latestUserMessageAt: string | null;
      latestTurn: {
        requestedAt: string | null;
        startedAt: string | null;
        completedAt: string | null;
      } | null;
    };
    const target = mutable as unknown as EnvironmentThreadShell;
    expect(chatActivityMs(target)).toBe(Date.parse("2026-09-25T20:00:00.000Z"));
    mutable.latestUserMessageAt = "2026-09-26T08:00:00.000Z";
    expect(chatActivityMs(target)).toBe(Date.parse("2026-09-26T08:00:00.000Z"));
    mutable.latestTurn = {
      requestedAt: null,
      startedAt: null,
      completedAt: "2026-09-27T08:00:00.000Z",
    };
    expect(chatActivityMs(target)).toBe(Date.parse("2026-09-27T08:00:00.000Z"));
    const link = { lastActivityAt: DateTime.makeUnsafe("2026-09-28T08:00:00.000Z") } as Pick<
      PersonalBotThread,
      "lastActivityAt"
    >;
    expect(chatActivityMs(target, link)).toBe(Date.parse("2026-09-28T08:00:00.000Z"));
    expect(chatActivityMs(target)).toBe(Date.parse("2026-09-27T08:00:00.000Z"));
  });
});
