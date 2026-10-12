// Idle classifier for the release waiter, 1.66.33.
//
// Same interface and verdicts as idle-classification-16617.mjs ("idle" or a
// "busy ..." line on stdout; the runner requires exactly 'idle'), plus the
// projection_turns table: a pending turn-start row (turn_id NULL, state
// 'pending', checkpoint_turn_count NULL) used to be invisible here. A fresh
// one means a turn start is in flight and a restart would strand it, so it
// holds the gate; a row older than the horizon is the stale residue the steer
// bug left behind (10 Oct) and is reported, never blocking - a stuck row must
// not hang a release forever.
//
// Install (DevOps, at ship time, before arming the waiter):
//   copy this file over %USERPROFILE%\.personal-bots\run\idle-classification-16617.mjs
//   update $PinIdleClassifierSha in run\hbots-release.ps1 to its sha256
//   rerun run\hbots-release\tests\hbots-release.tests.ps1
// The runner compares the file against the pin before every run ("Reviewed
// idle classifier changed"), so both must change together.
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
export const horizonMs = 10 * 60 * 1000;
const terminal = new Set(["completed", "failed", "interrupted", "cancelled"]);
const inactive = new Set(["stopped", "error"]);
function distant(value, now) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value &&
    Date.parse(value) > now + horizonMs
  );
}
function stale(value, now) {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    Date.parse(value) < now - horizonMs
  );
}
export function classify(db, now = Date.now()) {
  if (!Number.isFinite(now)) throw new Error("Invalid clock");
  db.exec("BEGIN");
  try {
    const sessions = db
      .prepare(
        "select count(*) n from projection_thread_sessions s join projection_threads t using(thread_id) where t.deleted_at is null and (s.status in ('running','starting') or s.active_turn_id is not null)",
      )
      .get().n;
    // An unended attempt blocks even if its lease expired or its task says parked.
    const attempts = db
      .prepare("select count(*) n from personal_task_attempts where ended_at is null")
      .get().n;
    const rows = db
      .prepare(`select p.task_id,p.status,p.available_at,p.error_category,p.thread_id,
      s.status session_status,s.active_turn_id,r.status runtime_status,t.deleted_at,t.thread_id live_thread
      from personal_tasks p left join projection_thread_sessions s on s.thread_id=p.thread_id
      left join provider_session_runtime r on r.thread_id=p.thread_id
      left join projection_threads t on t.thread_id=p.thread_id`)
      .all();
    let blocking = 0,
      parked = 0;
    for (const row of rows) {
      if (terminal.has(row.status)) continue;
      const safe =
        row.status === "rate_limited" &&
        row.error_category === "rate_limited" &&
        distant(row.available_at, now) &&
        row.live_thread &&
        row.deleted_at === null &&
        inactive.has(row.session_status) &&
        row.active_turn_id === null &&
        inactive.has(row.runtime_status);
      if (safe) parked++;
      else blocking++;
    }
    // Scheduled chat recovery also must not become due during the landing window.
    const resumes = db
      .prepare("select resume_at from personal_chat_resumes where status='scheduled'")
      .all()
      .filter((row) => !distant(row.resume_at, now)).length;
    // Pending turn starts (see the header). A row whose timestamp cannot be
    // read counts as fresh: the conservative answer for a restart gate.
    const pendingRows = db
      .prepare(`select p.requested_at as requested_at
      from projection_turns p join projection_threads t using(thread_id)
      where t.deleted_at is null and p.turn_id is null and p.state = 'pending'
        and p.checkpoint_turn_count is null`)
      .all();
    let pendingFresh = 0,
      pendingStale = 0;
    for (const row of pendingRows) {
      if (stale(row.requested_at, now)) pendingStale++;
      else pendingFresh++;
    }
    return {
      idle:
        sessions === 0 && attempts === 0 && blocking === 0 && resumes === 0 && pendingFresh === 0,
      sessions,
      attempts,
      blocking,
      parked,
      resumes,
      pending: pendingRows.length,
      pendingFresh,
      pendingStale,
    };
  } finally {
    db.exec("ROLLBACK");
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = new DatabaseSync("C:/Users/Ht/.personal-bots/dev/userdata/state.sqlite", {
    readOnly: true,
  });
  try {
    const r = classify(db);
    console.log(
      process.argv.includes("--audit")
        ? JSON.stringify(r)
        : r.idle
          ? "idle"
          : `busy sessions=${r.sessions} attempts=${r.attempts} tasks=${r.blocking} parked=${r.parked} resumes=${r.resumes} pending=${r.pendingFresh} stalePending=${r.pendingStale}`,
    );
  } finally {
    db.close();
  }
}
