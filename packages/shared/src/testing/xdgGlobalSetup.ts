// Vitest global setup: one run-scoped root holds every per-file XDG data home,
// so a worker killed at teardown cannot leave a directory behind.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

let root: string | null = null;

export async function setup() {
  if (process.env.T3CODE_TEST_KEEP_PROVIDER_ENV === "1") return;
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-test-xdg-run-"));
  process.env.T3CODE_TEST_XDG_ROOT = root;
  process.env.XDG_DATA_HOME = root;
}

export async function teardown() {
  if (root) NodeFS.rmSync(root, { recursive: true, force: true });
  root = null;
}
