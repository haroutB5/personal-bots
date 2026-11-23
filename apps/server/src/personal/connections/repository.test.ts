import { ConnectionId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../../persistence/Migrations.ts";
import * as Repository from "./repository.ts";

const at = DateTime.makeUnsafe("2026-09-20T10:00:00.000Z");

const github: Repository.StoredPersonalConnection = {
  connectionId: ConnectionId.make("connection-github"),
  vendorId: "github",
  status: "connecting",
  account: null,
  verifiedCapabilities: [],
  settings: { whatsappDailySendCap: null },
  credentialRef: "opaque-github",
  credentialVersion: 1,
  lastValidatedAt: null,
  createdAt: at,
  updatedAt: at,
};

const TestLayer = Repository.layer.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

describe("PersonalConnectionRepository", () => {
  it.effect("creates, reads, updates, lists and removes connection rows", () =>
    Effect.gen(function* () {
      // 75 is where the settings column arrives; the repository writes it.
      yield* runMigrations({ toMigrationInclusive: 75 });
      const repository = yield* Repository.PersonalConnectionRepository;

      yield* repository.create(github);
      expect(Option.getOrThrow(yield* repository.get(github.connectionId))).toEqual(github);
      expect(Option.getOrThrow(yield* repository.getByVendor("github"))).toEqual(github);

      const connected: Repository.StoredPersonalConnection = {
        ...github,
        status: "connected",
        account: {
          accountId: "account-1",
          accountName: "Octocat",
          teamId: "team-1",
          teamName: "Platform",
        },
        verifiedCapabilities: ["repository:write", "deployment:read"],
        credentialVersion: 2,
        lastValidatedAt: at,
      };
      expect(yield* repository.update(connected)).toBe(true);
      const listed = yield* repository.list();
      expect(listed).toEqual([connected]);

      expect(yield* repository.remove(github.connectionId)).toBe(true);
      expect(Option.isNone(yield* repository.get(github.connectionId))).toBe(true);
      expect(yield* repository.remove(github.connectionId)).toBe(false);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("keeps one row per mailbox and finds it by its address", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 161 });
      const repository = yield* Repository.PersonalConnectionRepository;
      const mailbox = (id: string, vendorId: "gmail" | "outlook", address: string) => ({
        ...github,
        connectionId: ConnectionId.make(id),
        vendorId,
        status: "connected" as const,
        account: { accountId: address, accountName: address, teamId: null, teamName: null },
        credentialRef: `opaque-${id}`,
      });

      yield* repository.create(mailbox("g-1", "gmail", "one@gmail.com"));
      yield* repository.create(mailbox("g-2", "gmail", "two@gmail.com"));
      yield* repository.create(mailbox("o-1", "outlook", "one@gmail.com"));

      const found = Option.getOrThrow(yield* repository.getByAccount("gmail", "TWO@gmail.com"));
      expect(found.connectionId).toBe("g-2");
      expect(
        Option.getOrThrow(yield* repository.getByAccount("outlook", "one@gmail.com")).connectionId,
      ).toBe("o-1");
      expect(Option.isNone(yield* repository.getByAccount("outlook", "two@gmail.com"))).toBe(true);

      const duplicate = yield* Effect.flip(
        repository.create(mailbox("g-3", "gmail", "one@gmail.com")),
      );
      expect(duplicate._tag).toBe("PersistenceSqlError");
      expect((yield* repository.list()).map((row) => row.connectionId)).toEqual([
        "g-1",
        "g-2",
        "o-1",
      ]);
    }).pipe(Effect.provide(TestLayer)),
  );
});
