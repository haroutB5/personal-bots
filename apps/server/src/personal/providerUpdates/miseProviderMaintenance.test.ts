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
  makeProviderMaintenanceCapabilities,
  makeTargetedProviderUpdateAction,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../../provider/providerMaintenance.ts";
import { listMiseInstalledVersions, miseVersionsNewerThan } from "./miseProviderMaintenance.ts";

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

  it.effect(
    "a mise rollback removes the failed version so a later install keeps it rolled back",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-mise-rollback");
        const toolDir = NodePath.join(tempDir, "mise", "installs", "claude");
        const good = "2.1.317";
        const newer = ["2.1.318", "2.1.319"];
        const latestPath = NodePath.join(toolDir, "latest");
        const writeVersion = (version: string) => {
          const dir = NodePath.join(toolDir, version);
          NodeFS.mkdirSync(dir, { recursive: true });
          writeExecutable(NodePath.join(dir, "claude"));
        };
        NodeFS.mkdirSync(toolDir, { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(toolDir, ".mise.backend.toml"),
          'short = "claude"\nfull = "aqua:anthropics/claude-code"\n',
        );
        writeVersion(good);
        for (const version of newer) writeVersion(version);
        for (const alias of ["latest", "2", "2.1"]) {
          NodeFS.symlinkSync(`./${newer.at(-1)!}`, NodePath.join(toolDir, alias));
        }

        const binDir = NodePath.join(tempDir, "bin");
        const misePath = NodePath.join(binDir, "mise");
        // Like mise 2026.10.19: after any install or uninstall every tool's
        // latest and major/minor aliases point at its highest installed version.
        writeExecutable(
          misePath,
          [
            "#!/bin/sh",
            `root="${tempDir}/mise/installs"`,
            "rebuild() {",
            '  for t in "$root"/*/; do',
            '    t="${t%/}"',
            `    hi=$(ls "$t" | grep -E '^[0-9]+\\.[0-9]+\\.[0-9]+$' | sort -V | tail -n 1)`,
            '    [ -z "$hi" ] && continue',
            '    rm -f "$t/latest"',
            `    find "$t" -maxdepth 1 -type l -name '[0-9]*' -delete`,
            '    ln -sfn "./$hi" "$t/latest"',
            '    ln -sfn "./$hi" "$t/${hi%%.*}"',
            '    ln -sfn "./$hi" "$t/${hi%.*}"',
            "  done",
            "}",
            'case "$1" in',
            '  install) spec="$2"; tool="${spec%%@*}"; version="${spec#*@}"',
            '    mkdir -p "$root/$tool/$version"; : > "$root/$tool/$version/$tool"',
            "    rebuild ;;",
            '  uninstall) spec="$2"; tool="${spec%%@*}"; version="${spec#*@}"',
            '    rm -rf "$root/$tool/$version"',
            "    rebuild ;;",
            "esac",
            "exit 0",
            "",
          ].join("\n"),
        );

        const capabilities = makeProviderMaintenanceCapabilities({
          provider: driver("claudeAgent"),
          packageName: "@anthropic-ai/claude-code",
          updateExecutable: misePath,
          updateArgs: ["install", "claude@latest"],
          updateLockKey: "mise",
          latestPath,
          platform: "linux",
        });
        const installed = yield* listMiseInstalledVersions(toolDir);
        const uninstallVersions = miseVersionsNewerThan(installed, good);
        expect(uninstallVersions).toEqual(newer);
        const rollback = makeTargetedProviderUpdateAction(capabilities, good, {
          uninstallVersions,
        });
        for (const version of newer) {
          expect(rollback?.args[1]).toContain(`uninstall claude@${version}`);
        }
        NodeChildProcess.execFileSync("/bin/sh", rollback!.args, {
          env: { PATH: `${binDir}:/usr/bin:/bin` },
        });

        for (const version of newer) {
          expect(NodeFS.existsSync(NodePath.join(toolDir, version))).toBe(false);
        }
        const aliasTarget = (alias: string) =>
          NodeFS.readlinkSync(NodePath.join(toolDir, alias)).replace(/^\.\//, "");
        for (const alias of ["latest", "2", "2.1"]) {
          expect(aliasTarget(alias)).toBe(good);
        }

        // The next install of any mise tool rebuilds the aliases again.
        NodeChildProcess.execFileSync(misePath, ["install", "othertool@1.0.0"], {
          env: { PATH: `${binDir}:/usr/bin:/bin` },
        });
        for (const alias of ["latest", "2", "2.1"]) {
          expect(aliasTarget(alias)).toBe(good);
        }
      }),
  );
});
