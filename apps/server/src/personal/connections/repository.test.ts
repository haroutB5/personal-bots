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

const TestLayer = Repository.layer.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()));

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
});
