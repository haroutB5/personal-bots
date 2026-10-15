import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";

import {
  logPersonalSchedulersAtBoot,
  PERSONAL_SCHEDULERS_OFF_WARNING,
  personalSchedulersOff,
} from "./schedulersSwitch.ts";

const env = (value: string | undefined) => ({ T3CODE_PERSONAL_SCHEDULERS: value });

/** The lines the boot check logs, with their level. */
const bootLines = (value: string | undefined) => {
  const lines: Array<{ readonly level: string; readonly text: string }> = [];
  const sink = Logger.make<unknown, void>((options) => {
    lines.push({
      level: options.logLevel,
      text: Array.isArray(options.message) ? options.message.join(" ") : String(options.message),
    });
  });
  return logPersonalSchedulersAtBoot(env(value)).pipe(
    Effect.provide(Logger.layer([sink], { mergeWithExisting: false })),
    Effect.map(() => lines),
  );
};

it("off, 0, false, no and disabled turn the schedulers off, any case and padding", () => {
  for (const value of ["off", "OFF", " off ", "0", "false", "no", "Disabled"]) {
    expect(personalSchedulersOff(env(value))).toBe(true);
  }
});

it("unset, empty, on or anything else leaves them on", () => {
  for (const value of [undefined, "", "on", "1", "true", "yes", "of"]) {
    expect(personalSchedulersOff(env(value))).toBe(false);
  }
});

it.effect("logs exactly one WARN at boot when off, nothing when on", () =>
  Effect.gen(function* () {
    expect(yield* bootLines("off")).toEqual([
      { level: "Warn", text: PERSONAL_SCHEDULERS_OFF_WARNING },
    ]);
    expect(PERSONAL_SCHEDULERS_OFF_WARNING).toContain("T3CODE_PERSONAL_SCHEDULERS=off");
    expect(yield* bootLines(undefined)).toEqual([]);
    expect(yield* bootLines("on")).toEqual([]);
  }),
);
