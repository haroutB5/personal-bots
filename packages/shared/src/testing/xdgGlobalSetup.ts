// One run-scoped root holds every per-file XDG data home, so a worker killed at
// teardown cannot leave a directory behind. The pool exists before this runs, so
// the root reaches workers through provided context, not an env var.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const XDG_ROOT_PROVIDE_KEY = "T3CODE_TEST_XDG_ROOT";

// Structural type: this file is loaded by the runner, not by the test files.
type GlobalSetupProject = {
  provide: (key: string, value: string) => void;
};

let root: string | null = null;

export async function setup(project: GlobalSetupProject) {
  if (process.env.T3CODE_TEST_KEEP_PROVIDER_ENV === "1") return;
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-test-xdg-run-"));
  project.provide(XDG_ROOT_PROVIDE_KEY, root);
}

export async function teardown() {
  if (root) NodeFS.rmSync(root, { recursive: true, force: true });
  root = null;
}
