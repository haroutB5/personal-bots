// Command line shared by the runner and the launcher.
import { DEFAULT_APP_HISTORY, DEFAULT_APP_SHEET, DEFAULT_REPO } from "./config.mjs";

export const OPTIONS = {
  release: { type: "string" }, rollback: { type: "string" }, "main-sha": { type: "string" }, version: { type: "string" },
  "notify-thread": { type: "string" }, "migration-before": { type: "string" }, "migration-after": { type: "string" },
  summary: { type: "string", default: "" }, "extra-columns": { type: "string", default: "" },
  "sw-revision": { type: "string", default: "2026-09-30-worker-list" },
  "backup-keep": { type: "string", default: "3" }, "force-backup": { type: "boolean" }, "allow-slow-backup": { type: "boolean" },
  "repo-root": { type: "string", default: DEFAULT_REPO },
  "app-sheet": { type: "string", default: DEFAULT_APP_SHEET }, "app-history": { type: "string", default: DEFAULT_APP_HISTORY },
  prepare: { type: "boolean" }, "guards-only": { type: "boolean" }, "dry-run": { type: "boolean" }, "verify-live": { type: "boolean" },
  "stable-seconds": { type: "string" }, "max-wait-hours": { type: "string" },
  "legacy-no-evidence": { type: "boolean" }, "write-pins": { type: "boolean" }, help: { type: "boolean" },
};

export function assertParams(a, mode) {
  const need = (k, re, msg) => {
    if (!re.test(String(a[k] ?? ""))) throw new Error(msg);
  };
  need("release", /^[0-9a-f]{12}$/, "--release must be the 12-character release sha.");
  need("rollback", /^[0-9a-f]{12}$/, "--rollback must be the 12-character sha of the live release.");
  need("main-sha", /^[0-9a-f]{40}$/, "--main-sha must be the full 40-character sha of the pushed notes commit.");
  need("version", /^\d+\.\d+\.\d+$/, "--version must look like 1.66.31.");
  need("notify-thread", /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, "--notify-thread must be the CTO chat thread id.");
  need("migration-before", /^\d+$/, "--migration-before and --migration-after are required (max migration id before and after activation).");
  need("migration-after", /^\d+$/, "--migration-before and --migration-after are required (max migration id before and after activation).");
  if (Number(a["migration-after"]) < Number(a["migration-before"])) throw new Error("--migration-after is lower than --migration-before.");
  if (a.release === a.rollback && mode !== "dryrun" && mode !== "guards") throw new Error("Release and rollback are the same sha.");
  need("backup-keep", /^[1-9]\d*$/, "--backup-keep must be at least 1.");
  if (/["`$]/.test(a.summary) || a.summary.length > 400) throw new Error("--summary: plain text, at most 400 characters, no quotes, backticks or $.");
  if (a["legacy-no-evidence"] && mode === "run") throw new Error("--legacy-no-evidence is for --guards-only and --dry-run only: a real run needs the gate evidence.");
  if (a["verify-live"] && mode !== "dryrun") throw new Error("--verify-live belongs to --dry-run.");
}
