---
name: verify-hbots-android
description: "Installs an x86_64 hbots APK on a throwaway Android emulator, pairs it with a throwaway server and a fake Claude bot, and drives nine daily-use flows the way a thumb does: chat send and reply, swipe-to-quote, long-press then Reply, one camera entry, three photos at once, work card for unread questions only, in-app versus push, open and back with a clean logcat. Run it before every phone release and before committing changes to the chat screen, composer, attachments, Work view, presence or push code. Does not cover a real arm64 phone, FCM, voice, Settings, Team, Files content or light mode."
---

# Verify hbots Android

Surface: the hbots Android app (`apps/hbots-mobile`). One command installs an APK on a throwaway emulator, pairs it to a throwaway server, drives the flows in `features/`, and prints PASS or FAIL per flow with screenshots and logs.

```bash
env -u NODE_ENV bash apps/hbots-mobile/.claude/skills/verify-hbots-android/scripts/verify.sh <x86_64.apk> [label] [--only 1,2]
```

Exit 0 is every flow PASS. Exit 1 is a failed flow. Exit 2 is a setup, device or doctor failure. The script re-runs itself under `tools/heavy-job.sh`, so a slot wait is possible. After the run it checks that its own heavy slot is released and prints that, and the last line reports `RESULT PASS|FAIL|SETUP-FAIL in <total>s total, <queue>s waiting for a heavy-job slot, <work>s of work`. Judge speed by the work number. A slot still held by this run's own processes after the run turns the exit into 2.

`HBOTS_VERIFY_DEVICE=laptop` forces the laptop emulator and skips the gaming PC rig. Leave it unset to try the rig first. `HBOTS_VERIFY_EVIDENCE=<dir>` moves the evidence folder (see Evidence). `VERIFY_ADB_PORT`, `VERIFY_EMU_PORT`, `VERIFY_AVD`, `VERIFY_SERVER_PORT` and `VERIFY_RELEASE` change ports, AVD and the staged server release.

From a bot session that stops long commands, run it detached and read the exit file:

```bash
systemd-run --user --unit=pstack-hbots-verify-wrap-$(date +%s) --collect --working-directory="$PWD" bash -c 'env -u NODE_ENV bash apps/hbots-mobile/.claude/skills/verify-hbots-android/scripts/verify.sh /path/app.apk label > /path/out.txt 2>&1; echo $? > /path/out.exit'
```

## Never

- Never run against `~/.personal-bots/dev` or port 38472. `env.sh` refuses port 38472 and any checkout, scratch, evidence, temp, state or log folder inside `~/.personal-bots/dev` (exit 2). `doctor.sh` checks the same and `srv.mjs` refuses a data dir there.
- Never use the release signing key. `build-apk.sh` makes a throwaway key and `doctor.sh` rejects an APK signed with the release cert (run against the live release APK, it fails with `apk is signed with the RELEASE key`).
- Never press Redeem. No flow reaches it.
- Never put a pairing link, token or key in a log. The driver types the link into the app and does not print it. The dump and logcat saved on a failed pairing have the link and `token=` values blanked first.
- Never restart or deploy personal-bots. The throwaway server reads the staged release folder read only.

## What this proves and what it does not

It proves the client app at phone size against the real server code, with a fake Claude CLI standing in for the model. Each flow asserts text the user sees and requires the node to be drawn on screen. Where the screen draws only an icon or an image, the flow reads the content description of a drawn node instead: the composer buttons (flow 3) and the photo previews and sent thumbnails (flow 2). The photos flow also compares sha256 of the three files the bot received with the three fixtures. The camera flow checks that the composer row holds a closed set of controls. Flows 5 and 6 read the server log for the in-app or push decision, which the screen does not show, and assert the visible half on the screen: the working card and its clearing, the reply preview on the bot's row.

