import type { PersonalBot, ServerProvider } from "@t3tools/contracts";
import { PersonalBotId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  instanceConfigOf,
  modelsShown,
  providerScreenModel,
  providerSourceLine,
  providerTestLine,
  versionLine,
} from "./providerScreenModel";

const provider = (fields: Partial<ServerProvider> = {}): ServerProvider =>
  ({
    instanceId: "claude",
    driver: "claudeAgent",
    displayName: "Claude",
    enabled: true,
    installed: true,
    version: "1.2.3",
    status: "ready",
    auth: { status: "authenticated", label: "Harout" },
    checkedAt: "2026-11-05T10:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...fields,
  }) as unknown as ServerProvider;

const bot = (fields: Partial<PersonalBot> = {}): PersonalBot =>
  ({
    botId: PersonalBotId.make("bot-1"),
    name: "Juno",
    sortOrder: 0,
    modelSelection: { instanceId: "claude", model: "sonnet" },
    ...fields,
  }) as unknown as PersonalBot;

describe("providerScreenModel", () => {
  it("names the provider, its users and a ready tone", () => {
    const model = providerScreenModel({
      snapshot: provider(),
      bots: [bot(), bot({ botId: PersonalBotId.make("bot-2"), name: "Poteto", sortOrder: 1 })],
      install: null,
    });
    expect(model.label).toBe("Claude");
    expect(model.users).toEqual(["Juno", "Poteto"]);
    expect(model.tone).toBe("ready");
    expect(model.installed).toBe(true);
  });

  it("treats a signed-out provider as setup", () => {
    const model = providerScreenModel({
      snapshot: provider({ auth: { status: "unauthenticated" } }),
      bots: [],
      install: null,
    });
    expect(model.authNeeded).toBe(true);
    expect(model.tone).toBe("setup");
  });

  it("shows three models until expanded", () => {
    const models = [
      { slug: "a", name: "A" },
      { slug: "b", name: "B" },
      { slug: "c", name: "C" },
      { slug: "d", name: "D" },
    ] as unknown as ServerProvider["models"];
    expect(modelsShown(models, false).map((entry) => entry.slug)).toEqual(["a", "b", "c"]);
    expect(modelsShown(models, true)).toHaveLength(4);
  });
});

describe("providerTestLine", () => {
  const smoke = (status: "passed" | "failed") =>
    provider({
      smokeCheck: {
        status,
        version: "1.2.3",
        checkedAt: "2026-11-06T10:00:00.000Z",
        message: null,
        manual: true,
        ...(status === "passed" ? { durationMs: 400 } : {}),
      },
    } as Partial<ServerProvider>);

  it("shows a passed test under the button", () => {
    const line = providerTestLine(smoke("passed"), new Date("2026-11-06T10:30:00.000Z"));
    expect(line).toContain("Passed");
    expect(line).toContain("0.4 s");
  });

  it("shows a failed test under the button", () => {
    expect(providerTestLine(smoke("failed"), new Date("2026-11-06T10:30:00.000Z"))).toContain(
      "Failed",
    );
  });

  it("says nothing before the first test or for an older version", () => {
    expect(providerTestLine(provider())).toBeNull();
    expect(
      providerTestLine(
        provider({
          version: "1.2.4",
          smokeCheck: {
            status: "passed",
            version: "1.2.3",
            checkedAt: "2026-11-06T10:00:00.000Z",
            message: null,
            manual: true,
          },
        } as Partial<ServerProvider>),
      ),
    ).toBeNull();
  });
});

describe("versionLine", () => {
  it("reads the advisory and falls back to the bare version", () => {
    expect(versionLine(provider(), new Date("2026-11-05T10:00:00.000Z"))).toBe("Version 1.2.3");
    expect(
      versionLine(
        provider({
          versionAdvisory: { status: "behind_latest", latestVersion: "1.3.0" },
        } as Partial<ServerProvider>),
        new Date("2026-11-05T10:00:00.000Z"),
      ),
    ).toBe("New version 1.3.0");
    expect(
      versionLine(
        provider({ versionAdvisory: { status: "current" } } as Partial<ServerProvider>),
        new Date("2026-11-05T10:30:00.000Z"),
      ),
    ).toBe("Up to date · checked 30m ago");
  });
});

describe("instanceConfigOf", () => {
  it("returns the explicit instance", () => {
    const config = instanceConfigOf(
      {
        providerInstances: { claude: { driver: "claudeAgent", enabled: false, config: {} } },
      } as never,
      "claude",
    );
    expect(config?.enabled).toBe(false);
  });

  it("returns null for an instance that is not configured", () => {
    expect(instanceConfigOf({ providerInstances: {} } as never, "someone-else")).toBeNull();
  });
});

describe("providerSourceLine", () => {
  it("names the registry for added providers and hbots for built-ins", () => {
    expect(providerSourceLine(provider())).toBe("Built into hbots");
    expect(
      providerSourceLine(provider({ source: "registry", publisher: "Acme", license: "MIT" })),
    ).toBe("ACP registry · Acme · MIT");
  });
});
