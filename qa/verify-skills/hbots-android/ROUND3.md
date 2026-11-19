# verify-hbots-android, round 3

Branch `feat/verify-hbots-android`. Code head `f1c8e0e36a` (fixes in `24eb9acecf`, a one-line follow-up in `f1c8e0e36a`). Builder 2, 19 Nov 2026. Skill folder: `apps/hbots-mobile/.claude/skills/verify-hbots-android/`. No app code touched. APK under test: version 1.67.37, x86_64, the one built in round 2.

Labels: measured = seen in a run or command here. Inferred = read from code or logs, not seen directly. Guess = no evidence.

## What changed

| Finding                                      | Fix                                                                                                                                                                                                                                                                                                                  | Where                                         |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| F1 flow failure during a link blip is exit 1 | A flow failure is link lost (exit 2, `RESULT SETUP-FAIL`) when the tunnel log shows a serve error or a retry at any level (ERR, WRN, INF) since the flow began, or when the screen shows "Not sent" with the Offline line. The old filter dropped the INF "Retrying connection" line, so the banner check never ran. | `drive.py`                                    |
| F2 draft in another chat survives            | `open_bot` empties the composer when a flow opens its chat (tray photos and draft text) and logs `composer cleared on open: ...`. `say()` requires the prompt the bot received to equal the text the flow sent, exactly. The flow fails with `the bot received 'X', the flow sent 'Y' (not an exact match)`.         | `drive.py`                                    |
| F3 offline Send tapped a cached point        | Offline, the driver taps the live Send node (accessibility description starts with "Send") and logs both points. Banner and composer strings follow `offlineBanner.ts`. A chat screen shows only the composer line, so `OFFLINE_TEXT` also matches "Offline. ..." by its start. Full copy is never matched.          | `drive.py` (`f1c8e0e36a` for the start match) |
| F5 run.log lines doubled, "flows ?s"         | Fixed. A second `run.log` check showed no duplicate lines.                                                                                                                                                                                                                                                           | `verify.sh`, `drive.py`                       |
| F6 wait-for-device had no timeout            | 120 s timeout.                                                                                                                                                                                                                                                                                                       | `device.sh`                                   |
| F4 early doctor outside the slot             | Not done. An early doctor check outside the heavy slot would also refuse queued runs while another laptop run holds the ports.                                                                                                                                                                                       | none                                          |

Unit tests: `scripts/test_drive.py`, 16 tests OK (measured, `python3 -I`, exit 0).

## Acceptance results

All runs on the laptop, default device, final code `f1c8e0e36a`, no env vars except where a plant needs one. Output of each run: `evidence/round3/runs/<name>.txt`, exit code in `<name>.exit`, cleanup check in `<name>-clean.txt`. Full evidence (shots, logs, 277 MB) stays in `/home/harout/Claude/AI/dev-team/qa/verify-skills/hbots-android/round3/ev/`.

### Plants

| #   | Plant                                                                                                      | Run      | Exit | Result                                                                                                                                                                                                                                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------- | -------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | F1: SIGSTOP the run's own cloudflared for 15 s when `f2-picked.png` appears (Verifier 2's plant)           | `blip15` | 2    | `RESULT SETUP-FAIL (link lost at flow 2 (pick-three-photos), not an app verdict, flows not judged, rerun: the public tunnel URL does not answer (http 530) ...)`. Measured.                                                                                                                                                                                   |
| 2   | F1: same with a 12 s pause                                                                                 | `blip12` | 2    | `RESULT SETUP-FAIL (link lost at flow 2 ... cloudflared logged 2 dropped-tunnel line(s) during the flow: '... INF Retrying connection in up to 2s ...')`. This path is the log-line one that the old code dropped. Measured.                                                                                                                                  |
| 3   | F2: flow 2 fails after leaving a draft ("PLANTDRAFT") and 3 photos in the Developer chat, then flow 5 runs | `draft`  | 1    | Flow 2 FAIL as planted. The run log shows `composer cleared on open: draft text`. Flow 5 PASS with an empty composer and prompt `SLOW6` exactly. Measured.                                                                                                                                                                                                    |
| 4   | F2: the typed text gets the prefix "PLANTX"                                                                | `prefix` | 1    | Flow 5 FAIL: `AssertionError: the bot received 'PLANTXSLOW6', the flow sent 'SLOW6' (not an exact match)`. Measured.                                                                                                                                                                                                                                          |
| 5   | F3: offline Send with 3 photos (`VERIFY_PROBE=offline-draft`)                                              | `probe`  | 0    | Online baseline: the bot got `BASE3` with 3 photos after 2.0 s. Offline: `tapping the live Send node 'Send, waits here until your laptop reconnects' at (978, 2139) (cached online point was (978, 2217))`. The bot got nothing while offline. After reconnect the bot got `AIRPL3` with 3 photos after 3.5 s. Screens in `evidence/round3/probe/`. Measured. |

