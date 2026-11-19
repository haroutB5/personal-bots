import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import * as Pending from "./pendingDevices.ts";

const entry = (expiresAtMs: number): Pending.PendingDeviceSignIn => ({
  deviceCode: Redacted.make("DC"),
  userCode: "ABCD1234",
  expiresAtMs,
  intervalSec: 5,
  reconnect: null,
});

describe("EmailPendingDevices", () => {
  it.effect("a finished sign-in cannot be finished twice", () =>
    Effect.gen(function* () {
      const pending = yield* Pending.make;
      const id = yield* pending.begin(entry(10_000));
      expect((yield* pending.lookup(id, 1_000))._tag).toBe("found");
      yield* pending.finish(id);
      expect((yield* pending.lookup(id, 1_000))._tag).toBe("unknown");
    }),
  );

  it.effect("a sign-in past its deadline is expired once, then unknown", () =>
    Effect.gen(function* () {
      const pending = yield* Pending.make;
      const id = yield* pending.begin(entry(10_000));
      expect((yield* pending.lookup(id, 10_000))._tag).toBe("expired");
      expect((yield* pending.lookup(id, 10_001))._tag).toBe("unknown");
    }),
  );

  it.effect("an id nobody issued is unknown, and ids are not guessable", () =>
    Effect.gen(function* () {
      const pending = yield* Pending.make;
      expect((yield* pending.lookup("made-up", 0))._tag).toBe("unknown");
      const a = yield* pending.begin(entry(1));
      const b = yield* pending.begin(entry(1));
      expect(a).not.toBe(b);
      expect(a.length).toBeGreaterThanOrEqual(40);
    }),
  );

  it.effect("keeps only the newest handful so abandoned sign-ins cannot pile up", () =>
    Effect.gen(function* () {
      const pending = yield* Pending.make;
      const first = yield* pending.begin(entry(10_000));
      for (let index = 0; index < 8; index += 1) yield* pending.begin(entry(10_000));
      expect((yield* pending.lookup(first, 0))._tag).toBe("unknown");
    }),
  );

  it.effect("slow_down lengthens the interval the phone is told to poll at", () =>
    Effect.gen(function* () {
      const pending = yield* Pending.make;
      const id = yield* pending.begin(entry(10_000));
      yield* pending.slowDown(id, 5);
      const found = yield* pending.lookup(id, 0);
      expect(found._tag === "found" ? found.entry.intervalSec : 0).toBe(10);
    }),
  );
});
