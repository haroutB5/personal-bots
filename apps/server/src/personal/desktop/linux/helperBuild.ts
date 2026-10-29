// @effect-diagnostics nodeBuiltinImport:off - compiles a small C helper with the system toolchain, exactly as the Windows driver compiles its C# helper.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { DesktopHelperError } from "../DesktopHelper.ts";
import {
  PB_DESK_LINUX_HELPER_SOURCE,
  VIRTUAL_KEYBOARD_XML,
  WLR_VIRTUAL_POINTER_XML,
} from "./helperSource.ts";

const SCANNER_JOBS = [
  ["client-header", "wlr-virtual-pointer-unstable-v1.xml", "wlr-virtual-pointer-unstable-v1.h"],
  ["private-code", "wlr-virtual-pointer-unstable-v1.xml", "wlr-virtual-pointer-unstable-v1.c"],
  ["client-header", "virtual-keyboard-unstable-v1.xml", "virtual-keyboard-unstable-v1.h"],
  ["private-code", "virtual-keyboard-unstable-v1.xml", "virtual-keyboard-unstable-v1.c"],
] as const;

function compileFailure(stage: string, detail: string): DesktopHelperError {
  return new DesktopHelperError(
    "unavailable",
    `The Linux desktop helper could not be ${stage}: ${detail.slice(0, 600)}`,
  );
}

/**
 * Builds the helper once per source version into `dir` and returns the binary.
 * Needs gcc, wayland-scanner and the libxkbcommon headers, all of which are
 * installed on Omarchy; no root and no network.
 */
export function ensureLinuxHelperBuilt(dir: string): string {
  const hash = NodeCrypto.createHash("sha256")
    .update(PB_DESK_LINUX_HELPER_SOURCE)
    .update(WLR_VIRTUAL_POINTER_XML)
    .update(VIRTUAL_KEYBOARD_XML)
    .digest("hex")
    .slice(0, 16);
  NodeFS.mkdirSync(dir, { recursive: true });
  const binary = NodePath.join(dir, `pbdesk-wl-${hash}`);
  if (NodeFS.existsSync(binary)) return binary;

  NodeFS.writeFileSync(NodePath.join(dir, "pbdesk-wl.c"), PB_DESK_LINUX_HELPER_SOURCE, "utf8");
  NodeFS.writeFileSync(
    NodePath.join(dir, "wlr-virtual-pointer-unstable-v1.xml"),
    WLR_VIRTUAL_POINTER_XML,
    "utf8",
  );
  NodeFS.writeFileSync(
    NodePath.join(dir, "virtual-keyboard-unstable-v1.xml"),
    VIRTUAL_KEYBOARD_XML,
    "utf8",
  );

  for (const [mode, input, output] of SCANNER_JOBS) {
    const scan = NodeChildProcess.spawnSync("wayland-scanner", [mode, input, output], {
      cwd: dir,
      encoding: "utf8",
      timeout: 60_000,
    });
    if (scan.status !== 0) {
      throw compileFailure(
        "built",
        `wayland-scanner ${mode} failed: ${(scan.stderr || scan.stdout || String(scan.error)).trim()}`,
      );
    }
  }

  const flags = NodeChildProcess.spawnSync(
    "pkg-config",
    ["--cflags", "--libs", "wayland-client", "xkbcommon"],
    { cwd: dir, encoding: "utf8", timeout: 30_000 },
  );
  if (flags.status !== 0) {
    throw compileFailure(
      "built",
      "pkg-config could not find wayland-client and xkbcommon. Install their development headers.",
    );
  }
  const extra = flags.stdout.trim().split(/\s+/).filter((part) => part.length > 0);
  const tempBinary = `${binary}.${process.pid}.tmp`;
  const build = NodeChildProcess.spawnSync(
    "gcc",
    [
      "-O2",
      "-Wall",
      "-Wextra",
      "-o",
      tempBinary,
      "pbdesk-wl.c",
      "wlr-virtual-pointer-unstable-v1.c",
      "virtual-keyboard-unstable-v1.c",
      ...extra,
    ],
    { cwd: dir, encoding: "utf8", timeout: 120_000 },
  );
  if (build.status !== 0 || !NodeFS.existsSync(tempBinary)) {
    throw compileFailure(
      "built",
      `${(build.stderr || build.stdout || String(build.error)).trim()}`,
    );
  }
  NodeFS.renameSync(tempBinary, binary);
  return binary;
}