Not proven: a real arm64 phone, FCM push, the camera itself, voice, reconnect windows, Settings, Team, Files content, light mode, predictive back. The server binary is the staged release, not built from the checkout, so a server change in the same commit is not tested here.

## Build an APK

Release APKs are arm64 only and crash on the x86_64 emulator, so build the same commit for x86_64:

```bash
env -u NODE_ENV HEAVY_JOB_MEMORY_MAX=7G HEAVY_JOB_SWAP_MAX=8G bash /home/harout/Claude/AI/dev-team/tools/heavy-job.sh --label "builder: hbots apk" --work-dir "$PWD" -- bash apps/hbots-mobile/.claude/skills/verify-hbots-android/scripts/build-apk.sh /path/out.apk
```

It signs with a throwaway key, builds x86_64 only, and prints the sha, commit and version. Expect 10 to 20 minutes and several GB of memory. The two caps lift the heavy-job limits (6G memory, 4G swap) that killed the first build. systemd-oomd killed one build under memory pressure anyway, so run it when the gate is quiet. The exit code of the build is the only signal, read it.

## Launch

`verify.sh` does this in order. Each step can be run alone.

1. `doctor.sh --pre <apk>`. No release armed, port free, no folder inside `~/.personal-bots/dev`, release binary present, fake Claude has `LATEQ`, adb, emulator, python3 and node present, no `.env` in the checkout, APK is x86_64 and signed by a throwaway key (an unreadable signer fails too), the adb and emulator ports free.
2. `device.sh up`. The gaming PC rig first (`rig.sh free`, then `up FindX9Pro-Rig`, each retried up to 5 times, 4 s apart, when the PC answers "PC unreachable"). The rig session is owned by the run's own process, so it lives until cleanup, and `device.sh down` releases it. If the rig is not free, or `HBOTS_VERIFY_DEVICE=laptop`, the laptop emulator `FindX9Pro-QA` on its own adb server (port 5171) and emulator port 5672, headless, 1080 x 2355 at 480 dpi (360 x 785 CSS px, DPR 3), dark, animations off.
3. `srv.mjs start`. A throwaway server on port 34671 with an empty data dir, the fake Claude CLI from `scripts/personal/testing/fake-claude`, and four seeded bots.
4. `tunnel.sh up`. A cloudflared quick tunnel as the user unit `pstack-hbots-verify-tunnel-<run id>`, because the app only pairs over https. It reports `up` only after the public URL answers the server's `/.well-known/t3/environment` with http 200, first with the name resolved through 1.1.1.1 and then through this machine's resolver, which the emulator is expected to share (inferred). The URL goes to the run's state file and is never printed.
5. `drive.py`. Installs the APK, pairs, and drives the flows. Pairing makes up to 3 attempts, each with a fresh link and a freshly started app, 40 s each. A failed attempt saves `pair-fail-<n>-dump.xml`, `pair-fail-<n>-logcat.txt` and a screenshot (the pairing screen draws black, the dump has its text). A setup failure saves `setup-fail-dump.xml` and `setup-fail-logcat.txt` before exit 2.

Each run keeps its own state file, logs and tunnel unit inside its evidence folder, so a second run (even one that fails at doctor) cannot stop what another run started. Two runs at once still cannot share the fixed ports, and the second one stops at doctor.

Fake bot triggers: `LONGMSG` (1009 character report), `CHOICES` (a choices question at once), `SLOW<n>` (a reply after n seconds), `LATEQ<n>` (a choices question n seconds later, to land after the user left). Any other text gets `Got it.` plus the quote it received.

## Drive

`drive.py` runs the flows in order: 1, 7, 9, 3, 2, seed, 5, 4, 6, 8. Each flow has its own file in `features/`. To run a subset use `--only 1,7`. Flow 4 needs the seed. Flow 8 needs the seed too, for the two questions it looks for.

