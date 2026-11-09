import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { DeepSeekBalanceRead } from "./balance.ts";
import type { ProviderCatalog } from "@t3tools/provider-core/server/ModelCatalog";

import { resolveDeepSeekModelCatalog } from "./catalog.ts";
import { DeepSeekSettings } from "../settings.ts";
import {
  buildInitialDeepSeekProviderSnapshot,
  checkDeepSeekProviderStatus,
  DEEPSEEK_KEY_MISSING_MESSAGE,
} from "./status.ts";

const decode = Schema.decodeUnknownSync(DeepSeekSettings);

const catalog: ProviderCatalog = {
  defaultChatModel: "deepseek-flash",
  models: [
    {
      slug: "deepseek-flash",
      name: "DeepSeek V4.1 Flash",
      aliases: ["deepseek-v4-flash", "vision-exp"],
      status: "current",
      capabilities: { optionDescriptors: [] },
      adapter: {},
      profileAdapter: {},
    },
  ],
};

const deepSeekCatalog = resolveDeepSeekModelCatalog(catalog);

/** A pin-answering runtime in a temp dir, so no test reads the live install. */
function withFakeDshRuntime<A, E, R>(
  use: (runtimeDir: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | FileSystem.FileSystem | Path.Path> {
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem
        .makeTempDirectory({ prefix: "deepseek-status-" })
        .pipe(Effect.orDie);
      const bin = path.join(dir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
      yield* fileSystem.makeDirectory(path.dirname(bin), { recursive: true }).pipe(Effect.orDie);
      yield* fileSystem.writeFileString(bin, 'console.log("0.2.1-rc.3");\n').pipe(Effect.orDie);
      return dir;
    }),
    use,
    (dir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.remove(dir, { recursive: true, force: true }).pipe(Effect.ignore);
      }),
  );
}

const readyRead = (totalBalance: number): DeepSeekBalanceRead => ({
  status: "ready",
  fetchedAtMs: Date.UTC(2026, 9, 14, 9, 55, 0),
  amounts: {
    currency: "USD",
    totalBalance,
    grantedBalance: 0,
    toppedUpBalance: totalBalance,
    isAvailable: true,
  },
});

const lastGoodRead = (totalBalance: number) => {
  const read = readyRead(totalBalance);
  if (read.status !== "ready") throw new Error("a ready read was expected");
  return { amounts: read.amounts, fetchedAtMs: read.fetchedAtMs };
};

