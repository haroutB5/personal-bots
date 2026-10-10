import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { DeepSeekSettings } from "@t3tools/contracts";
import { writeFakeCli } from "../../testUtils/fakeCli.ts";
import { resolveDeepSeekModelCatalog } from "../DeepSeekModelCatalog.ts";
import { BUNDLED_MODEL_MANIFEST } from "../ModelManifest.ts";
import {
  buildInitialDeepSeekProviderSnapshot,
  checkDeepSeekProviderStatus,
} from "./DeepSeekProvider.ts";

const decodeDeepSeekSettings = Schema.decodeSync(DeepSeekSettings);
const catalog = resolveDeepSeekModelCatalog(BUNDLED_MODEL_MANIFEST);

/** A stubbed reading: these tests never touch the real balance endpoint. */
const BALANCE_READY = {
  status: "ready",
  amounts: {
    currency: "USD",
    totalBalance: 12.34,
    grantedBalance: 2,
    toppedUpBalance: 10.34,
    isAvailable: true,
  },
  fetchedAtMs: 1_700_000_000_000,
} as const;

const stubBalance = { readBalance: async () => BALANCE_READY };

const writeFakeClaudeCli = (versionOutput: string, exitCode: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-deepseek-probe-" });
    return writeFakeCli({
      directory: dir,
      name: "claude",
      source: [
        'if (process.argv[2] === "--version") {',
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        `  process.stdout.write(${JSON.stringify(versionOutput)});`,
        `  process.exit(${exitCode});`,
        "}",
        "process.exit(1);",
        "",
      ].join("\n"),
    });
  });

describe("DeepSeekProvider", () => {
  it.effect("builds a disabled initial snapshot naming DeepSeek", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDeepSeekProviderSnapshot(
        decodeDeepSeekSettings({ enabled: false }),
        catalog,
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.displayName).toBe("DeepSeek");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["deepseek-flash"]);
    }),
  );

  it.effect("reports the binary as missing when the path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkDeepSeekProviderStatus(
        decodeDeepSeekSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/claude-binary",
        }),
        { ANTHROPIC_AUTH_TOKEN: "fake-deepseek-key" },
        catalog,
        stubBalance,
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports ready with Flash when the binary answers and a key is set", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const claudePath = yield* writeFakeClaudeCli("claude 2.1.280\n", 0);
          return yield* checkDeepSeekProviderStatus(
            decodeDeepSeekSettings({ enabled: true, binaryPath: claudePath }),
            { ANTHROPIC_AUTH_TOKEN: "fake-deepseek-key" },
            catalog,
            stubBalance,
          );
        }),
      );
      expect(snapshot.status).toBe("ready");
      expect(snapshot.version).toBe("2.1.280");
      expect(snapshot.auth.status).toBe("authenticated");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["deepseek-flash"]);
      // No subscription/account probing on DeepSeek: no usage windows, no reset flow.
      expect(snapshot.usageLimits).toBeUndefined();
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("publishes the prepaid balance it read, with the provider's own fetch time", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const claudePath = yield* writeFakeClaudeCli("claude 2.1.280\n", 0);
          return yield* checkDeepSeekProviderStatus(
            decodeDeepSeekSettings({ enabled: true, binaryPath: claudePath }),
            { ANTHROPIC_AUTH_TOKEN: "fake-deepseek-key" },
            catalog,
            stubBalance,
          );
        }),
      );
      expect(snapshot.usageBalance).toMatchObject({
        status: "ready",
        balance: {
          currency: "USD",
          totalBalance: 12.34,
          grantedBalance: 2,
          toppedUpBalance: 10.34,
          isAvailable: true,
          fetchedAt: DateTime.formatIso(DateTime.makeUnsafe(1_700_000_000_000)),
        },
      });
      expect(snapshot.usageBalance?.message).toBeUndefined();
      expect(Number.isFinite(Date.parse(snapshot.usageBalance!.checkedAt))).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the last good numbers and says the refresh failed, in our own words", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const claudePath = yield* writeFakeClaudeCli("claude 2.1.280\n", 0);
          return yield* checkDeepSeekProviderStatus(
            decodeDeepSeekSettings({ enabled: true, binaryPath: claudePath }),
            { ANTHROPIC_AUTH_TOKEN: "fake-deepseek-key" },
            catalog,
            {
              readBalance: async () => ({
                status: "failed" as const,
                reason: "http_error" as const,
                lastGood: { amounts: BALANCE_READY.amounts, fetchedAtMs: 1_700_000_000_000 },
              }),
            },
          );
        }),
      );
      expect(snapshot.usageBalance?.status).toBe("failed");
      expect(snapshot.usageBalance?.balance?.totalBalance).toBe(12.34);
      expect(snapshot.usageBalance?.message).toBe(
        "DeepSeek would not return the balance for this key.",
      );
      expect(snapshot.status).toBe("ready");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("shows no balance at all when a failed read has no earlier numbers", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const claudePath = yield* writeFakeClaudeCli("claude 2.1.280\n", 0);
          return yield* checkDeepSeekProviderStatus(
            decodeDeepSeekSettings({ enabled: true, binaryPath: claudePath }),
            { ANTHROPIC_AUTH_TOKEN: "fake-deepseek-key" },
            catalog,
            {
              readBalance: async () => ({
                status: "failed" as const,
                reason: "network_error" as const,
                lastGood: null,
              }),
            },
          );
        }),
      );
      expect(snapshot.usageBalance?.status).toBe("failed");
      expect(snapshot.usageBalance?.balance).toBeUndefined();
      expect(snapshot.usageBalance?.message).toBe("DeepSeek could not be reached for the balance.");
      // A money figure never takes the provider's own health down with it.
      expect(snapshot.status).toBe("ready");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("never lets a throwing balance read fail the probe", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const claudePath = yield* writeFakeClaudeCli("claude 2.1.280\n", 0);
          return yield* checkDeepSeekProviderStatus(
            decodeDeepSeekSettings({ enabled: true, binaryPath: claudePath }),
            { ANTHROPIC_AUTH_TOKEN: "fake-deepseek-key" },
            catalog,
            {
              readBalance: async () => {
                throw new Error("boom");
              },
            },
          );
        }),
      );
      expect(snapshot.status).toBe("ready");
      expect(snapshot.usageBalance?.status).toBe("failed");
      expect(snapshot.usageBalance?.message).toBe("DeepSeek could not be reached for the balance.");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("asks for ANTHROPIC_AUTH_TOKEN when the binary is fine but no key is set", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const claudePath = yield* writeFakeClaudeCli("claude 2.1.280\n", 0);
          return yield* checkDeepSeekProviderStatus(
            decodeDeepSeekSettings({ enabled: true, binaryPath: claudePath }),
            {},
            catalog,
          );
        }),
      );
      expect(snapshot.status).toBe("error");
      expect(snapshot.auth.status).toBe("unauthenticated");
      expect(snapshot.message).toMatch(/ANTHROPIC_AUTH_TOKEN/);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports an installed CLI as unhealthy when --version exits non-zero", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const claudePath = yield* writeFakeClaudeCli("broken\n", 2);
          return yield* checkDeepSeekProviderStatus(
            decodeDeepSeekSettings({ enabled: true, binaryPath: claudePath }),
            { ANTHROPIC_AUTH_TOKEN: "fake-deepseek-key" },
            catalog,
            stubBalance,
          );
        }),
      );
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
