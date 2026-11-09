import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  applyProviderMaintenanceActionStates,
  enrichProviderSnapshotMetadata,
} from "./providerSnapshotMetadata.ts";

const checkedAt = "2026-11-08T09:00:00.000Z";

const codexProvider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.2.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt,
  models: [],
  slashCommands: [],
  skills: [],
  usageBalance: {
    checkedAt,
    status: "ready",
    balance: {
      currency: "USD",
      totalBalance: 12.5,
      grantedBalance: 0,
      toppedUpBalance: 12.5,
      isAvailable: true,
      fetchedAt: checkedAt,
    },
  },
};

describe("provider snapshot metadata", () => {
  it("fills the built-in catalog fields and keeps a driver balance", () => {
    const snapshot = enrichProviderSnapshotMetadata(codexProvider);

    expect(snapshot).toMatchObject({
      catalogId: "builtin:codex",
      source: "builtIn",
      publisher: "OpenAI",
      license: "Apache-2.0",
      openSource: true,
      showUsage: true,
      usageBalance: {
        status: "ready",
        balance: { currency: "USD", totalBalance: 12.5 },
      },
    });
  });

  it("projects the literal smoke, auto-update and go-back fields onto one snapshot", () => {
    const snapshot = applyProviderMaintenanceActionStates(
      enrichProviderSnapshotMetadata(codexProvider),
      {
        smokeCheck: {
          status: "failed",
          version: "1.2.0",
          checkedAt,
          message: "the probe exited 1",
          previousVersion: "1.1.0",
        },
        autoUpdate: {
          status: "rolled_back",
          message: "Went back to 1.1.0.",
          fromVersion: "1.1.0",
          toVersion: "1.2.0",
          finishedAt: checkedAt,
          nextAttemptAt: "2026-11-09T09:00:00.000Z",
        },
      },
      { canTest: true },
    );

    expect(snapshot).toMatchObject({
      catalogId: "builtin:codex",
      source: "builtIn",
      publisher: "OpenAI",
      license: "Apache-2.0",
      openSource: true,
      showUsage: true,
      previousVersion: "1.1.0",
      smokeCheck: {
        status: "failed",
        version: "1.2.0",
        previousVersion: "1.1.0",
      },
      autoUpdate: {
        status: "rolled_back",
        fromVersion: "1.1.0",
        toVersion: "1.2.0",
        finishedAt: checkedAt,
        nextAttemptAt: "2026-11-09T09:00:00.000Z",
      },
      setup: { canTest: true },
    });
  });
});
