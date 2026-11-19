# verify-hbots-android, round 2

Branch `feat/verify-hbots-android`. Code head `db7011bd63`. Builder 2, 19 Nov 2026. Skill folder: `apps/hbots-mobile/.claude/skills/verify-hbots-android/`. No app code touched. The APK under test was built from this checkout (version 1.67.37, x86_64, throwaway key, sha256 prefix 4158c6fcd4db3751) with the skill's own `build-apk.sh`.

Labels: measured = seen in a run or command here. Inferred = read from code or logs, not seen directly. Guess = no evidence.

## What changed

| Defect                  | Fix                                                                                                                                                                                                                                                                                                                                                                                    | Where                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| N1 link loss is exit 1  | `drive.py` checks the link before each flow and after each failing flow: tunnel unit gone, public URL not answering twice, or the Offline banner on screen while cloudflared logged aborted requests. It records `LINK-LOST` for that flow, does not judge the rest, writes `setup-reason.txt` and exits 2. `verify.sh` turns that into `RESULT SETUP-FAIL (link lost at flow N ...)`. | `drive.py` `link_problem`, `link_lost`; `verify.sh`          |
| N1 default device       | Laptop is the default. `HBOTS_VERIFY_DEVICE=rig` opts in. A rig that is not free is exit 2 with the rig's answer, no silent fall back. Any other value is exit 2.                                                                                                                                                                                                                      | `device.sh`, `verify.sh`, `doctor.sh`                        |
| Rig takes a slot        | The rig route does not call `heavy-job.sh`. The post-run check looks at every heavy lock and prints `none taken (rig route needs no slot)`.                                                                                                                                                                                                                                            | `verify.sh`                                                  |
| N2 dirty screen         | `reset()` before every flow: closes a message menu or plus sheet, cancels the reply bar, removes tray photos, clears draft text, shows Chats. Chat flows open their own chat, so `--only 2` works alone.                                                                                                                                                                               | `drive.py`                                                   |
| N4 no RESULT on refusal | An EXIT trap in `verify.sh` prints a RESULT line for every exit that has none: usage, `env.sh` refusals, bad device value. `env.sh` has a `refuse()` that records the reason.                                                                                                                                                                                                          | `verify.sh`, `env.sh`                                        |
| New laptop              | `android.conf` is gone, so `env.sh` and `build-apk.sh` default `ANDROID_HOME` to `~/Android/Sdk` (Gradle failed with "SDK location not found" without it). `avd.sh ensure` creates `FindX9Pro-QA` (API 36 google_apis x86_64, 1080x2355 at 480 dpi, 2 GB) when it is missing. `device.sh up` calls it, `doctor.sh` reports it.                                                         | `env.sh`, `build-apk.sh`, `avd.sh`, `device.sh`, `doctor.sh` |
| N3 probe                | `VERIFY_PROBE=offline-draft` runs a probe instead of the flows (see N3 below).                                                                                                                                                                                                                                                                                                         | `drive.py --probe`                                           |

Four driver hardening changes came out of the runs below, each from a failure seen here:

- `reset()` first counted the empty composer's hint ("Message Developer…") as draft text and looped ten times per flow. Measured: flows took 455 s in run1, about 320 s after the fix.
- `say()` taps Send once more when the text is still in the composer after 3 s (flow 7 failed once with the text typed and not sent). It logs `send tap did not fire`.
- `open_bot()` handles the "New chat with <bot>" sheet, clears a stray character in its name field, retries once and saves a dump (`open-<bot>-<n>-dump.xml`). The stray character was an "M", seen twice (clean3, last1). Cause not found (guess: the keyboard or the autofocus field on first open). It is harmless and cleared.
- `ensure_app()` relaunches the app when the launcher is in front. In the first planted-break run the app left the foreground after flow 1 and the driver's taps opened Google Search (`plant-spoiled-launcher.txt`). Flow 8 counts only crashes of the app: `FATAL EXCEPTION: UiAutomation` (the dump tool died, run2) is not the app.

## Runs

All on the laptop, default device, 360x785 dp at DPR 3, dark, headless. Evidence: `evidence/runs/*.txt` (full output with the RESULT line), copied from the worktree's `.scratch/`.