`ui.py` reads a `uiautomator dump` in one adb round trip (about 2 s on the laptop). Handles that never move are cached. Waiting for the bot to receive a message polls the fake Claude log, and waiting for the in-app or push path polls the server log. Every other wait polls `uiautomator dump` (a sleep of 0.35 s plus the dump, so about 2.4 s per poll).

## Evidence

`<evidence>/<label>-<UTC stamp>/` holds `run.log`, `results.tsv`, `drive.json` (seconds per flow), `shots/`, `logcat.txt`, `server.log`, `fake-claude.log`, `tunnel.log`, `tunnel-probe.log`, `emulator.log` or `rig-up.log`, `state.env`, `f4-work-texts.txt`, `f5-paths.txt`, `f6-paths.txt`, any `pair-fail-*` and `setup-fail-*` files, and the server data dir. The default is `.scratch/evidence/` in the worktree, which dies with `git worktree remove`. For proof that must last, set `HBOTS_VERIFY_EVIDENCE=/home/harout/Claude/AI/dev-team/qa/<task>/` so the folder lands outside the worktree. Cleanup never deletes evidence.

## Cleanup

`cleanup.sh` runs from a trap. It reads this run's own state file and stops the server by recorded PID, uninstalls the app, stops the one tunnel unit this run recorded, stops the emulator by recorded PID or runs `rig.sh down`, runs `adb kill-server` on port 5171, and prints the listener count, any tunnel units still active (other runs' are left alone), and the heavy slot this run held. After the run `verify.sh` looks up the slot's lock in `lslocks` and prints `released` only when no process of this run holds it. Check `lslocks | grep omarchy-heavy`, `systemctl --user list-units 'pstack-hbots-verify-tunnel-*'` and the ports if a run was killed from outside.

## Proof standards

- A PASS needs the visible text on screen. A content description is used only where the screen draws no text (see What this proves).
- Every flow sends its own trigger text. The two presence flows also use different bots (flow 5 `Developer` with `SLOW6`, flow 6 `Researcher` with `SLOW7`) and each asserts text on its own bot, so one cannot pass on the other's data. Flows 1, 7, 9, 2 and 5 share the `Developer` chat with different triggers.
- A FAIL keeps a `f<N>-fail` screenshot in `shots/` and the failing assertion in `run.log`.
- When you change a flow, plant a break in the app, build, and confirm the flow goes red. Revert the plant with `git apply -R`. The plant must sit on the path the flow drives: a break in the long-press menu escapes the swipe flow 7 and is caught by flow 9.

## Gotchas

- `KEYCODE_ESCAPE` closes the keyboard. `KEYCODE_BACK` closes it first, so the system Back test presses Back twice.
- A dump lists nodes hidden behind an open sheet. Read the composer row before the sheet opens.
- The photo picker renames files, so match on sha256.
- A web push recipient must be bound to a live auth session or the server logs no `push` line.
- A question card needs the reply to land after the user left the chat. That is why `LATEQ` exists.
- A stray `adb -P 5091` call while the rig is down starts a local adb server and the next `rig.sh up` fails. Stop it with `adb -P 5091 kill-server`.
- The rig yields under memory pressure on the PC and shows as exit 2, not a flow FAIL. Rerun.
- The PC's sshd refuses a share of new connections with "Exceeded MaxStartups" (5 of 14 measured on 18 Nov), which `rig.sh` prints as "PC unreachable". `device.sh` retries that answer. If all 5 attempts fail the run falls back to the laptop and says so in `device: mode=laptop (...)`.
- A rig run still takes a heavy-job slot, though the rig does no work on the laptop. The handbook says a rig run needs none. Open.
- A brand new tunnel name looked up too early is cached as NXDOMAIN by `systemd-resolved` for about 60 s (measured in two runs of this skill's own probe). The emulator most likely uses the same cache (inferred). `tunnel.sh` therefore asks 1.1.1.1 over https first and only then this machine's resolver.
- `systemd-oomd` can kill a build or an emulator under memory pressure on the laptop. A kill is exit 137.
