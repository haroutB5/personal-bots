import { PersonalLoginId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as PersonalLoginRepository from "./PersonalLoginRepository.ts";

const layer = PersonalLoginRepository.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

const addSite = (origin: string, label: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO personal_sensitive_sites (origin, label) VALUES (${origin}, ${label})`;
  });

const addLogin = (input: {
  readonly origin: string;
  readonly label: string;
  readonly sensitive: boolean;
}) =>
  Effect.gen(function* () {
    const logins = yield* PersonalLoginRepository.PersonalLoginRepository;
    const now = yield* DateTime.now;
    const loginId = PersonalLoginId.make(`login-${input.label}`);
    yield* logins.create({
      loginId,
      label: input.label,
      origin: input.origin,
      username: "person",
      secretRef: `ref-${input.label}`,
      sensitive: false,
      createdAt: now,
      updatedAt: now,
    });
    if (input.sensitive) yield* logins.setSensitive({ loginId, sensitive: true, updatedAt: now });
  });

describe("sensitive sites", () => {
  it.effect("lists a site that has no saved login", () =>
    Effect.gen(function* () {
      const logins = yield* PersonalLoginRepository.PersonalLoginRepository;
      yield* addSite("https://bank.example", "Barclays");
      expect(yield* logins.sensitiveOrigins()).toEqual(["https://bank.example"]);
      expect(yield* logins.sensitiveSites()).toEqual([
        { origin: "https://bank.example", label: "Barclays" },
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("joins flagged logins and imported sites without repeating an origin", () =>
    Effect.gen(function* () {
      const logins = yield* PersonalLoginRepository.PersonalLoginRepository;
      yield* addLogin({ origin: "https://bank.example", label: "Bank", sensitive: true });
      yield* addLogin({ origin: "https://shop.example", label: "Shop", sensitive: false });
      yield* addSite("https://bank.example", "Barclays");
      yield* addSite("https://mail.example", "Mail");
      expect((yield* logins.sensitiveOrigins()).toSorted()).toEqual([
        "https://bank.example",
        "https://mail.example",
      ]);
      expect(
        (yield* logins.sensitiveSites()).toSorted((a, b) => a.label.localeCompare(b.label)),
      ).toEqual([
        { origin: "https://bank.example", label: "Bank" },
        { origin: "https://bank.example", label: "Barclays" },
        { origin: "https://mail.example", label: "Mail" },
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("lists nothing when nothing is sensitive", () =>
    Effect.gen(function* () {
      const logins = yield* PersonalLoginRepository.PersonalLoginRepository;
      yield* addLogin({ origin: "https://shop.example", label: "Shop", sensitive: false });
      expect(yield* logins.sensitiveOrigins()).toEqual([]);
      expect(yield* logins.sensitiveSites()).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );
});
