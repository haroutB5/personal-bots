import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { providerRow } from "./providerRows.ts";

const checkedAt = "2026-11-08T09:00:00.000Z";

const registryProvider: ServerProvider = {
  instanceId: ProviderInstanceId.make("test-agent"),
  driver: ProviderDriverKind.make("acpRegistry"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt,
  models: [],
  slashCommands: [],
  skills: [],
  catalogId: "test-agent",
  source: "registry",
  versionAdvisory: {
    status: "behind_latest",
    currentVersion: "1.0.0",
    latestVersion: "1.1.0",
    updateCommand: "mise install test-agent@latest",
    canUpdate: true,
    canInstallVersion: true,
    checkedAt,
    message: null,
  },
};

describe("registry provider update action", () => {
  it("keeps the update button off and says where the update runs", () => {
    const row = providerRow({
      snapshot: registryProvider,
      label: "Test Agent",
      bots: [],
      install: null,
      now: new Date(checkedAt),
    });

    expect(row.state).toBe("updateAvailable");
    expect(row.action).toBeNull();
    expect(row.detail).toBe("Update it on your computer.");
  });
});
