# HANDOFF — ms-browser-restore: restore personal browser page + agent lease after restart

## Status: IMPLEMENTED, focused gates green — NOT committed, NOT pushed (time budget expired)

Working tree (branch `personal-bots/main`, clean apart from this change) holds the full change,
uncommitted. Do NOT deploy (per brief, orchestrator deploys after review).

## What is done

**Goal:** after a server restart, reopen the bot's last page and re-attach the agent lease so the
phone Computer screen shows "<Bot> is using the browser" with a working Back-to-chat target.
Human leases are cleared at boot (also fixes audit Pass 1 minor #5).

**Files changed (all in `C:/Claude/AI/personal-bots`):**

1. `apps/server/src/persistence/Migrations/062_PersonalBrowserRestoreUrl.ts` (NEW) — `ALTER TABLE
personal_browser_leases ADD COLUMN last_url TEXT`.
2. `apps/server/src/persistence/Migrations.ts` — registered `[62, "PersonalBrowserRestoreUrl"]`.
3. `apps/server/src/personal/browser/PersonalBrowserLeaseRepository.ts` — `BrowserLeaseRow` gains
   `lastUrl: NullOr(String)`; SELECT + INSERT/UPSERT carry `last_url`.
4. `apps/server/src/personal/browser/BrowserLease.ts`
   - `LeaseView` gains `lastUrl`.
   - New pure `decideBrowserRestore(row): RestoreAgent{threadId,url|null} | ClearHuman | Noop`
     (saved URL gated through `resolveBrowserUrl`; invalid URL restores the lease with `url: null`).
   - `make()` normalizes the loaded row and persists when changed: human+owner → released
     (generation+1); agent+owner → heartbeat/expires refreshed from boot (a restart always outlasts
     the 90s TTL, so without this the restored controller would read as lapsed); released → as-is.
     Only `botId`/`botName` are NOT persisted — `status()` already derives them live from the thread
     link, so persisting them would be stale denormalization.
   - New `recordPageUrl(url)` — sticks only while an agent holds the lease; skips repeat writes.
   - New `releaseAgentLease` — drops a live agent lease to released (gen+1); no-op otherwise.
   - `returnToAgent` now preserves `lastUrl` (was implicitly wiped).
5. `apps/server/src/personal/browser/PersonalBrowser.ts`
   - After every successful agent op with a known open http(s) page, records the URL.
   - Boot restore (`forkScoped`, never blocks/throws/retries): agent-owned view + usable URL →
     `createTab` → `navigateTab` (30s budget) → `setActive` → `syncPreviewStatus`, executed
     **inside `lease.runAgentOp`** so a racing op serializes instead of opening a competing tab
     (this race bit during testing — see below). No saved URL → skip launch (lazy; lease stays).
     Any failure → warn-log + `releaseAgentLease` (clean None; browser keeps its
     offline/locked/crashed state). A mid-restore human takeover wins correctly (rejected op →
     release is a no-op under human control).
   - Adjacent one-liner on the touched path: `createTab` now compensates `previewManager.open`
     if `context.newPage()` fails (audit minor #4).
6. Tests — `BrowserLease.test.ts`: human-restart test rewritten (asserts clearing + persisted +
   agents usable afterwards); new agent-refresh-persistence test, `recordPageUrl` guard test, 3
   `decideBrowserRestore` pure tests. `PersonalBrowser.test.ts`: URL-recording wiring test, boot
   restore integration test (stub repo → fake driver launched once, goto normalized URL, Agent
   controller with page), launch-failure test (clean None, boot survives).

**Verified (evidence):**

- `tsc --noEmit -p apps/server` → zero errors in all touched files (repo has pre-existing errors
  elsewhere, e.g. `bin.test.ts`, untouched).
- `vp test run src/personal/browser/BrowserLease.test.ts src/personal/browser/PersonalBrowser.test.ts`
  → 18/18 pass, three consecutive runs.
- `vp test run src/personal` → 15 files, 113/113 pass.
- During testing, the pre-existing "wedged evaluate" test caught a restore-vs-op race (restore opened
  a second tab); fixed by running restore through `runAgentOp`; suite green since.

## What is half-done / NOT done (next steps for whoever picks this up)

1. **Full server suite NOT verified** — `vp test run` (all of `apps/server`) was started and got
   interrupted by the time budget; result unknown. Run it before committing.
2. **Lint on touched files NOT run** — run the repo lint on the 8 touched files before committing.
3. **Commit + push NOT done** — after (1) and (2) are green: commit (conventional title, e.g.
   `feat(bots): restore personal browser page and agent lease after restart`), push to
   `origin personal-bots/main`. Do NOT deploy.
4. No `CLAUDE.md`/`HANDOFF.md` updates made (nothing warranted — behavior is code-local; audit doc
   `.plans/audit-pass1.md` intentionally left untouched as a historical record).

## Open issues / assumptions worth knowing

- Any persisted agent lease is restored regardless of age (`heartbeatAt` recency is not a cutoff —
  documented assumption; a restart always exceeds the TTL anyway).
- Restore reuses/creates exactly one tab via the normal `createTab` path, so PreviewManager rows
  stay consistent; no retry loop, so no leak amplification.
- Effect v4 notes for future edits here: `Effect.catch` (not `catchAll`), `yield* Effect.yieldNow`
  (value, not call), avoid bare `Effect.Effect<T>` annotations (unknown-channel diagnostic).
