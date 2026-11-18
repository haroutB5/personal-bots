---
name: verify-hbots-android
description: "Installs an x86_64 hbots APK on a throwaway Android emulator, pairs it with a throwaway server and a fake Claude bot, and drives eight daily-use flows the way a thumb does: chat send and reply, swipe-to-quote, one camera entry, three photos at once, work card for unread questions only, in-app versus push, open and back with a clean logcat. Run it before every phone release and before committing changes to the chat screen, composer, attachments, Work view, presence or push code. Does not cover a real arm64 phone, FCM, voice, Settings, Team, Files content or light mode."
---

# Verify hbots Android

Surface: the hbots Android app (`apps/hbots-mobile`). One command installs an APK on a throwaway emulator, pairs it to a throwaway server, drives the flows in `features/`, and prints PASS or FAIL per flow with screenshots and logs.

```bash
env -u NODE_ENV bash apps/hbots-mobile/.claude/skills/verify-hbots-android/scripts/verify.sh <x86_64.apk> [label] [--only 1,2]
```

Exit 0 is every flow PASS. Exit 1 is a failed flow. Exit 2 is a setup, device or doctor failure. The script re-runs itself under `tools/heavy-job.sh`, so a slot wait is possible. The last line reports `RESULT PASS|FAIL|SETUP-FAIL in <total>s total, <queue>s waiting for a heavy-job slot, <work>s of work`. Judge speed by the work number.

From a bot session that stops long commands, run it detached and read the exit file:

```bash
systemd-run --user --unit=pstack-hbots-verify --collect --working-directory="$PWD" bash -c 'env -u NODE_ENV bash apps/hbots-mobile/.claude/skills/verify-hbots-android/scripts/verify.sh /path/app.apk label > /path/out.txt 2>&1; echo $? > /path/out.exit'
```

## Never

- Never run against `~/.personal-bots/dev` or port 38472. `env.sh` and `doctor.sh` refuse both.
- Never use the release signing key. `build-apk.sh` makes a throwaway key and `doctor.sh` rejects an APK signed with the release cert.
- Never press Redeem. No flow reaches it.
- Never put a pairing link, token or key in a log. The driver types the link into the app and does not print it.
- Never restart or deploy personal-bots. The throwaway server reads the staged release folder read only.

## What this proves and what it does not

It proves the client app at phone size against the real server code, with a fake Claude CLI standing in for the model. Each flow asserts the text the user sees and requires the node to be drawn on screen. The photos flow compares sha256 of the three files the bot received with the three fixtures. The camera flow checks that the composer row holds a closed set of controls.

Not proven: a real arm64 phone, FCM push, the camera itself, voice, reconnect windows, Settings, Team, Files content, light mode, predictive back. The server binary is the staged release, not built from the checkout, so a server change in the same commit is not tested here.

## Build an APK

Release APKs are arm64 only and crash on the x86_64 emulator, so build the same commit for x86_64:

```bash
env -u NODE_ENV bash /home/harout/Claude/AI/dev-team/tools/heavy-job.sh --label "builder: hbots apk" --work-dir "$PWD" -- bash apps/hbots-mobile/.claude/skills/verify-hbots-android/scripts/build-apk.sh /path/out.apk
```

It signs with a throwaway key, builds x86_64 only, and prints the sha, commit and version. Expect 10 to 20 minutes and several GB of memory. systemd-oomd killed one build under memory pressure, so run it when the gate is quiet. The exit code of the build is the only signal, read it.

## Launch

`verify.sh` does this in order. Each step can be run alone.

1. `doctor.sh --pre <apk>`. No release armed, port free, release binary present, fake Claude has `LATEQ`, adb, emulator, python3 and node present, no `.env` in the checkout, APK is x86_64 and not release signed, nothing left from a previous run.
2. `device.sh up`. The gaming PC rig first (`rig.sh free`, then `up FindX9Pro-Rig`). If it is not free, the laptop emulator `FindX9Pro-QA` on its own adb server (port 5171) and emulator port 5672, headless, 1080 x 2355 at 480 dpi (360 x 785 CSS px, DPR 3), dark, animations off.
3. `srv.mjs start`. A throwaway server on port 34671 with an empty data dir, the fake Claude CLI from `scripts/personal/testing/fake-claude`, and four seeded bots.
4. `tunnel.sh up`. A cloudflared quick tunnel, because the app only pairs over https. The URL goes to `state.env` and is never printed.
5. `drive.py`. Installs the APK, pairs, and drives the flows.

Fake bot triggers: `LONGMSG` (1009 character report), `CHOICES` (a choices question at once), `SLOW<n>` (a reply after n seconds), `LATEQ<n>` (a choices question n seconds later, to land after the user left).

## Drive

`drive.py` runs the flows in order: 1, 7, 3, 2, seed, 5, 4, 6, 8. Each flow has its own file in `features/`. To run a subset use `--only 1,7`. Flow 4 needs the seed and flow 5 first.

`ui.py` reads a `uiautomator dump` in one adb round trip (about 2 s on the laptop). Handles that never move are cached. Waits poll the fake Claude log or the server log, not the screen.

## Evidence

`<evidence>/<label>-<UTC stamp>/` holds `run.log`, `results.tsv`, `drive.json` (seconds per flow), `shots/`, `logcat.txt`, `server.log`, `fake-claude.log`, `f4-work-texts.txt`, `f5-paths.txt`, `f6-paths.txt` and the server data dir. The default is `.scratch/evidence/` in the worktree, which dies with `git worktree remove`. For proof that must last, set `HBOTS_VERIFY_EVIDENCE=/home/harout/Claude/AI/dev-team/qa/<task>/` so the folder lands outside the worktree. Cleanup never deletes evidence.

## Cleanup

`cleanup.sh` runs from a trap. It stops the server by recorded PID, uninstalls the app, takes the tunnel down, stops the emulator by recorded PID, runs `adb kill-server` on port 5171, and prints listener and heavy-slot proof. Check `lslocks | grep omarchy-heavy` and the ports if a run was killed from outside.

## Proof standards

- A PASS needs the visible text on screen, not a content description or a resource id alone.
- Every case has its own fixture, so one case cannot pass on another's data.
- A FAIL keeps a `f<N>-fail` screenshot in `shots/` and the failing assertion in `run.log`.
- When you change a flow, plant a break in the app, build, and confirm the flow goes red. Revert the plant with `git apply -R`.

## Gotchas

- `KEYCODE_ESCAPE` closes the keyboard. `KEYCODE_BACK` closes it first, so the system Back test presses Back twice.
- A dump lists nodes hidden behind an open sheet. Read the composer row before the sheet opens.
- The photo picker renames files, so match on sha256.
- A web push recipient must be bound to a live auth session or the server logs no `push` line.
- A question card needs the reply to land after the user left the chat. That is why `LATEQ` exists.
- A stray `adb -P 5091` call while the rig is down starts a local adb server and the next `rig.sh up` fails. Stop it with `adb -P 5091 kill-server`.
- The rig yields under memory pressure on the PC and shows as exit 2, not a flow FAIL. Rerun.
- `systemd-oomd` can kill a build or an emulator under memory pressure on the laptop. A kill is exit 137.
