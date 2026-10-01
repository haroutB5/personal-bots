import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as PersonalBrowserProtectionRepository from "./PersonalBrowserProtectionRepository.ts";

const layer = PersonalBrowserProtectionRepository.layer.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);

it.layer(layer)("PersonalBrowserProtectionRepository", (it) => {
  it.effect("round-trips the login origins, including unknown", () =>
    Effect.gen(function* () {
      const repository =
        yield* PersonalBrowserProtectionRepository.PersonalBrowserProtectionRepository;
      yield* repository.save({
        profileId: "default",
        loginUsed: true,
        loginOrigins: ["https://app.example.com", "http://127.0.0.1:4000"],
        taintedOrigins: ["http://localhost:3000"],
      });
      assert.deepEqual(
        yield* repository.load("default"),
        Option.some({
          profileId: "default",
          loginUsed: true,
          loginOrigins: ["https://app.example.com", "http://127.0.0.1:4000"],
          taintedOrigins: ["http://localhost:3000"],
        }),
      );

      yield* repository.save({
        profileId: "default",
        loginUsed: true,
        loginOrigins: null,
        taintedOrigins: [],
      });
      assert.deepEqual(
        Option.map(yield* repository.load("default"), (state) => state.loginOrigins),
        Option.some(null),
      );
    }),
  );
});
