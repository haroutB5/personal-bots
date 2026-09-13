# Handoff: ms-startup-opt — Bots cold-start (instant Chats paint)

## Plan (written before coding)

1. Read: `ChatsScreen.tsx` ✓, `usePersonalBots.ts` ✓, `botSummaries.ts` ✓, `BotRow.tsx` ✓,
   `clientPersistenceStorage.ts` + test ✓, `useLocalStorage.ts` ✓, `state/query.ts` ✓,
   `appVersion.ts` ✓, `contracts/personalBots.ts` ✓. Still to read: `BotAvatar.tsx`,
   `useRefreshBotsForTaskThreads.ts`, bots route layout (footer flex parent), web `package.json`
   test scripts.
2. New module `apps/web/src/features/personal/chatsSnapshot.ts`:
   - Effect-Schema `ChatsSnapshotRow` { botId, name, avatarShape, avatarColor,
     providerLabel, preview (≤140 chars, first line only), previewAtMs (nullable),
     threadId (nullable), threadTitle (nullable) } + `ChatsSnapshot` { version: 1,
     environmentId, savedAtMs, rows (≤30) }.
   - `readChatsSnapshot(envId)` / `writeChatsSnapshot(snapshot)` /
     `buildChatsSnapshot({ environmentId, rows })` pure builder with caps + byte-cap
     truncation (~64KB). Single localStorage key `t3code:chats-snapshot:v1` storing
     `{ environmentId, snapshot }` → env change = miss + overwrite (satisfies "clear
     when environment changes"). Errors (decode/quota) → catch, drop corrupt entry,
     return null; never throw into render. No secrets, no full message bodies.
   - Uses `getLocalStorageItem` / `setLocalStorageItem` / `removeLocalStorageItem`
     from `~/hooks/useLocalStorage` (same quota/error handling as clientPersistence).
3. `ChatsScreen.tsx`:
   - `const snapshot = useMemo(() => readChatsSnapshot(environmentId), [environmentId])`
     (lazy init via useState to read once per env); render snapshot rows instantly when
     `list.data === null && snapshot !== null` — neutral indicators (no live dots, no
     attention row). Live data replaces snapshot seamlessly (`loaded` wins).
   - Persist: `useEffect(() => { if (list.data) writeChatsSnapshot(...) }, [...])` —
     needs preview strings → export `previewOf` from `BotRow.tsx` (or move helper).
   - Skeletons: no snapshot + no live data → 3 skeleton rows, muted fill
     (`--personal-fill-muted`), `aria-busy="true"` on list region, `role="status"`? —
     decide: `aria-busy` on the `<ul>`-equivalent region + sr-only "Loading your bots".
   - Defer: gate `usePersonalTasks(environmentId)` behind post-paint flag
     (`requestAnimationFrame` in mount effect, or `loaded || snapshotRendered`) so the
     tasks subscription doesn't contend with the first list fetch. Measure first (see below).
   - Footer: root `flex-1`, footer wrapped in `mt-auto` spacer so it pins to bottom.
4. Measure step 3: add temporary `performance.now()` marks (list mount → first data;
   tasks-subscribe start) behind `console.debug`, run web unit/tests + inspect
   `client-runtime/state/runtime` for WS queue ordering, then REMOVE the logs.
5. Tests: `chatsSnapshot.test.ts` (builder caps/truncation, round-trip, corrupt-entry,
   env-mismatch, quota-failure → null, never-throws). Component test for skeleton +
   snapshot rows via react-test-renderer if cheap (presentational extract).
6. Gates: `vp test run --project unit <touched>` incl. personal feature tests,
   `tsc --noEmit` (apps/web), `vp lint` touched files. Never bare `vp test run` in server.
7. Ship: commit + push `personal-bots/main`. No deploy, no version bump, no SendMessage.

## Log

- T+0: plan written. Code inspection done for main files; remaining reads next.
- T+15: `chatsSnapshot.ts` + 10 unit tests green. `BotRow`: exported `previewOf`,
  `ROW_CLASS` (no behavior change).
- T+30: `ChatsScreen`: snapshot paint, skeletons, deferred tasks, pinned footer.
  `ChatsScreen.test.tsx` (3 tests) green — covers skeleton/snapshot/live-swap +
  tasks deferral ordering.
- T+35: temp `[chats-perf]` probe verified ordering, then REMOVED (grep confirms
  zero references). `Schema.Finite` for epoch-ms fields.

## Gate output

- `vp test run --project unit src/features/personal` → 22 files, 129 tests, all pass.
- `tsc --noEmit` (apps/web) → zero `error TS` (only pre-existing style suggestions).
- `vp lint` on all 5 touched files → clean, no output.
- NEVER ran bare `vp test run` in apps/server (untouched).

## Measurement (step 3)

- Static analysis (no dev server per repo policy for subagents, so no live trace):
  cold mount fired 3 concurrent env requests over the one WS — `personalBots.list`
  query, profile query, and the tasks subscription replay (one event per task +
  O(n) map copies per 50ms batch + a re-render per batch) — plus a `list.refresh()`
  loop risk via `useRefreshBotsForTaskThreads` once tasks land.
- Temp probe (added → observed in `ChatsScreen.test` → removed) confirmed the new
  order: mount paints snapshot/skeleton first; `usePersonalTasks` receives `null`
  until 2×rAF post-paint (1500ms `setTimeout` fallback for background tabs), then
  the real env id. Test asserts `tasksCalls === [null]` pre-paint, `[null, env]`
  post-paint.
- Kept immediate: profile query (greeting name, tiny) and the list query itself.
  `useRefreshBotsForTaskThreads` untouched — no-op on empty tasks, resumes after arm.
