// @effect-diagnostics nodeBuiltinImport:off - runs once at test setup, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

// Agent shells carry real provider credentials (CLIProxy sets ANTHROPIC_AUTH_TOKEN and
// ANTHROPIC_BASE_URL) and the agent's own T3 state. Tests that read the ambient environment
// then pass or fail by who runs them. Tests that need one of these variables set it
// themselves. Set T3CODE_TEST_KEEP_PROVIDER_ENV=1 to keep them, for example for a live run.
const PROVIDER_ENV_PREFIXES = [
  "ANTHROPIC_",
  "CLAUDE_",
  "CODEX_",
  "OPENAI_",
  "OPENCODE_",
  "T3CODE_",
];

const KEPT_ENV = new Set([
  // CI sets these so the transfer budget integration test writes its report for the job summary.
  "T3CODE_TRANSFER_BUDGET_REPORT_PATH",
  "T3CODE_TRANSFER_BUDGET_RESULT_PATH",
  // Opt-in: points the HtmlRender tests at a headless browser, which they skip without.
  "T3CODE_TEST_HEADLESS_SHELL",
]);

if (process.env.T3CODE_TEST_KEEP_PROVIDER_ENV !== "1") {
  for (const key of Object.keys(process.env)) {
    if (KEPT_ENV.has(key)) continue;
    if (PROVIDER_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      delete process.env[key];
    }
  }
}

// OpenCode, Muse and the editor probes read auth and databases under XDG_DATA_HOME, so an
// ambient value points the suite at the developer's own accounts. Each worker gets an empty
// data home instead. Tests that need a layout write their own and pass it explicitly.
if (process.env.T3CODE_TEST_KEEP_PROVIDER_ENV !== "1") {
  const dataHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-test-xdg-data-"));
  process.env.XDG_DATA_HOME = dataHome;
  process.once("exit", () => {
    NodeFS.rmSync(dataHome, { recursive: true, force: true });
  });
}
