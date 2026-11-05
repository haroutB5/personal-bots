// @effect-diagnostics nodeBuiltinImport:off
import { expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ProviderDriverKind } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import {
  createProviderVersionAdvisory,
  makePackageManagedProviderMaintenanceResolver,
  makeTargetedProviderUpdateAction,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../../provider/providerMaintenance.ts";

const driver = (value: string) => ProviderDriverKind.make(value);
const makeTempDir = (name: string) =>
  Crypto.Crypto.pipe(
    Effect.flatMap((crypto) => crypto.randomUUIDv4),
    Effect.map((id) => NodePath.join(NodeOS.tmpdir(), `${name}-${id}`)),
  );

function writeExecutable(path: string, body = "#!/bin/sh\n") {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, body);
  NodeFS.chmodSync(path, 0o755);
}

it.layer(NodeServices.layer)("mise provider maintenance", (it) => {
  it.effect("updates a mise-managed Claude Code with mise and trusts mise's latest", () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDir("t3-mise-capabilities");
      const toolDir = NodePath.join(tempDir, "mise", "installs", "claude");
      const versionDir = NodePath.join(toolDir, "2.1.317");
      const binaryPath = NodePath.join(versionDir, "claude");
      writeExecutable(binaryPath);
      NodeFS.writeFileSync(
        NodePath.join(toolDir, ".mise.backend.toml"),
        'short = "claude"\nfull = "aqua:anthropics/claude-code"\n',
      );
      NodeFS.symlinkSync("2.1.317", NodePath.join(toolDir, "latest"));

      const binDir = NodePath.join(tempDir, "bin");
      const misePath = NodePath.join(binDir, "mise");
      writeExecutable(
        misePath,
        [
          "#!/bin/sh",
          'if [ "$1" = "latest" ] && [ "$2" = "claude" ]; then',
          "  echo 2.1.317",
          "  exit 0",
          "fi",
          'if [ "$1" = "install" ]; then',
          '  case "$2" in',
          `    *@latest) ln -sfn 2.1.317 "${NodePath.join(toolDir, "latest")}" ;;`,
          "  esac",
          "  exit 0",
          "fi",
          "exit 1",
          "",
        ].join("\n"),
      );

      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
        makePackageManagedProviderMaintenanceResolver({
          provider: driver("claudeAgent"),
          npmPackageName: "@anthropic-ai/claude-code",
          nativeUpdate: null,
        }),
        {
          binaryPath: NodePath.join(toolDir, "latest", "claude"),
          env: { PATH: binDir },
        },
      ).pipe(Effect.provideService(HostProcessPlatform, "linux"));

      expect(capabilities.update).toMatchObject({
        command: "mise install claude@latest",
        executable: misePath,
        args: ["install", "claude@latest"],
        lockKey: "mise",
        latestPath: NodePath.join(toolDir, "latest"),
      });
      expect(capabilities.latestVersion).toBe("2.1.317");

      const previous = makeTargetedProviderUpdateAction(capabilities, "2.1.310");
      expect(previous?.executable).toBe("/bin/sh");
      expect(previous?.args[0]).toBe("-c");
      expect(previous?.args[1]).toContain("install claude@2.1.310");
      expect(previous?.args[1]).toContain(`ln -sfn 2.1.310 ${NodePath.join(toolDir, "latest")}`);
      NodeChildProcess.execFileSync("/bin/sh", previous!.args, {
        env: { PATH: `${binDir}:/usr/bin:/bin` },
      });
      expect(NodeFS.readlinkSync(NodePath.join(toolDir, "latest"))).toBe("2.1.310");

      const advisory = createProviderVersionAdvisory({
        driver: driver("claudeAgent"),
        currentVersion: "2.1.317",
        latestVersion: "2.1.317",
        maintenanceCapabilities: capabilities,
      });
      expect(advisory.status).toBe("current");
      expect(advisory.canUpdate).toBe(true);
      expect(advisory.canInstallVersion).toBe(true);
    }),
  );
});
