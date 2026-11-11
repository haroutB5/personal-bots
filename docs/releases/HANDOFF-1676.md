# 1.67.6: OpenCode restarts, one browser host, steer follow-ups, phone keyboard, FCM push server side

Based on 1.67.5 (`96538634780c`). Branch `integ/1.67.6`. One migration: 143 `PersonalFcmTokens`, schema 142 to 143. `PERSONAL_TASKS_CONCURRENCY` stays 5.

## Why

Follow-ups from 1.67.5 (the steer refusal, empty rows in the live work list), a lost OpenCode server that dropped the running turn, a shared browser host that registered twice, a phone Computer screen whose keyboard and address bar misbehaved, and the server half of phone push notifications.

## What changed

- **Steer and live work list.** A steer to a run that cannot take it yet is queued, not refused (closes M1 from 1.67.5). An undelivered steer is dropped when its task is cancelled. Empty tool calls and checkpoints no longer show in the live work list, and blank commands count as empty in deferred work. The history row keeps its narrow type.
- **Shared browser host.** The personal browser is the only preview automation host, so it no longer registers twice. A request for an unsupported browser operation now says the refusal is permanent, not a reconnect.
- **OpenCode server loss.** When only the event stream is lost the server is kept. A turn lost to a replaced OpenCode server is continued, the task attempt is held for that continuation, the restart gate reads the interrupt result of a lost run, and cancel stops the continuation. The user sees a friendly restart note instead of the provider-server-lost reason.
- **Phone Computer screen.** The live keyboard opens from the field's real focus, reopens after Back hides it, and the address bar keeps typed text.
- **FCM push, server side.** Data-only FCM pushes go to registered phones. The server serves notification content, reply and safe answer, removes phone tokens when the CLI revokes a session, and refuses an unknown or blind phone answer without burning the command id. The Firebase service account key is server-only: bots cannot read it through `secret_request`, the session environment or any other secret path. No Firebase key is saved yet, so FCM stays off on the live server. The APK is built without `HBOTS_GOOGLE_SERVICES_JSON`.

## Migration 143 `PersonalFcmTokens`

Adds two tables and two indexes. Nothing existing is altered.

- `personal_fcm_tokens` (token, auth_session_id, subject, app_version, created_at, last_seen_at, last_error), index `idx_personal_fcm_tokens_session` on `auth_session_id`. A phone token belongs to the session that registered it and to that session's subject.
- `personal_phone_notifications` (notification_id, subject, kind, bot_id, thread_id, request_id, body, created_at), primary key (notification_id, subject), index `idx_personal_phone_notifications_created` on `created_at`. A notification row is readable only by the subject it was sent to.

Both statements use `IF NOT EXISTS`. The release is a migration change, so the runner takes the full production backup first.

## Verification

- Verifier PASS, steer and live list follow-ups: `/home/harout/Claude/AI/dev-team/qa/hbots-1676-followups/VERIFY.md`.
- Verifier PASS, browser host: `/home/harout/Claude/AI/dev-team/qa/hbots-browser-host/VERIFY.md`. The permanent-refusal wording (`dbb5e68652`) was added by the lead after that pass, with one test.
- Verifier PASS, OpenCode restarts: `/home/harout/Claude/AI/dev-team/qa/opencode-restarts/VERIFY-3.md`.
- Verifier PASS, FCM push server side, round 3 at `340c299bc5`: `/home/harout/Claude/AI/dev-team/qa/hbots-r2-push/VERIFY-2.md`.
- Verifier emulator PASS, phone keyboard, Round 2: `/home/harout/Claude/AI/dev-team/qa/hbots-browser-keys/VERIFY.md`.
- The diff touches `apps/server`, `packages/` and `apps/hbots-mobile`, so the gate scope is a full run at the evidence commit. The table is below.

## Rollback

Binary only. The previous release is `96538634780c` (1.67.5). Migration 143 only adds tables, so the 1.67.5 binary runs on the 143 schema without change.

## Known and accepted

- FCM push is off until Harout saves a Firebase service account key and a `google-services.json` build is made. No phone push arrives from this release.
- The APK is built from the release commit and published through `latest.json` after the runner reports `live_verified`.
- Harout owns the real-phone check for the arm64 APK.
- The pre-release checks are the test. No QA recheck after live (Harout, 27 Oct).
