import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
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
          );
        }),
      );
      expect(snapshot.status).toBe("ready");
      expect(snapshot.version).toBe("2.1.280");
      expect(snapshot.auth.status).toBe("authenticated");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["deepseek-flash"]);
      // No subscription/account probing on DeepSeek: no usage block, no reset flow.
      expect(snapshot.usageLimits).toBeUndefined();
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
          );
        }),
      );
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
