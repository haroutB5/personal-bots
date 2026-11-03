# 1.66.113: Self-update server for hbots Mobile

Based on 1.66.112 (`5976c25dadcc`). Branch `release/hbots-166113`, built from `feat/hbots-selfupdate-server` at `9449d9c9bb`, which merges `personal-bots/main` at `e42d90ecb6`. No migration; schema remains 114. Server and contracts only; `PERSONAL_TASKS_CONCURRENCY` stays 5.

## Why

The Android phone needs a server it can ask for its own updates. This release adds the read side: a published release manifest and a download route for the APK. The phone app that consumes it ships later. Until a manifest is published, compatibility reports `latest: null` and nothing changes for any client.

## What changed

- **`android.latest` in `GET /api/personal/client-compat`.** Anonymous, as before. It holds `version`, `sha256`, `size` and `notes` from `<baseDir>/android-updates/latest.json`, or `null` when no valid manifest is published. Extra manifest keys are dropped. A missing, broken or non-regular manifest gives `null` and never fails the handshake.
- **`GET /api/personal/android/apk/<version>`.** A Bearer read token is required. It serves one regular file at `<baseDir>/android-updates/hbots-<version>.apk`, and only when that file is the published regular file and its size matches the manifest. Symlinks, links to links, directories, FIFOs, devices and size mismatches get 404. A malformed version gets 400. Refusals log one warning each and never leak file bytes.
- **Streaming.** The APK is streamed with a fixed length. Peak memory stayed within one APK under a paused client plus five parallel downloads.
- **No database work.** No migration, no backup.

## Rollback

Binary only. The previous release is `5976c25dadcc` (1.66.112). No migration ran.

## Known and accepted

- A hard link to a file of the manifest size is served. The lead accepted this. A same-uid local writer could plant it, and such a writer can already read the file.
- The `latest.json` swap window was not raced. The lead accepted it. The APK swap race was tested, 1,322,043 swaps, and served 0 sentinel bytes.
- A bad or dangling `latest.json` gives no server signal beyond the refusal warnings, so the publish runbook keeps its readback step.
- The notes field is passed through verbatim. The phone must render it as plain text, strip bidi and control characters, and clamp the line count.
- `Range` is ignored. An authed `HEAD` returns 200 with the full length and no body.
- `Authorization: bearer` in lowercase is refused. The phone sends `Bearer`.
- Publishing `latest.json` and the APK is a later step. This release only reads them.

## Verification

- Gate evidence for this exact commit is recorded below.
- Independent re-verify at `9449d9c9bb`, round 2 PASS, all four criteria: `/home/harout/Claude/AI/dev-team/qa/hbots-selfupdate-server-verify/RESULT.md`.
- Round 1 failed criterion 2 only, symlinks were followed. The fix is in `9449d9c9bb`. Round 2 shows every link, folder, loop, FIFO, device and size case refused with 404.

## Gate evidence

<!-- gate-evidence:begin sha=1906a0d1afb6889861ae7c98fbe41eacec312a1c release=1906a0d1afb6 json-sha256=73a4fd052cdfa0c603dd4dbd729917a038c05e56a6f8d066d17e0b8d66e4dbd0 result=PASS -->

- server-tsc: PASS, exit 0
- web-tests: PASS, exit 0
- web-tsc: PASS, exit 0
- e2e: PASS, exit 0
- server-tests: PASS, exit 0

<!-- gate-evidence:end -->
