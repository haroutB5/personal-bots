// The app sheet live line (line 3) with the old line moved to the history file, and the release notice.
import fs from "node:fs";
import { runTool } from "./guards.mjs";
import { errMsg } from "./util.mjs";

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function updateAppSheet(a, summaryLine, note) {
  const sheet = a["app-sheet"];
  const hist = a["app-history"];
  const doc = fs.readFileSync(sheet, "utf8");
  if (new RegExp(`\\*\\*v${esc(a.version)}\\*\\* live since`).test(doc)) {
    note("App sheet already shows this version; not touched.");
    return;
  }
  const nl = doc.includes("\r\n") ? "\r\n" : "\n";
  const lines = doc.split(/\r?\n/);
  const old = lines[2] ?? "";
  if (!/\*\*v\d+\.\d+\.\d+\*\* live since/.test(old)) throw new Error("App sheet line 3 is not the live line; live checks passed but the update needs review.");
  const prefix = old.slice(0, old.indexOf("**v"));
  const tailAt = old.indexOf(" Release logs and old live lines:");
  const tail = tailAt >= 0 ? old.slice(tailAt) : " Release logs and old live lines: `apps/personal-bots-history.md`.";
  const history = fs.readFileSync(hist, "utf8");
  if (!history.includes(old)) {
    const hnl = history.includes("\r\n") ? "\r\n" : "\n";
    const hl = history.split(/\r?\n/);
    const at = hl.indexOf("## 1. Old live line (was line 3)");
    if (at < 0) throw new Error('History file has no "## 1. Old live line (was line 3)" heading; live checks passed but the update needs review.');
    hl.splice(at + 2, 0, old, "");
    fs.writeFileSync(hist, hl.join(hnl));
  }
  lines[2] = prefix + summaryLine + tail;
  fs.writeFileSync(sheet, lines.join(nl));
  if (!new RegExp(`\\*\\*v${esc(a.version)}\\*\\* live since`).test(fs.readFileSync(sheet, "utf8").split(/\r?\n/)[2] ?? "")) throw new Error("App sheet line 3 did not take the new live line.");
}

export function londonStamp(iso) {
  const date = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZoneName: "short" }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")} ${get("timeZoneName")}`;
}

export function liveLine(a, result) {
  const what = a.summary || `see docs/releases/HANDOFF-${a.version.replace(/\./g, "")}.md`;
  const backupText = result.backupSkipped
    ? `backup skipped (no migration), source level ${a["migration-before"]}, the live database is never opened by the runner`
    : `backup ${result.backupPath}, migration ${a["migration-before"]} -> ${a["migration-after"]}, integrity ${result.backupVerified ? "ok" : "pending"}`;
  const exits = result.backupSkipped ? `restart/smoke ${result.restartExit}/${result.smokeExit}` : `backup/restart/smoke ${result.backupExit}/${result.restartExit}/${result.smokeExit}`;
  return `**v${a.version}** live since ${londonStamp(result.activatedAt)} (release ${a.release}; ${what}; gate evidence PASS (e2e run once by the builder, artifact sealed); externals copied; concurrency 5; pushed docs ${a["main-sha"]}; runner hbots-release.mjs (linux); ${backupText}; ${exits}; version/current/server agree; unauthenticated push/sent 401; startup ERROR=0; rollback ${a.rollback} retained, binary only).`;
}

export async function sendReleaseNotice(cfg, a, result, logPath, note, save) {
  const outcome = { live_verified: "live", live_verified_doc_update_failed: "live", rolled_back: "rolled_back", rollback_failed: "rollback_failed" }[result.status] ?? "failed";
  try {
    const args = ["--thread-id", a["notify-thread"], "--version", a.version, "--release", a.release, "--outcome", outcome, "--log-path", logPath, "--smoke-exit", String(result.smokeExit ?? -1), "--base-dir", cfg.baseDir];
    if (outcome === "rolled_back" || outcome === "rollback_failed") {
      args.push("--rollback-release", a.rollback);
      if (result.rollbackExit != null) args.push("--rollback-exit", String(result.rollbackExit));
      if (result.rollbackSmokeExit != null) args.push("--rollback-smoke-exit", String(result.rollbackSmokeExit));
    }
    if (result.error) args.push("--detail", String(result.error).replace(/["`]/g, "'").slice(0, 600));
    const r = await runTool(cfg, "notify-release.mjs", args);
    result.notifyExit = r.code;
    result.notifyOutcome = outcome;
    note(`notify-release exit=${r.code} ${(r.out || r.err).slice(0, 200)}`);
    save();
  } catch (error) {
    note(`Release notice FAILED: ${errMsg(error)}`);
    result.notifyExit = 1;
    result.notifyError = errMsg(error);
    save();
  }
}