it.layer(NodeServices.layer)("DeepSeekProvider", (it) => {
  it.effect("reports a disabled instance as disabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDeepSeekProviderSnapshot(
        decode({ enabled: false }),
        deepSeekCatalog,
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["deepseek-flash"]);
    }),
  );

  it.effect("asks for the key field when enabled and no key is set", () =>
    withFakeDshRuntime((runtimeDir) =>
      Effect.gen(function* () {
        const snapshot = yield* checkDeepSeekProviderStatus(
          decode({ enabled: true, engine: "dsh", dshRuntimePath: runtimeDir }),
          {},
          deepSeekCatalog,
        );
        expect({
          auth: snapshot.auth.status,
          installed: snapshot.installed,
          status: snapshot.status,
          message: snapshot.message,
          usageBalance: snapshot.usageBalance,
        }).toEqual({
          auth: "unauthenticated",
          installed: true,
          status: "warning",
          message: DEEPSEEK_KEY_MISSING_MESSAGE,
          usageBalance: undefined,
        });
        expect(snapshot.message).not.toMatch(/ANTHROPIC_AUTH_TOKEN/);
      }),
    ),
  );

  it.effect("offers the agent mode on the harness engine and not on the other", () =>
    withFakeDshRuntime((runtimeDir) =>
      Effect.gen(function* () {
        const dsh = yield* checkDeepSeekProviderStatus(
          decode({ enabled: true, engine: "dsh", dshRuntimePath: runtimeDir }),
          { ANTHROPIC_AUTH_TOKEN: "fake-deepseek-key" },
          deepSeekCatalog,
        );
        const flash = dsh.models.find((model) => model.slug === "deepseek-flash");
        const agentMode = flash?.capabilities?.optionDescriptors?.find(
          (descriptor) => descriptor.id === "agentMode",
        );
        expect(agentMode?.type).toBe("select");
        expect(
          agentMode?.type === "select" ? agentMode.options.map((option) => option.id) : [],
        ).toEqual(["standard", "code", "minimal"]);

        const claude = yield* checkDeepSeekProviderStatus(
          decode({ enabled: true, engine: "claude-code", binaryPath: "missing-claude-for-test" }),
          { ANTHROPIC_AUTH_TOKEN: "fake-deepseek-key" },
          deepSeekCatalog,
        );
        const claudeFlash = claude.models.find((model) => model.slug === "deepseek-flash");
        expect(
          claudeFlash?.capabilities?.optionDescriptors?.some(
            (descriptor) => descriptor.id === "agentMode",
          ),
        ).toBe(false);
      }),
    ),
  );

  it.effect("publishes a ready balance read with checkedAt and the provider's numbers", () =>
    withFakeDshRuntime((runtimeDir) =>
      Effect.gen(function* () {
        const checkedAt = Date.UTC(2026, 9, 14, 10, 0, 0);
        const reads: Array<string> = [];
        const snapshot = yield* checkDeepSeekProviderStatus(
          decode({ enabled: true, engine: "dsh", dshRuntimePath: runtimeDir }),
          { ANTHROPIC_AUTH_TOKEN: "fake-deepseek-key" },
          deepSeekCatalog,
          {
            readBalance: async (token) => {
              reads.push(token);
              return readyRead(0.94);
            },
            now: () => checkedAt,
          },
        );

        expect(reads).toEqual(["fake-deepseek-key"]);
        expect(snapshot.usageBalance).toEqual({
          checkedAt: "2026-10-14T10:00:00.000Z",
          status: "ready",
          balance: {
            currency: "USD",
            totalBalance: 0.94,
            grantedBalance: 0,
            toppedUpBalance: 0.94,
            isAvailable: true,
            fetchedAt: "2026-10-14T09:55:00.000Z",
          },
        });
      }),
    ),
  );

  it.effect("marks a 401 auth_error and keeps the last good balance", () =>
    withFakeDshRuntime((runtimeDir) =>
      Effect.gen(function* () {
        const snapshot = yield* checkDeepSeekProviderStatus(
          decode({ enabled: true, engine: "dsh", dshRuntimePath: runtimeDir }),
          { ANTHROPIC_AUTH_TOKEN: "fake-deepseek-key" },
          deepSeekCatalog,
          {
            readBalance: async () => ({
              status: "failed",
              reason: "auth_error",
              lastGood: lastGoodRead(0.94),
            }),
            now: () => Date.UTC(2026, 9, 14, 10, 0, 0),
          },
        );

        expect(snapshot.usageBalance).toEqual({
          checkedAt: "2026-10-14T10:00:00.000Z",
          status: "failed",
          failureReason: "auth_error",
          message: "DeepSeek did not accept this key, so it would not return the balance.",
          balance: {
            currency: "USD",
            totalBalance: 0.94,
            grantedBalance: 0,
            toppedUpBalance: 0.94,
            isAvailable: true,
            fetchedAt: "2026-10-14T09:55:00.000Z",
          },
        });
      }),
    ),
  );

  it.effect("does not blame the key for a rate limit or a server fault", () =>
    withFakeDshRuntime((runtimeDir) =>
      Effect.gen(function* () {
        const snapshot = yield* checkDeepSeekProviderStatus(
          decode({ enabled: true, engine: "dsh", dshRuntimePath: runtimeDir }),
          { ANTHROPIC_AUTH_TOKEN: "fake-deepseek-key" },
          deepSeekCatalog,
          {
            readBalance: async () => ({ status: "failed", reason: "http_error", lastGood: null }),
            now: () => Date.UTC(2026, 9, 14, 10, 0, 0),
          },
        );

        expect(snapshot.usageBalance).toEqual({
          checkedAt: "2026-10-14T10:00:00.000Z",
          status: "failed",
          failureReason: "http_error",
          message: "DeepSeek would not return the balance for this key.",
        });
        expect(snapshot.usageBalance?.message).not.toMatch(/did not accept/i);
      }),
    ),
  );
});
