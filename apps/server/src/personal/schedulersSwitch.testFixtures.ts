import * as Effect from "effect/Effect";

import { PERSONAL_SCHEDULERS_ENV } from "./schedulersSwitch.ts";

/** Runs `effect` (layer build included) with T3CODE_PERSONAL_SCHEDULERS set to `value`, or unset. */
export const withSchedulersEnv =
  (value: string | undefined) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = process.env[PERSONAL_SCHEDULERS_ENV];
        if (value === undefined) delete process.env[PERSONAL_SCHEDULERS_ENV];
        else process.env[PERSONAL_SCHEDULERS_ENV] = value;
        return previous;
      }),
      () => effect,
      (previous) =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env[PERSONAL_SCHEDULERS_ENV];
          else process.env[PERSONAL_SCHEDULERS_ENV] = previous;
        }),
    );