The plant skill copy used for plants 3 and 4 is `r3plant-vha`, a copy of the skill with an env-var switch in `drive.py`. Its diff against the real skill is `evidence/round3/plant-diff.txt`. The copy is not committed.

Not run on the device: the "Not sent plus Offline line" classification. It is covered by a unit test in `test_drive.py` only (inferred from the test, not seen on a device).

### Cold runs (no env vars, nothing planted)

| Run     | Exit | Result                     | Total | Flows |
| ------- | ---- | -------------------------- | ----- | ----- |
| `cold1` | 0    | RESULT PASS, 9 PASS 0 FAIL | 513 s | 333 s |
| `cold2` | 0    | RESULT PASS, 9 PASS 0 FAIL | 384 s | 289 s |
| `cold3` | 0    | RESULT PASS, 9 PASS 0 FAIL | 381 s | 291 s |

Three in a row, all measured. Flow 1 to 9 each PASS in all three (see the `.txt` files).

### Cleanup

Each run ends with `cleancheck.sh`, which counts listeners on 34671, 5171, 5672 and 5673 and lists qemu, adb or cloudflared of this run, `pstack-hbots-verify-*` tunnel units, heavy locks and emulators.

| After                  | Run                                | Exit | Listeners | Tunnel unit | Emulator | Heavy lock                                                                                                                                                   |
| ---------------------- | ---------------------------------- | ---- | --------- | ----------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PASS                   | `cold1`, `cold2`, `cold3`, `probe` | 0    | 0         | none        | none     | none                                                                                                                                                         |
| FAIL (flow failure)    | `draft`, `prefix`                  | 1    | 0         | none        | none     | one lock held by pid 1856916, cwd `/home/harout/Claude/AI/_wt/hbots-rc16739`. That is the hbots release job, not this run (measured, cwd read from `/proc`). |
| SETUP-FAIL (link lost) | `blip15`, `blip12`                 | 2    | 0         | none        | none     | none in `blip15`. `blip12` shows the same release job's lock as `draft`.                                                                                     |

Measured.

## Superseded runs

Runs at `24eb9acecf`, before the `f1c8e0e36a` fix, are not in this record. They showed: a 15 s pause gave SETUP-FAIL by http 530 only (the log-line path was not what caught it), the probe waited 60 s for a banner that never shows in a chat (the cause of the `OFFLINE_TEXT` start match), and the draft plant passed flow 5 with an empty composer. The runs above redo each one on the final code.

## Known edge, not fixed

A SIGTERM to a run while `device.sh up` is still booting runs the cleanup. `device.sh` then restarts an adb server on 5171 that keeps holding the heavy lock until killed. Seen once, in a run I stopped by hand (measured). I killed my own adb server on 5171 by hand. No fix here because the normal exits all clean (see above). Poteto decides whether it needs one.

## Not verified

- The Not sent plus Offline line classification on a device (unit test only).
- Rig route (`HBOTS_VERIFY_DEVICE=rig`), not touched in round 3.
- The skill's own `build-apk.sh`, not re-run. The round 2 APK was reused.