| Run                    | Code                   | What it was                                                          | Exit    | Notes                                                                                                              |
| ---------------------- | ---------------------- | -------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| run1                   | first fix, uncommitted | clean                                                                | 0       | 9 PASS, 638 s, flows 455 s (hint bug)                                                                              |
| run2                   | c79f0f0884             | clean                                                                | 1       | flow 7 Send did not fire, flow 8 counted a UiAutomation crash. Both driver faults, fixed                           |
| clean1, clean2         | f91e7a04af             | clean                                                                | 0, 0    | 9 PASS each                                                                                                        |
| clean3                 | f91e7a04af             | clean                                                                | 1       | flows 1 and 7: New chat sheet with a stray "M". Fixed in `open_bot`                                                |
| final1, final2, final3 | f91e7a04af             | clean, 3 in a row                                                    | 0, 0, 0 | 9 PASS each                                                                                                        |
| drop                   | f91e7a04af             | link drop after flow 9 (this run's tunnel unit stopped by a watcher) | 2       | `RESULT SETUP-FAIL (link lost at flow 3 ... the tunnel unit ... is not running ...)`, flows 3,2,5,4,6,8 not judged |
| plant                  | f91e7a04af             | plant in flow 9                                                      | 1       | spoiled: app left the foreground, launcher taps. Led to `ensure_app()`                                             |
| plant2                 | db7011bd63 plus plant  | flow 9 expects the name "PlantedBreak"                               | 1       | flow 9 FAIL only, `reset: closed reply bar`, flows 3 and 2 PASS, 8 PASS 1 FAIL                                     |
| n3probe                | db7011bd63             | N3 probe                                                             | 0       | see below                                                                                                          |
| last1, last2, last3    | db7011bd63             | clean, 3 in a row, final code                                        | 0, 0, 0 | 9 PASS each, 492 s, 504 s, 430 s of work. last1 needed the `open_bot` retry once (logged)                          |
| rigoptin               | db7011bd63             | `HBOTS_VERIFY_DEVICE=rig`, PC unreachable                            | 2       | `RESULT SETUP-FAIL (device: ... rig refused (exit 2): PC unreachable)`, no heavy slot taken, 32 s                  |

The planted break is in the driver, not the app: the expected name in flow 9's Reply check is changed on a copy of `drive.py`, so flow 9 fails with the reply bar open, which is the dirty state N2 describes. I did not plant a break in the app (that needs a second APK build). The plant was reverted before the commit (`grep PlantedBreak` finds nothing).

Refusals (all exit 2, all end with a RESULT line, evidence in the shell output of this task and `runs/rigoptin.txt`):

- no arguments: `RESULT SETUP-FAIL (usage: verify.sh <x86_64.apk> [label] [--only 1,2]) in 0s total`
- `VERIFY_SERVER_PORT=38472`: `RESULT SETUP-FAIL (38472 is the live server port) in 0s total`
- `HBOTS_VERIFY_EVIDENCE=/home/harout/.personal-bots/dev/x`: `RESULT SETUP-FAIL (... is inside ~/.personal-bots/dev, the live hbots) in 0s total`
- `HBOTS_VERIFY_DEVICE=auto`: `RESULT SETUP-FAIL (HBOTS_VERIFY_DEVICE must be laptop (default) or rig, got 'auto') in 0s total`

## N3: does the app drop draft text while offline

Answer (measured, one probe run twice): no. Text and photos are kept in every case I could provoke. Evidence: `evidence/n3/probe-offline-draft.txt` and four screenshots, run `n3probe-20261119T110907Z`.

| Case                                      | What the user sees                                                                                                                                                                                                                | What reached the bot                                               |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| C online, text "BASE3" plus 3 photos      | bubble with the text and 3 images                                                                                                                                                                                                 | text and 3 photos, 2.0 s after Send (3.5 s in the first probe run) |
| B phone offline (airplane mode), tap Send | composer still holds "AIRPL3" and the 3 photos, "Offline. Your draft is saved and sends when the laptop is back." Nothing is sent. 120 s after the network returned the draft was still in the composer and nothing had been sent | nothing                                                            |
| A tunnel stopped right after Send         | bubble "Not sent", "Try again", composer error "An attachment didn't upload. Try again.". The bubble holds the text "TUNNEL3" (found after scrolling up) and the 3 photos                                                         | nothing: the message is held whole, text and photos together       |

So a text-plus-photos send that loses the link is never half sent: the text waits behind the photo upload and the whole message shows "Not sent". That fits the rig symptom (typed "PHOTOS3" text never reached the bot along with the photos), because `say()` in flow 2 waits 9 s for the text to reach the bot. On the rig two things could cause that: the three uploads were slower than 9 s through the tunnel (inferred), or the link dropped and the message sat as "Not sent" (inferred). I cannot tell which without a rig run, and the rig was unreachable. This is not a text drop by the app.

Two things for Poteto, neither fixed here (no app changes):

1. Case B is odd. The Send tap with 3 photos and no network leaves the draft in the composer and sends nothing, even after the network returns, while the notice says the draft "sends when the laptop is back". From `Composer.tsx` (lines 915 to 930) the likely path is `queueForLater` returning false for a draft with attachments, then `restoreIntoComposer` with no notice (inferred from code, not confirmed with a log). I did not check whether the tap registered beyond the unchanged screenshot. If an offline queue for photos is intended, this is a gap. If not, the notice text is misleading when photos are attached. I would call it low severity.
2. The "M" in the New chat sheet's name field (above) may be an app or keyboard effect. Unverified.

## Rig

`rig.sh free` returned 2 ("PC unreachable") three times in a row at the end of the task, and at the start. No rig run was made. The rig opt-in path was exercised up to the refusal (`rigoptin`): exit 2, a RESULT line, no heavy slot. A full rig run is not verified.

## Not verified

- A rig run end to end, and the claim "no heavy slot on a completed rig run" (the refusal path was measured, a full run was not).
- The in-flow link-loss branch (Offline banner plus cloudflared log lines). The drop run exercised the tunnel-unit branch. The public-URL branch is untested. The banner texts come from `offlineBannerText` in the app source (inferred).
- A planted break in the app itself (the plant was in the driver).
- The cloudflared log patterns in `TUNNEL_LOG_BAD` are a guess from what cloudflared printed in the runs (`Incoming request ended abruptly`, `Request failed`). They only count when the Offline banner shows too.
- Another bot's emulator (`FindX9Pro-QA`, port 5682, started 09:36) and tunnel ran at the same time as my runs and used the same AVD read only. I did not touch them.

## Cleanup proof

After the last run (all four checks run at the end of the task, outputs in the task reply):

- `systemctl --user list-units 'pstack-b2*' 'pstack-hbots-verify*'`: none.
- listeners on 34671, 5171, 5672, 5673: 0.
- processes on my ports or in my worktree (qemu, adb, cloudflared, srv.mjs): none.
- `lslocks`: four heavy locks are held, by other bots (pids 1478225, 1478226, 1434847, 1557888). None of them has my worktree as its cwd and none carries my run id. My runs each printed `released, none of this run's processes holds it`.
